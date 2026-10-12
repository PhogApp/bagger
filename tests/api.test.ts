import { eq } from "drizzle-orm";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { resolveActor } from "../server/auth/actor";
import type { Ctx, Db } from "../server/db/types";
import { createApp } from "../server/http/app";
import * as s from "../shared/schema";
import { addMember, createOrg, createTestDb } from "./helpers";

let db: Db;
let app: ReturnType<typeof createApp>;
let admin: Ctx;
let manager: Ctx;
let rep: Ctx;
let rep2: Ctx;
let viewer: Ctx;
let outsider: Ctx; // admin of a different organization

beforeAll(async () => {
  db = await createTestDb();
  // Stand-in for Clerk: the test says who it is in two headers.
  app = createApp(db, async (req) => {
    const userId = req.header("x-user");
    const orgId = req.header("x-org");
    return userId && orgId ? resolveActor(db, { userId, orgId }) : null;
  });
  // Calendar-day mode, so "enroll now, see it in the queue now" holds on every
  // day of the week. In business-day mode a step enrolled on a Saturday is due
  // Monday, which made these tests fail when run on a weekend. That weekend
  // rule has its own test below, with the clock pinned.
  admin = await createOrg(db, { waitDayMode: "calendar" });
  manager = await addMember(db, admin.orgId, "manager", "Mia Manager");
  rep = await addMember(db, admin.orgId, "rep", "Ray Rep");
  rep2 = await addMember(db, admin.orgId, "rep", "Rita Rep");
  viewer = await addMember(db, admin.orgId, "read_only", "Vic Viewer");
  outsider = await createOrg(db);
});

const as = (who: Ctx) => ({
  get: (url: string) => request(app).get(url).set("x-user", who.userId).set("x-org", who.orgId),
  post: (url: string, body?: object) =>
    request(app).post(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
  patch: (url: string, body: object) =>
    request(app).patch(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
  put: (url: string, body: object) =>
    request(app).put(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
  del: (url: string) =>
    request(app).delete(url).set("x-user", who.userId).set("x-org", who.orgId),
});

let n = 0;
const newLead = (extra: object = {}) => ({
  firstName: "Jill",
  lastName: `Rude${++n}`,
  email: `Jill${n}@Redfield.example`,
  company: "Redfield Energy",
  ...extra,
});

describe("signing in", () => {
  it("rejects requests with no identity", async () => {
    expect((await request(app).get("/api/leads")).status).toBe(401);
  });
  it("rejects a user who is not a member of the organization they name", async () => {
    const res = await request(app)
      .get("/api/leads")
      .set("x-user", outsider.userId)
      .set("x-org", admin.orgId);
    expect(res.status).toBe(401);
  });
  it("tells the app who the user is and what they may do", async () => {
    const res = await as(rep).get("/api/me");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("Rep");
    expect(res.body.permissions["leads.delete"]).toBe("none");
    expect(res.body.user.name).toBe("Ray Rep");
  });
});

describe("leads", () => {
  it("creates a lead owned by the creator, with a tidy email", async () => {
    const res = await as(rep).post("/api/leads", newLead({ title: "  CFO " }));
    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe(rep.userId);
    expect(res.body.email).toMatch(/^jill\d+@redfield\.example$/);
    expect(res.body.title).toBe("CFO");
    expect(res.body.status).toBe("New");
  });

  it("rejects bad input with a 400", async () => {
    const res = await as(rep).post("/api/leads", { firstName: "", email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("lets a rep edit another rep's lead and records who changed what", async () => {
    const lead = (await as(rep).post("/api/leads", newLead({ title: "CFO" }))).body;
    const res = await as(rep2).patch(`/api/leads/${lead.id}`, { title: "CEO", notes: "Promoted" });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("CEO");

    const history = (await as(rep).get(`/api/history/lead/${lead.id}`)).body;
    const title = history.find((h: { field: string }) => h.field === "title");
    expect(title).toMatchObject({
      action: "update",
      oldValue: "CFO",
      newValue: "CEO",
      userId: rep2.userId,
      userName: "Rita Rep",
    });
    expect(title.at).toBeTruthy();
    expect(history.some((h: { action: string }) => h.action === "create")).toBe(true);
  });

  it("writes no history when nothing actually changed", async () => {
    const lead = (await as(rep).post("/api/leads", newLead({ title: "CFO" }))).body;
    await as(rep).patch(`/api/leads/${lead.id}`, { title: "CFO" });
    const history = (await as(rep).get(`/api/history/lead/${lead.id}`)).body;
    expect(history.filter((h: { action: string }) => h.action === "update")).toHaveLength(0);
  });

  it("stops a rep deleting, lets a manager, and keeps the history afterwards", async () => {
    const lead = (await as(rep).post("/api/leads", newLead())).body;
    expect((await as(rep).del(`/api/leads/${lead.id}`)).status).toBe(403);
    expect((await as(manager).del(`/api/leads/${lead.id}`)).status).toBe(204);
    expect((await as(rep).get(`/api/leads/${lead.id}`)).status).toBe(404);
    const history = (await as(manager).get(`/api/history/lead/${lead.id}`)).body;
    expect(history.some((h: { action: string }) => h.action === "delete")).toBe(true);
  });

  it("keeps a read-only user from creating or editing", async () => {
    const lead = (await as(rep).post("/api/leads", newLead())).body;
    expect((await as(viewer).post("/api/leads", newLead())).status).toBe(403);
    expect((await as(viewer).patch(`/api/leads/${lead.id}`, { title: "X" })).status).toBe(403);
    expect((await as(viewer).get(`/api/leads/${lead.id}`)).status).toBe(200);
  });

  it("searches by name, company, or email", async () => {
    await as(rep).post("/api/leads", newLead({ lastName: "Zebrowski", company: "Quartzite Co" }));
    const byName = await as(rep2).get("/api/leads?q=zebrow");
    expect(byName.body.map((l: { lastName: string }) => l.lastName)).toEqual(["Zebrowski"]);
    const byCompany = await as(rep2).get("/api/leads?q=quartzite");
    expect(byCompany.body).toHaveLength(1);
    expect((await as(rep2).get("/api/leads?q=100%25")).body).toHaveLength(0);
  });

  it("refuses an owner from outside the organization", async () => {
    const res = await as(rep).post("/api/leads", newLead({ ownerId: outsider.userId }));
    expect(res.status).toBe(400);
  });
});

describe("importing from a CSV file", () => {
  it("imports good leads, skips duplicates, and reports bad rows by number", async () => {
    await as(rep).post("/api/leads", newLead({ email: "already@here.example" }));
    const rows = [
      { firstName: "Ann", lastName: "One", email: "Ann.One@Import.example", company: "Acme" },
      { firstName: "Bob", lastName: "Two", email: "not-an-email" },
      { firstName: "Cat", lastName: "Three", email: "already@here.example" },
      { firstName: "Dan", lastName: "Four", email: "ann.one@import.example" }, // same as row 1
      { firstName: "", lastName: "Five", email: "eve@import.example" },
      { firstName: "Fay", lastName: "Six", email: "fay@import.example", title: "  ", cellPhone: "" },
    ];

    // Checking first saves nothing and says what would happen.
    const check = await as(rep).post("/api/import/leads", { rows, mode: "check" });
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({
      total: 6,
      created: 2,
      updated: 0,
      duplicates: [{ row: 3, label: "already@here.example" }],
      repeats: [{ row: 4, label: "ann.one@import.example" }],
    });
    expect((await as(rep).get("/api/leads?q=import.example")).body).toHaveLength(0);

    const res = await as(rep).post("/api/import/leads", { rows, mode: "skip" });
    expect(res.body).toMatchObject({ created: 2, updated: 0 });
    expect(res.body.duplicates).toEqual(check.body.duplicates);
    expect(res.body.errors.map((e: { row: number }) => e.row)).toEqual([2, 5]);
    expect(res.body.errors[0].message).toMatch(/^Email: /);
    expect(res.body.errors[1].message).toBe("First name is missing");

    const found = (await as(rep).get("/api/leads?q=import.example")).body;
    expect(found.map((l: { firstName: string }) => l.firstName).sort()).toEqual(["Ann", "Fay"]);
    const ann = found.find((l: { firstName: string }) => l.firstName === "Ann");
    expect(ann).toMatchObject({ ownerId: rep.userId, company: "Acme", status: "New" });
    const history = (await as(rep).get(`/api/history/lead/${ann.id}`)).body;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ action: "create", source: "import", userId: rep.userId });

    // Importing the same file again creates nothing.
    const again = await as(rep).post("/api/import/leads", { rows: [rows[0]] });
    expect(again.body).toMatchObject({ created: 0, duplicates: [{ row: 1 }] });
  });

  it("overwrites existing leads only when asked, and never blanks a field", async () => {
    const lead = (
      await as(rep).post(
        "/api/leads",
        newLead({ email: "keep@update.example", title: "Buyer", cellPhone: "555-0100" }),
      )
    ).body;
    await as(admin).patch(`/api/leads/${lead.id}`, { status: "Prospecting" });
    const rows = [
      { firstName: "Jill", lastName: "Renamed", email: "KEEP@update.example", title: "CFO", cellPhone: "", status: "New" },
      { firstName: "New", lastName: "Person", email: "new@update.example" },
    ];
    const res = await as(rep2).post("/api/import/leads", { rows, mode: "update" });
    expect(res.body).toMatchObject({ created: 1, updated: 1, duplicates: [{ row: 1 }], errors: [] });

    const after = (await as(rep).get(`/api/leads/${lead.id}`)).body;
    expect(after).toMatchObject({
      lastName: "Renamed",
      title: "CFO",
      cellPhone: "555-0100", // blank in the file, so left alone
      status: "Prospecting", // the file never changes status
      ownerId: rep.userId, // or the owner
    });
    const history = (await as(rep).get(`/api/history/lead/${lead.id}`)).body;
    const fromImport = history.filter((h: { source: string }) => h.source === "import");
    expect(fromImport.map((h: { field: string }) => h.field).sort()).toEqual(["lastName", "title"]);
    expect(fromImport.find((h: { field: string }) => h.field === "title")).toMatchObject({
      oldValue: "Buyer",
      newValue: "CFO",
      userId: rep2.userId,
    });

    // The same file again changes nothing.
    const again = await as(rep2).post("/api/import/leads", { rows, mode: "update" });
    expect(again.body).toMatchObject({ created: 0, updated: 0 });
  });

  it("matches accounts by name or by website", async () => {
    await as(rep).post("/api/accounts", { name: "Halvorsen Freight", website: "www.halvorsen.example" });
    const rows = [
      { name: "  halvorsen  FREIGHT " }, // same name, different case and spacing
      { name: "Halvorsen Logistics", website: "https://halvorsen.example/about", hqPhone: "555-0142" }, // same site
      { name: "Northwind Parts", website: "northwind.example" },
      { name: "Northwind Parts Inc", website: "www.northwind.example" }, // repeats row 3's site
      { website: "nameless.example" },
    ];
    const check = await as(rep).post("/api/import/accounts", { rows, mode: "check" });
    expect(check.body).toMatchObject({
      created: 1,
      duplicates: [{ row: 1 }, { row: 2, label: "Halvorsen Logistics" }],
      repeats: [{ row: 4 }],
      errors: [{ row: 5, message: "Name is missing" }],
    });

    const res = await as(rep).post("/api/import/accounts", { rows, mode: "update" });
    expect(res.body).toMatchObject({ created: 1, updated: 2 });
    const halvorsen = (await as(rep).get("/api/accounts?q=halvorsen")).body;
    expect(halvorsen).toHaveLength(1);
    expect(halvorsen[0]).toMatchObject({ name: "Halvorsen Logistics", hqPhone: "555-0142" });
    const northwind = (await as(rep).get("/api/accounts?q=northwind")).body;
    expect(northwind).toHaveLength(1);
    expect(northwind[0].website).toBe("https://northwind.example");
  });

  it("puts imported contacts on the right account, creating it when needed", async () => {
    const existing = (
      await as(rep).post("/api/accounts", { name: "Tidewater Supply", website: "tidewater.example" })
    ).body;
    const rows = [
      { firstName: "Una", lastName: "A", email: "una@tidewater.example", accountName: "tidewater supply" },
      { firstName: "Vic", lastName: "B", email: "vic@tidewater.example", accountName: "Tidewater", accountWebsite: "www.tidewater.example" },
      { firstName: "Wes", lastName: "C", email: "wes@brandnew.example", accountName: "Brand New Co", accountWebsite: "brandnew.example" },
      { firstName: "Xia", lastName: "D", email: "xia@brandnew.example", accountName: "Brand New Co" },
      { firstName: "Yan", lastName: "E", email: "yan@nowhere.example" },
    ];
    const check = await as(rep).post("/api/import/contacts", { rows, mode: "check" });
    expect(check.body).toMatchObject({ created: 4, newAccounts: 1 });
    expect(check.body.errors).toEqual([{ row: 5, message: "Account name is missing" }]);
    expect((await as(rep).get("/api/accounts?q=brand new")).body).toHaveLength(0);

    const res = await as(rep).post("/api/import/contacts", { rows });
    expect(res.body).toMatchObject({ created: 4, newAccounts: 1, duplicates: [] });
    const created = (await as(rep).get("/api/accounts?q=brand new")).body;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ website: "https://brandnew.example", ownerId: rep.userId });
    const people = (await as(rep).get("/api/contacts?q=.example&limit=500")).body;
    const accountOf = (email: string) =>
      people.find((c: { email: string }) => c.email === email).accountId;
    expect(accountOf("una@tidewater.example")).toBe(existing.id);
    expect(accountOf("vic@tidewater.example")).toBe(existing.id);
    expect(accountOf("wes@brandnew.example")).toBe(created[0].id);
    expect(accountOf("xia@brandnew.example")).toBe(created[0].id);

    // An existing contact is a duplicate, and updating it does not move it.
    const moved = await as(rep).post("/api/import/contacts", {
      rows: [{ ...rows[0], title: "Buyer", accountName: "Brand New Co" }],
      mode: "update",
    });
    expect(moved.body).toMatchObject({ created: 0, updated: 1, newAccounts: 0 });
    const una = (await as(rep).get("/api/contacts?q=una@tidewater")).body[0];
    expect(una).toMatchObject({ title: "Buyer", accountId: existing.id });
  });

  it("handles a large file and keeps organizations apart", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      firstName: "Bulk",
      lastName: `Lead${i}`,
      email: `bulk${i}@big.example`,
    }));
    const res = await as(manager).post("/api/import/leads", { rows, ownerId: rep2.userId });
    expect(res.body).toMatchObject({ created: 1200, duplicates: [], errors: [] });
    const mine = (await as(rep2).get("/api/leads?q=big.example&limit=5")).body;
    expect(mine[0].ownerId).toBe(rep2.userId);
    // The same emails are not duplicates in a different organization.
    const other = await as(outsider).post("/api/import/leads", { rows: rows.slice(0, 3) });
    expect(other.body.created).toBe(3);
  });

  it("is refused for a read-only user, and for an owner outside the organization", async () => {
    const rows = [{ firstName: "X", lastName: "Y", email: "xy@denied.example" }];
    for (const kind of ["leads", "contacts", "accounts"]) {
      expect((await as(viewer).post(`/api/import/${kind}`, { rows, mode: "check" })).status).toBe(403);
    }
    const badOwner = await as(rep).post("/api/import/leads", { rows, ownerId: outsider.userId });
    expect(badOwner.status).toBe(400);
    expect((await as(rep).post("/api/import/leads", { rows: [] })).status).toBe(400);
    expect((await as(rep).post("/api/import/templates", { rows })).status).toBe(404);
  });
});

describe("accounts and contacts", () => {
  it("requires a contact to belong to an account in the same organization", async () => {
    const account = (await as(rep).post("/api/accounts", { name: "Phog, Inc." })).body;
    const base = { firstName: "Dan", lastName: "Smith", email: "dan@phog.example" };
    expect((await as(rep).post("/api/contacts", base)).status).toBe(400);
    const foreign = (await as(outsider).post("/api/accounts", { name: "Elsewhere" })).body;
    const cross = await as(rep).post("/api/contacts", { ...base, accountId: foreign.id });
    expect(cross.status).toBe(400);
    const ok = await as(rep).post("/api/contacts", { ...base, accountId: account.id });
    expect(ok.status).toBe(201);
  });

  it("accepts a web address typed without https://", async () => {
    const account = await as(rep).post("/api/accounts", {
      name: "Dan's Auto",
      website: "www.dansauto.com",
      linkedin: "linkedin.com/company/dans-auto",
    });
    expect(account.status).toBe(201);
    expect(account.body.website).toBe("https://www.dansauto.com");
    expect(account.body.linkedin).toBe("https://linkedin.com/company/dans-auto");

    const kept = await as(rep).patch(`/api/accounts/${account.body.id}`, {
      website: "http://dansauto.com",
    });
    expect(kept.body.website).toBe("http://dansauto.com");
    const cleared = await as(rep).patch(`/api/accounts/${account.body.id}`, { website: "" });
    expect(cleared.body.website).toBeNull();
  });

  it("lists the contacts and opportunities on one account", async () => {
    const one = (await as(rep).post("/api/accounts", { name: "Related One" })).body;
    const two = (await as(rep).post("/api/accounts", { name: "Related Two" })).body;
    const person = (email: string, accountId: string) => ({ firstName: "Rae", lastName: "Lated", email, accountId });
    await as(rep).post("/api/contacts", person("a@related.example", one.id));
    await as(rep).post("/api/contacts", person("b@related.example", one.id));
    await as(rep).post("/api/contacts", person("c@related.example", two.id));
    await as(rep).post("/api/opportunities", { name: "Related deal", accountId: two.id });

    const contactsOfOne = (await as(rep2).get(`/api/contacts?accountId=${one.id}`)).body;
    expect(contactsOfOne.map((c: { email: string }) => c.email).sort()).toEqual([
      "a@related.example",
      "b@related.example",
    ]);
    expect((await as(rep2).get(`/api/opportunities?accountId=${one.id}`)).body).toHaveLength(0);
    const deals = (await as(rep2).get(`/api/opportunities?accountId=${two.id}`)).body;
    expect(deals.map((o: { name: string }) => o.name)).toEqual(["Related deal"]);
    // Another organization gets nothing, and leads have no account to filter by.
    expect((await as(outsider).get(`/api/contacts?accountId=${one.id}`)).body).toHaveLength(0);
    expect((await as(rep).get(`/api/leads?accountId=${one.id}`)).status).toBe(400);
    expect((await as(rep).get("/api/contacts?accountId=nope")).status).toBe(400);
  });

  it("will not delete an account that still has contacts", async () => {
    const account = (await as(manager).post("/api/accounts", { name: "Has Contacts" })).body;
    await as(manager).post("/api/contacts", {
      firstName: "A",
      lastName: "B",
      email: "ab@example.com",
      accountId: account.id,
    });
    expect((await as(manager).del(`/api/accounts/${account.id}`)).status).toBe(400);
    expect((await as(manager).get(`/api/accounts/${account.id}`)).status).toBe(200);
  });
});

describe("flagging duplicates when a record is added", () => {
  it("stops a lead whose email is already a lead or a contact, unless told to go ahead", async () => {
    const account = (await as(rep).post("/api/accounts", { name: "Dupe Check Co" })).body;
    await as(rep).post("/api/contacts", {
      firstName: "Cora",
      lastName: "Contact",
      email: "cora@dupecheck.example",
      accountId: account.id,
    });
    const first = await as(rep).post("/api/leads", newLead({ email: "lee@dupecheck.example" }));
    expect(first.status).toBe(201);

    const asContact = await as(rep2).post(
      "/api/leads",
      newLead({ email: "CORA@dupecheck.example" }),
    );
    expect(asContact.status).toBe(409);
    expect(asContact.body).toMatchObject({
      error: "duplicate",
      matches: [{ type: "contact", label: "Cora Contact, Dupe Check Co" }],
    });
    const asLead = await as(rep2).post("/api/leads", newLead({ email: "lee@dupecheck.example" }));
    expect(asLead.status).toBe(409);
    expect(asLead.body.matches[0]).toMatchObject({ type: "lead", id: first.body.id });

    const anyway = await as(rep2).post(
      "/api/leads?allowDuplicate=1",
      newLead({ email: "lee@dupecheck.example" }),
    );
    expect(anyway.status).toBe(201);
    // Another organization's records are never a match.
    const elsewhere = await as(outsider).post(
      "/api/leads",
      newLead({ email: "cora@dupecheck.example" }),
    );
    expect(elsewhere.status).toBe(201);
  });

  it("stops a second contact with the same email, or account with the same name or website", async () => {
    const account = await as(rep).post("/api/accounts", {
      name: "Marlow Tooling",
      website: "marlow.example",
    });
    expect(account.status).toBe(201);
    const sameName = await as(rep).post("/api/accounts", { name: "marlow  tooling" });
    expect(sameName.status).toBe(409);
    const sameSite = await as(rep).post("/api/accounts", {
      name: "Marlow Inc",
      website: "https://www.marlow.example/contact",
    });
    expect(sameSite.body.matches).toEqual([
      { type: "account", id: account.body.id, label: "Marlow Tooling" },
    ]);

    const contact = { firstName: "Max", lastName: "M", email: "max@marlow.example", accountId: account.body.id };
    expect((await as(rep).post("/api/contacts", contact)).status).toBe(201);
    expect((await as(rep).post("/api/contacts", contact)).status).toBe(409);
  });

  it("flags imported leads that are already contacts, and never overwrites the contact", async () => {
    const account = (await as(rep).post("/api/accounts", { name: "Import Dupe Co" })).body;
    const contact = (
      await as(rep).post("/api/contacts", {
        firstName: "Ivy",
        lastName: "Original",
        email: "ivy@importdupe.example",
        accountId: account.id,
      })
    ).body;
    const rows = [
      { firstName: "Ivy", lastName: "Changed", email: "ivy@importdupe.example" },
      { firstName: "Jon", lastName: "New", email: "jon@importdupe.example" },
    ];
    const check = await as(rep).post("/api/import/leads", { rows, mode: "check" });
    expect(check.body).toMatchObject({
      created: 1,
      duplicates: [{ row: 1, label: "ivy@importdupe.example", existing: "contact" }],
    });
    const res = await as(rep).post("/api/import/leads", { rows, mode: "update" });
    expect(res.body).toMatchObject({ created: 1, updated: 0 });
    expect((await as(rep).get(`/api/contacts/${contact.id}`)).body.lastName).toBe("Original");
    expect((await as(rep).get("/api/leads?q=ivy@importdupe")).body).toHaveLength(0);
  });
});

describe("converting a lead to a contact", () => {
  async function sequenceWithTwoSteps(name: string) {
    const sequence = (await as(rep).post("/api/sequences", { name })).body;
    await as(rep).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });
    await as(rep).post(`/api/sequences/${sequence.id}/steps`, { type: "phone_call", title: "Two" });
    return sequence;
  }

  it("keeps the person's sequence, history and details, on a new account", async () => {
    const sequence = await sequenceWithTwoSteps("Convert mid-sequence");
    const lead = (
      await as(rep).post(
        "/api/leads",
        newLead({
          firstName: "Gwen",
          lastName: "Convert",
          email: "gwen@harborline.example",
          company: "Harborline Marine",
          title: "Buyer",
          cellPhone: "555-0177",
        }),
      )
    ).body;
    await as(rep2).patch(`/api/leads/${lead.id}`, { status: "Prospecting" });
    const enrolled = (
      await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: lead.id })
    ).body;
    await as(rep).post(`/api/tasks/${enrolled.task.id}/complete`, {});

    const preview = (await as(rep).get(`/api/leads/${lead.id}/conversion`)).body;
    expect(preview).toMatchObject({
      suggestedAccountName: "Harborline Marine",
      suggestedWebsite: "harborline.example",
      matches: [],
      existingContact: null,
      canCreateAccount: true,
    });

    const res = await as(rep2).post(`/api/leads/${lead.id}/convert`, {
      newAccount: { name: "Harborline Marine", website: "harborline.example" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountCreated: true, enrollments: 1 });

    const contact = (await as(rep).get(`/api/contacts/${res.body.contactId}`)).body;
    expect(contact).toMatchObject({
      firstName: "Gwen",
      lastName: "Convert",
      email: "gwen@harborline.example",
      title: "Buyer",
      cellPhone: "555-0177",
      status: "Prospecting",
      ownerId: rep.userId, // the lead's owner, not whoever converted it
      accountId: res.body.accountId,
    });
    const account = (await as(rep).get(`/api/accounts/${res.body.accountId}`)).body;
    expect(account).toMatchObject({ name: "Harborline Marine", website: "https://harborline.example" });

    // The sequence carries on from step two, now for the contact.
    const due = (await as(rep).get("/api/tasks/due")).body;
    const task = due.find((t: { person: { contactId: string } }) => t.person.contactId === contact.id);
    expect(task).toMatchObject({ step: { title: "Two" }, person: { leadId: null } });
    const people = (await as(rep).get(`/api/sequences/${sequence.id}/enrollments`)).body;
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ contactId: contact.id, leadId: null, state: "active" });
    const done = await as(rep).post(`/api/tasks/${task.taskId}/complete`, {});
    expect(done.status).toBe(200);

    // The lead leaves the list, can't be changed, and can't be enrolled again.
    expect((await as(rep).get("/api/leads?q=harborline")).body).toHaveLength(0);
    expect((await as(rep).patch(`/api/leads/${lead.id}`, { title: "X" })).status).toBe(400);
    expect((await as(rep).post(`/api/leads/${lead.id}/convert`, { accountId: account.id })).status).toBe(400);
    const again = await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: lead.id });
    expect(again.status).toBe(409);

    // The contact's history includes what happened while it was a lead.
    const history = (await as(rep).get(`/api/history/contact/${contact.id}`)).body;
    const fields = history.map((h: { recordType: string; action: string; field: string | null }) =>
      [h.recordType, h.action, h.field].join(":"),
    );
    expect(fields).toEqual(
      expect.arrayContaining([
        "contact:create:",
        "lead:update:convertedContactId",
        "lead:update:status",
        "lead:create:",
      ]),
    );
    const converted = history.find((h: { field: string }) => h.field === "convertedContactId");
    expect(converted).toMatchObject({ newValue: contact.id, userId: rep2.userId });

    // The email is free for the contact only: a new lead with it is flagged.
    const relead = await as(rep).post("/api/leads", newLead({ email: "gwen@harborline.example" }));
    expect(relead.body.matches).toMatchObject([{ type: "contact", id: contact.id }]);
  });

  it("suggests matching accounts and attaches to the one chosen", async () => {
    const byName = (await as(rep).post("/api/accounts", { name: "Kestrel Labs" })).body;
    const bySite = (
      await as(rep).post("/api/accounts", { name: "Kestrel Holdings", website: "kestrel.example" })
    ).body;
    const lead = (
      await as(rep).post(
        "/api/leads",
        newLead({ email: "kim@kestrel.example", company: "kestrel labs" }),
      )
    ).body;
    const preview = (await as(rep).get(`/api/leads/${lead.id}/conversion`)).body;
    expect(preview.matches).toEqual([
      { id: byName.id, name: "Kestrel Labs" },
      { id: bySite.id, name: "Kestrel Holdings" },
    ]);

    // Naming a new account that already exists is refused; so is another organization's account.
    const clash = await as(rep).post(`/api/leads/${lead.id}/convert`, {
      newAccount: { name: "Kestrel Labs" },
    });
    expect(clash.status).toBe(400);
    const foreign = (await as(outsider).post("/api/accounts", { name: "Foreign Co" })).body;
    expect((await as(rep).post(`/api/leads/${lead.id}/convert`, { accountId: foreign.id })).status).toBe(400);
    expect((await as(rep).post(`/api/leads/${lead.id}/convert`, {})).status).toBe(400);
    expect((await as(outsider).post(`/api/leads/${lead.id}/convert`, { accountId: foreign.id })).status).toBe(404);

    const res = await as(rep).post(`/api/leads/${lead.id}/convert`, { accountId: bySite.id });
    expect(res.body).toMatchObject({ accountId: bySite.id, accountCreated: false, enrollments: 0 });
    // A personal email address suggests no website.
    const personal = (await as(rep).post("/api/leads", newLead({ email: "someone@gmail.com", company: "" }))).body;
    const none = (await as(rep).get(`/api/leads/${personal.id}/conversion`)).body;
    expect(none).toMatchObject({ suggestedWebsite: null, matches: [] });
  });

  it("refuses when the email is already a contact, and for a read-only user", async () => {
    const account = (await as(rep).post("/api/accounts", { name: "Already There Co" })).body;
    const lead = (await as(rep).post("/api/leads", newLead({ email: "amy@alreadythere.example" }))).body;
    expect((await as(viewer).post(`/api/leads/${lead.id}/convert`, { accountId: account.id })).status).toBe(403);
    await as(rep).post("/api/contacts", {
      firstName: "Amy",
      lastName: "There",
      email: "amy@alreadythere.example",
      accountId: account.id,
    });
    const preview = (await as(rep).get(`/api/leads/${lead.id}/conversion`)).body;
    expect(preview.existingContact).toBe("Amy There, Already There Co");
    const res = await as(rep).post(`/api/leads/${lead.id}/convert`, { accountId: account.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already a contact/);
  });
});

describe("status lists an organization defines for itself", () => {
  // Their own organization, so renaming and deleting statuses here cannot disturb other tests.
  let boss: Ctx;
  let seller: Ctx;
  let watcher: Ctx;
  type Option = { id: string; object: string; name: string; isDefault: boolean; effect: string; inUse: number };
  const list = async (object: string): Promise<Option[]> =>
    (await as(boss).get("/api/statuses")).body.filter((o: Option) => o.object === object);
  const find = async (object: string, name: string) =>
    (await list(object)).find((o) => o.name === name)!;
  const person = (email: string, extra: object = {}) => ({
    firstName: "Sam",
    lastName: "Status",
    email,
    ...extra,
  });

  beforeAll(async () => {
    boss = await createOrg(db, { waitDayMode: "calendar" });
    seller = await addMember(db, boss.orgId, "rep", "Sal Seller");
    watcher = await addMember(db, boss.orgId, "read_only", "Wes Watcher");
  });

  it("starts every organization with the standard lists", async () => {
    expect((await list("leads")).map((o) => o.name)).toEqual([
      "New",
      "Active",
      "Prospecting",
      "Not Interested",
      "Do Not Contact",
    ]);
    expect((await list("accounts")).find((o) => o.isDefault)?.name).toBe("Active");
    expect((await list("opportunities")).map((o) => [o.name, o.effect]).slice(-2)).toEqual([
      ["Closed Won", "won"],
      ["Closed Lost", "lost"],
    ]);
    // Everyone can read the lists; only an admin can change them.
    expect((await as(watcher).get("/api/statuses")).status).toBe(200);
    const denied = await as(seller).post("/api/statuses", { object: "leads", name: "Nope" });
    expect(denied.status).toBe(403);
    const leadNew = await find("leads", "New");
    expect((await as(outsider).patch(`/api/statuses/${leadNew.id}`, { name: "Hacked" })).status).toBe(404);
  });

  it("lets records use a status the organization added, and nothing else", async () => {
    const added = await as(boss).post("/api/statuses", { object: "leads", name: "Nurture", color: "mauve" });
    expect(added.status).toBe(201);
    expect((await list("leads")).map((o) => o.name).at(-1)).toBe("Nurture");
    expect((await as(boss).post("/api/statuses", { object: "leads", name: "nurture" })).status).toBe(400);
    expect((await as(boss).post("/api/statuses", { object: "accounts", name: "X", effect: "ends_sequence" })).status).toBe(400);

    const lead = await as(seller).post("/api/leads", person("nurture@status.example", { status: "nurture" }));
    expect(lead.body.status).toBe("Nurture"); // spelled the way the list spells it
    expect((await as(seller).post("/api/leads", person("bad@status.example", { status: "Made Up" }))).status).toBe(400);
    expect((await as(seller).patch(`/api/leads/${lead.body.id}`, { status: "Customer" })).status).toBe(400);
    // Nurture belongs to leads only.
    const account = (await as(seller).post("/api/accounts", { name: "Status Co" })).body;
    expect(account.status).toBe("Active");
    const contact = await as(seller).post("/api/contacts", {
      ...person("contact@status.example", { status: "Nurture" }),
      accountId: account.id,
    });
    expect(contact.status).toBe(400);
    expect((await find("leads", "Nurture")).inUse).toBe(1);
  });

  it("renames a status on every record that has it", async () => {
    const lead = (await as(seller).post("/api/leads", person("rename@status.example", { status: "Prospecting" }))).body;
    const option = await find("leads", "Prospecting");
    expect((await as(boss).patch(`/api/statuses/${option.id}`, { name: "Active" })).status).toBe(400);
    const renamed = await as(boss).patch(`/api/statuses/${option.id}`, { name: "Working" });
    expect(renamed.status).toBe(200);
    expect((await as(seller).get(`/api/leads/${lead.id}`)).body.status).toBe("Working");
    const history = (await as(seller).get(`/api/history/lead/${lead.id}`)).body;
    expect(history[0]).toMatchObject({
      field: "status",
      oldValue: "Prospecting",
      newValue: "Working",
      source: "system",
      userId: boss.userId,
    });
    // Contacts have their own list, which still says Prospecting.
    expect((await list("contacts")).map((o) => o.name)).toContain("Prospecting");
  });

  it("gives new and imported records whichever status is the default", async () => {
    const nurture = await find("leads", "Nurture");
    await as(boss).patch(`/api/statuses/${nurture.id}`, { isDefault: true });
    expect((await list("leads")).filter((o) => o.isDefault).map((o) => o.name)).toEqual(["Nurture"]);
    const lead = (await as(seller).post("/api/leads", person("default@status.example"))).body;
    expect(lead.status).toBe("Nurture");
    await as(seller).post("/api/import/leads", { rows: [person("imported@status.example")] });
    expect((await as(seller).get("/api/leads?q=imported@status")).body[0].status).toBe("Nurture");
    expect((await as(boss).del(`/api/statuses/${nurture.id}`)).status).toBe(400); // the default stays
  });

  it("ends sequences and blocks enrolling according to what a status is set to do", async () => {
    const sequence = (await as(seller).post("/api/sequences", { name: "Status effects" })).body;
    await as(seller).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });
    await as(boss).post("/api/statuses", { object: "leads", name: "Went Cold", effect: "ends_sequence" });
    await as(boss).post("/api/statuses", { object: "leads", name: "Unsubscribed", effect: "do_not_contact" });

    const a = (await as(seller).post("/api/leads", person("a@effects.example"))).body;
    await as(seller).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: a.id });
    await as(seller).patch(`/api/leads/${a.id}`, { status: "Went Cold" });
    let people = (await as(seller).get(`/api/sequences/${sequence.id}/enrollments`)).body;
    expect(people[0]).toMatchObject({ state: "ended", endReason: "status_change" });
    // "Went Cold" ends a sequence but does not stop a new one.
    expect((await as(seller).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: a.id })).status).toBe(201);

    const b = (await as(seller).post("/api/leads", person("b@effects.example", { status: "Unsubscribed" }))).body;
    const blocked = await as(seller).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: b.id });
    expect(blocked.body).toMatchObject({ error: "do_not_contact" });

    // The old name means nothing once its behavior is switched off.
    const dnc = await find("leads", "Do Not Contact");
    await as(boss).patch(`/api/statuses/${dnc.id}`, { effect: "none" });
    const c = (await as(seller).post("/api/leads", person("c@effects.example", { status: "Do Not Contact" }))).body;
    expect((await as(seller).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: c.id })).status).toBe(201);

    // Deleting a status in use needs somewhere to put its records, and a
    // replacement that ends sequences ends theirs.
    people = (await as(seller).get(`/api/sequences/${sequence.id}/enrollments`)).body;
    expect(people.filter((p: { state: string }) => p.state === "active")).toHaveLength(2);
    expect((await as(boss).del(`/api/statuses/${dnc.id}`)).status).toBe(400);
    const cold = await find("leads", "Went Cold");
    expect((await as(boss).del(`/api/statuses/${dnc.id}?replaceWith=${cold.id}`)).status).toBe(200);
    expect((await as(seller).get(`/api/leads/${c.id}`)).body.status).toBe("Went Cold");
    people = (await as(seller).get(`/api/sequences/${sequence.id}/enrollments`)).body;
    const forC = people.find((p: { leadId: string; state: string }) => p.leadId === c.id);
    expect(forC).toMatchObject({ state: "ended", endReason: "status_change" });
    expect((await list("leads")).map((o) => o.name)).not.toContain("Do Not Contact");
  });

  it("reorders a list, and deletes an unused status outright", async () => {
    const before = await list("accounts");
    const ids = before.map((o) => o.id).reverse();
    const res = await as(boss).put("/api/statuses/order", { object: "accounts", ids });
    expect(res.body.filter((o: Option) => o.object === "accounts").map((o: Option) => o.name)).toEqual(
      before.map((o) => o.name).reverse(),
    );
    expect((await as(boss).put("/api/statuses/order", { object: "accounts", ids: ids.slice(1) })).status).toBe(400);
    const vendor = await find("accounts", "Vendor");
    expect((await as(boss).del(`/api/statuses/${vendor.id}`)).status).toBe(200);
    expect((await list("accounts")).map((o) => o.name)).not.toContain("Vendor");
  });

  it("keeps a converted lead's status only when contacts have the same one", async () => {
    const account = (await as(seller).post("/api/accounts", { name: "Convert Status Co" })).body;
    const kept = (await as(seller).post("/api/leads", person("kept@convert.example", { status: "Active" }))).body;
    const lost = (await as(seller).post("/api/leads", person("lost@convert.example", { status: "Nurture" }))).body;
    const k = await as(seller).post(`/api/leads/${kept.id}/convert`, { accountId: account.id });
    const l = await as(seller).post(`/api/leads/${lost.id}/convert`, { accountId: account.id });
    expect((await as(seller).get(`/api/contacts/${k.body.contactId}`)).body.status).toBe("Active");
    expect((await as(seller).get(`/api/contacts/${l.body.contactId}`)).body.status).toBe("New");
  });
});

describe("the opportunity pipeline", () => {
  let boss: Ctx;
  let seller: Ctx;
  let watcher: Ctx;
  let account: { id: string };
  let contact: { id: string };
  const stages = async () =>
    (await as(boss).get("/api/statuses")).body.filter(
      (o: { object: string }) => o.object === "opportunities",
    ) as { id: string; name: string; probability: number | null; inUse: number }[];

  beforeAll(async () => {
    boss = await createOrg(db);
    seller = await addMember(db, boss.orgId, "rep", "Sal Seller");
    watcher = await addMember(db, boss.orgId, "read_only", "Wes Watcher");
    account = (await as(seller).post("/api/accounts", { name: "Pipeline Co" })).body;
    contact = (
      await as(seller).post("/api/contacts", {
        firstName: "Pat",
        lastName: "Buyer",
        email: "pat@pipeline.example",
        accountId: account.id,
      })
    ).body;
  });

  it("creates an opportunity in the default stage and tidies what was typed", async () => {
    const res = await as(seller).post("/api/opportunities", {
      name: "ERP rollout",
      accountId: account.id,
      contactId: contact.id,
      amount: "$12,500",
      closeDate: "2026-12-15",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "ERP rollout",
      status: "Prospecting",
      amount: "12500.00",
      closeDate: "2026-12-15",
      ownerId: seller.userId,
      closedAt: null,
    });
    expect((await stages()).map((s) => s.probability)).toEqual([10, 25, 50, 75, 100, 0]);

    const bad = { name: "Bad", accountId: account.id };
    expect((await as(seller).post("/api/opportunities", { ...bad, amount: "lots" })).status).toBe(400);
    expect((await as(seller).post("/api/opportunities", { ...bad, closeDate: "12/15/2026" })).status).toBe(400);
    expect((await as(seller).post("/api/opportunities", { ...bad, status: "Made Up" })).status).toBe(400);
    expect((await as(seller).post("/api/opportunities", { name: "No account" })).status).toBe(400);
    expect((await as(watcher).post("/api/opportunities", bad)).status).toBe(403);
    // The main contact must be at the same account, and in the same organization.
    const other = (await as(seller).post("/api/accounts", { name: "Other Pipeline Co" })).body;
    const wrong = await as(seller).post("/api/opportunities", {
      name: "Wrong contact",
      accountId: other.id,
      contactId: contact.id,
    });
    expect(wrong.status).toBe(400);
    const foreign = (await as(outsider).post("/api/accounts", { name: "Foreign Pipeline" })).body;
    expect((await as(seller).post("/api/opportunities", { name: "X", accountId: foreign.id })).status).toBe(400);
    expect((await as(seller).get("/api/opportunities")).body).toHaveLength(1);
    expect((await as(outsider).get("/api/opportunities")).body).toHaveLength(0);
  });

  it("records each stage move, and closes and reopens the deal", async () => {
    const opp = (
      await as(seller).post("/api/opportunities", { name: "Stage moves", accountId: account.id, amount: 4000 })
    ).body;
    await as(seller).patch(`/api/opportunities/${opp.id}`, { status: "proposal", amount: "6000" });
    const won = await as(boss).patch(`/api/opportunities/${opp.id}`, { status: "Closed Won" });
    expect(won.status).toBe(200);
    let now = (await as(seller).get(`/api/opportunities/${opp.id}`)).body;
    expect(now.status).toBe("Closed Won");
    expect(now.closedAt).not.toBeNull();

    const moves = await db
      .select()
      .from(s.opportunityStageHistory)
      .where(eq(s.opportunityStageHistory.opportunityId, opp.id))
      .orderBy(s.opportunityStageHistory.changedAt);
    expect(moves.map((m) => [m.fromStage, m.toStage, m.amount, m.changedBy])).toEqual([
      [null, "Prospecting", "4000.00", seller.userId],
      ["Prospecting", "Proposal", "6000.00", seller.userId],
      ["Proposal", "Closed Won", "6000.00", boss.userId],
    ]);
    const history = (await as(seller).get(`/api/history/opportunity/${opp.id}`)).body;
    expect(history.filter((h: { field: string }) => h.field === "status")).toHaveLength(2);

    await as(seller).patch(`/api/opportunities/${opp.id}`, { status: "Negotiation" });
    now = (await as(seller).get(`/api/opportunities/${opp.id}`)).body;
    expect(now.closedAt).toBeNull();
    // Clearing the amount and date is allowed.
    const cleared = await as(seller).patch(`/api/opportunities/${opp.id}`, { amount: "", closeDate: "" });
    expect(cleared.body).toMatchObject({ amount: null, closeDate: null });
  });

  it("follows stages that an admin renames, re-rates or deletes", async () => {
    const opp = (
      await as(seller).post("/api/opportunities", { name: "Renamed stage", accountId: account.id, status: "Qualified" })
    ).body;
    const all = await stages();
    const qualified = all.find((s) => s.name === "Qualified")!;
    const lost = all.find((s) => s.name === "Closed Lost")!;
    expect(qualified.inUse).toBe(1);

    const renamed = await as(boss).patch(`/api/statuses/${qualified.id}`, { name: "Discovery", probability: 30 });
    expect(renamed.status).toBe(200);
    expect((await stages()).find((s) => s.id === qualified.id)).toMatchObject({ name: "Discovery", probability: 30 });
    expect((await as(seller).get(`/api/opportunities/${opp.id}`)).body.status).toBe("Discovery");
    expect((await as(boss).patch(`/api/statuses/${qualified.id}`, { probability: 150 })).status).toBe(400);
    const leadNew = (await as(boss).get("/api/statuses")).body.find(
      (o: { object: string; name: string }) => o.object === "leads" && o.name === "New",
    );
    expect((await as(boss).patch(`/api/statuses/${leadNew.id}`, { probability: 50 })).status).toBe(400);

    // Deleting the stage moves its deals to the replacement, here a closed one.
    expect((await as(boss).del(`/api/statuses/${qualified.id}?replaceWith=${lost.id}`)).status).toBe(200);
    const after = (await as(seller).get(`/api/opportunities/${opp.id}`)).body;
    expect(after.status).toBe("Closed Lost");
    expect(after.closedAt).not.toBeNull();
    const moves = await db
      .select()
      .from(s.opportunityStageHistory)
      .where(eq(s.opportunityStageHistory.opportunityId, opp.id))
      .orderBy(s.opportunityStageHistory.changedAt);
    expect(moves.map((m) => [m.fromStage, m.toStage])).toEqual([
      [null, "Discovery"],
      ["Discovery", "Closed Lost"],
    ]);
  });

  it("lets a rep edit but not delete, and protects an account that has opportunities", async () => {
    const opp = (await as(boss).post("/api/opportunities", { name: "Owned by boss", accountId: account.id })).body;
    expect((await as(seller).patch(`/api/opportunities/${opp.id}`, { notes: "Called" })).status).toBe(200);
    expect((await as(seller).del(`/api/opportunities/${opp.id}`)).status).toBe(403);
    expect((await as(boss).del(`/api/accounts/${account.id}`)).status).toBe(400);
    expect((await as(boss).del(`/api/opportunities/${opp.id}`)).status).toBe(204);
    expect((await as(outsider).get(`/api/opportunities/${opp.id}`)).status).toBe(404);
  });
});

describe("activities and the dashboard", () => {
  let boss: Ctx;
  let seller: Ctx;
  let seller2: Ctx;
  let watcher: Ctx;
  let account: { id: string };
  let contact: { id: string };

  beforeAll(async () => {
    boss = await createOrg(db, { waitDayMode: "calendar" });
    seller = await addMember(db, boss.orgId, "rep", "Sal Seller");
    seller2 = await addMember(db, boss.orgId, "rep", "Sue Seller");
    watcher = await addMember(db, boss.orgId, "read_only", "Wes Watcher");
    account = (await as(seller).post("/api/accounts", { name: "Activity Co" }))
      .body;
    contact = (
      await as(seller).post("/api/contacts", {
        firstName: "Ada",
        lastName: "Active",
        email: "ada@activity.example",
        accountId: account.id,
      })
    ).body;
  });

  it("logs an activity by hand and files a contact's under the account too", async () => {
    const call = await as(seller).post("/api/activities", {
      type: "call",
      subject: "Discovery call",
      body: "Talked about month-end close",
      contactId: contact.id,
    });
    expect(call.status).toBe(201);
    expect(call.body).toMatchObject({
      ownerId: seller.userId,
      contactId: contact.id,
      accountId: account.id,
    });

    const onAccount = (
      await as(seller2).get(`/api/activities?accountId=${account.id}`)
    ).body;
    expect(onAccount[0]).toMatchObject({
      type: "call",
      subject: "Discovery call",
      personName: "Ada Active",
      accountName: "Activity Co",
      ownerName: "Sal Seller",
      fromSequence: false,
    });

    const bad = (body: object) => as(seller).post("/api/activities", body);
    expect((await bad({ type: "call", subject: "Nobody" })).status).toBe(400);
    expect((await bad({ type: "call", contactId: contact.id })).status).toBe(
      400,
    ); // nothing said
    expect(
      (await bad({ type: "fax", subject: "x", contactId: contact.id })).status,
    ).toBe(400);
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect(
      (
        await bad({
          type: "note",
          subject: "x",
          contactId: contact.id,
          occurredAt: future,
        })
      ).status,
    ).toBe(400);
    const other = (
      await as(seller).post("/api/accounts", { name: "Other Activity Co" })
    ).body;
    expect(
      (
        await bad({
          type: "note",
          subject: "x",
          contactId: contact.id,
          accountId: other.id,
        })
      ).status,
    ).toBe(400);
    const foreign = (
      await as(outsider).post("/api/accounts", { name: "Foreign Activity" })
    ).body;
    expect(
      (await bad({ type: "note", subject: "x", accountId: foreign.id })).status,
    ).toBe(400);
    expect(
      (
        await as(watcher).post("/api/activities", {
          type: "note",
          subject: "x",
          accountId: account.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (await as(outsider).get(`/api/activities?accountId=${account.id}`)).body,
    ).toHaveLength(0);
    expect((await as(seller).get("/api/activities")).status).toBe(400);

    // A rep cannot delete an activity; a manager or admin can.
    expect(
      (await as(seller).del(`/api/activities/${call.body.id}`)).status,
    ).toBe(403);
    expect((await as(boss).del(`/api/activities/${call.body.id}`)).status).toBe(
      204,
    );
    expect(
      (await as(seller).get(`/api/activities?accountId=${account.id}`)).body,
    ).toHaveLength(0);
  });

  it("writes an activity for each completed step, and moves a lead's to the contact on conversion", async () => {
    const sequence = (
      await as(seller).post("/api/sequences", { name: "Activity steps" })
    ).body;
    await as(seller).post(`/api/sequences/${sequence.id}/steps`, {
      type: "email",
      title: "Intro",
      subject: "Hello {firstName}",
      body: "Hi {firstName}",
    });
    await as(seller).post(`/api/sequences/${sequence.id}/steps`, {
      type: "phone_call",
      title: "Call",
    });
    const lead = (
      await as(seller).post("/api/leads", {
        firstName: "Lou",
        lastName: "Lead",
        email: "lou@activity.example",
        company: "Activity Co",
      })
    ).body;
    const enrolled = (
      await as(seller).post(`/api/sequences/${sequence.id}/enrollments`, {
        leadId: lead.id,
      })
    ).body;
    const done = (
      await as(seller).post(`/api/tasks/${enrolled.task.id}/complete`, {})
    ).body;
    await as(seller).post(`/api/tasks/${done.nextTask.id}/skip`, {});

    let mine = (await as(seller).get(`/api/activities?leadId=${lead.id}`)).body;
    expect(mine).toHaveLength(1); // the skipped call is not an activity
    expect(mine[0]).toMatchObject({
      type: "email",
      subject: "Hello Lou",
      body: "Hi Lou",
      fromSequence: true,
    });

    await as(seller).post("/api/activities", {
      type: "note",
      subject: "Met at trade show",
      leadId: lead.id,
    });
    const converted = (
      await as(seller).post(`/api/leads/${lead.id}/convert`, {
        accountId: account.id,
      })
    ).body;
    expect(
      (await as(seller).get(`/api/activities?leadId=${lead.id}`)).body,
    ).toHaveLength(0);
    mine = (
      await as(seller).get(`/api/activities?contactId=${converted.contactId}`)
    ).body;
    expect(mine.map((a: { type: string }) => a.type).sort()).toEqual([
      "email",
      "note",
    ]);
    expect(
      mine.every((a: { accountId: string }) => a.accountId === account.id),
    ).toBe(true);
    // Nothing more can be logged on the converted lead.
    expect(
      (
        await as(seller).post("/api/activities", {
          type: "note",
          subject: "x",
          leadId: lead.id,
        })
      ).status,
    ).toBe(400);
  });

  it("adds up the home screen for one rep, and for everyone when allowed", async () => {
    const sequence = (
      await as(seller2).post("/api/sequences", { name: "Dashboard" })
    ).body;
    await as(seller2).post(`/api/sequences/${sequence.id}/steps`, {
      type: "phone_call",
      title: "Call",
    });
    const person = (n: number) => ({
      firstName: "Dee",
      lastName: `Ash${n}`,
      email: `dee${n}@dash.example`,
    });
    for (const n of [1, 2]) {
      const lead = (await as(seller2).post("/api/leads", person(n))).body;
      await as(seller2).post(`/api/sequences/${sequence.id}/enrollments`, {
        leadId: lead.id,
      });
    }
    const replied = (await as(seller2).post("/api/leads", person(3))).body;
    const enrolled = (
      await as(seller2).post(`/api/sequences/${sequence.id}/enrollments`, {
        leadId: replied.id,
      })
    ).body;
    await as(seller2).post(`/api/enrollments/${enrolled.enrollment.id}/stop`, {
      reason: "replied",
    });
    await as(seller2).post("/api/activities", {
      type: "call",
      subject: "Left voicemail",
      leadId: replied.id,
    });

    await as(seller2).post("/api/opportunities", {
      name: "Open A",
      accountId: account.id,
      amount: 1000,
      status: "Proposal",
    });
    await as(seller2).post("/api/opportunities", {
      name: "Open B",
      accountId: account.id,
      amount: 500,
      status: "Proposal",
    });
    const thisMonth =
      (await as(seller2).get("/api/dashboard")).body.today.slice(0, 8) + "28";
    await as(seller2).post("/api/opportunities", {
      name: "Closing",
      accountId: account.id,
      amount: 250,
      closeDate: thisMonth,
    });
    await as(seller2).post("/api/opportunities", {
      name: "Won",
      accountId: account.id,
      amount: 4000,
      status: "Closed Won",
    });
    await as(seller).post("/api/opportunities", {
      name: "Someone else's",
      accountId: account.id,
      amount: 99999,
    });

    const dash = (await as(seller2).get("/api/dashboard")).body;
    expect(dash.owner).toBe(seller2.userId);
    expect(dash.steps).toEqual({ dueToday: 2, overdue: 0 });
    expect(dash.activityThisWeek).toMatchObject({ call: 1, email: 0 });
    expect(dash.sequences).toEqual({
      inSequence: 2,
      last30Days: { replied: 1, meetingBooked: 0, finished: 0, optedOut: 0 },
    });
    expect(
      dash.pipeline.byStage.sort((a: { stage: string }, b: { stage: string }) =>
        a.stage.localeCompare(b.stage),
      ),
    ).toEqual([
      { stage: "Proposal", count: 2, amount: 1500 },
      { stage: "Prospecting", count: 1, amount: 250 },
    ]);
    expect(dash.pipeline.closingThisMonth).toEqual({ count: 1, amount: 250 });
    expect(dash.pipeline.wonLast30Days).toEqual({ count: 1, amount: 4000 });
    expect(dash.recentActivity[0]).toMatchObject({
      subject: "Left voicemail",
      personName: "Dee Ash3",
    });

    // A rep sees only their own; an admin can see one rep or everyone.
    expect((await as(seller2).get("/api/dashboard?owner=all")).status).toBe(
      403,
    );
    expect(
      (await as(seller2).get(`/api/dashboard?owner=${seller.userId}`)).status,
    ).toBe(403);
    const theirs = (
      await as(boss).get(`/api/dashboard?owner=${seller2.userId}`)
    ).body;
    expect(theirs.steps).toEqual(dash.steps);
    const everyone = (await as(boss).get("/api/dashboard?owner=all")).body;
    const openTotal = everyone.pipeline.byStage.reduce(
      (sum: number, r: { amount: number }) => sum + r.amount,
      0,
    );
    expect(openTotal).toBeGreaterThanOrEqual(1750 + 99999);
    expect(
      (await as(boss).get(`/api/dashboard?owner=${outsider.userId}`)).status,
    ).toBe(400);
  });
});

describe("organizations are isolated over the API", () => {
  it("hides one organization's records from another", async () => {
    const lead = (await as(rep).post("/api/leads", newLead({ lastName: "Private" }))).body;
    expect((await as(outsider).get(`/api/leads/${lead.id}`)).status).toBe(404);
    expect((await as(outsider).patch(`/api/leads/${lead.id}`, { title: "x" })).status).toBe(404);
    expect((await as(outsider).del(`/api/leads/${lead.id}`)).status).toBe(404);
    expect((await as(outsider).get("/api/leads?q=Private")).body).toHaveLength(0);
    expect((await as(outsider).get(`/api/history/lead/${lead.id}`)).body).toHaveLength(0);
    expect((await as(outsider).get("/api/users")).body).toHaveLength(1);
  });
});

describe("building and running a sequence", () => {
  it("runs end to end: template, steps, enroll, edit, complete, reply", async () => {
    const template = (
      await as(rep).post("/api/templates", {
        name: "Intro",
        type: "email",
        subject: "Hello {firstName}",
        body: "Thought of {company}.",
      })
    ).body;
    const sequence = (await as(rep).post("/api/sequences", { name: "Outbound V1" })).body;

    const s1 = await as(rep).post(`/api/sequences/${sequence.id}/steps`, {
      type: "email",
      title: "Intro email",
      templateId: template.id,
    });
    expect(s1.status).toBe(201);
    expect(s1.body.position).toBe(1);
    expect(s1.body.waitDays).toBe(0);
    const s2 = (
      await as(rep).post(`/api/sequences/${sequence.id}/steps`, {
        type: "phone_call",
        title: "Call",
        waitDays: 2,
        callScript: "Ask about month-end close",
      })
    ).body;
    expect(s2.position).toBe(2);

    // A LinkedIn step cannot use an email template.
    const wrong = await as(rep).post(`/api/sequences/${sequence.id}/steps`, {
      type: "linkedin_message",
      title: "LinkedIn",
      templateId: template.id,
    });
    expect(wrong.status).toBe(400);

    const lead = (await as(rep).post("/api/leads", newLead({ firstName: "Jill" }))).body;
    const enrolled = await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, {
      leadId: lead.id,
    });
    expect(enrolled.status).toBe(201);
    const again = await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, {
      leadId: lead.id,
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_enrolled");

    // The rep's queue shows the email with fields filled in.
    const queue = (await as(rep).get("/api/tasks/due")).body;
    const task = queue.find((t: { person: { leadId: string } }) => t.person.leadId === lead.id);
    expect(task.content).toMatchObject({
      subject: "Hello Jill",
      body: "Thought of Redfield Energy.",
      edited: false,
    });

    // Editing the template updates the open task.
    await as(rep).patch(`/api/templates/${template.id}`, { body: "New body for {company}." });
    expect((await as(rep).get(`/api/tasks/${task.taskId}`)).body.content.body).toBe(
      "New body for Redfield Energy.",
    );

    // The rep personalizes this one message before sending.
    const edited = await as(rep).put(`/api/tasks/${task.taskId}/message`, {
      body: "Saw your note about the audit, {firstName}.",
    });
    expect(edited.body.content.body).toBe("Saw your note about the audit, Jill.");

    const done = await as(rep).post(`/api/tasks/${task.taskId}/complete`, { note: "Sent" });
    expect(done.status).toBe(200);
    expect(done.body.nextTask.stepId).toBe(s2.id);

    const [saved] = await db.select().from(s.stepTasks).where(eq(s.stepTasks.id, task.taskId));
    expect(saved.finalBody).toBe("Saw your note about the audit, Jill.");

    // The call is not due yet, so it is not in the queue.
    const later = (await as(rep).get("/api/tasks/due")).body;
    expect(later.some((t: { taskId: string }) => t.taskId === done.body.nextTask.id)).toBe(false);

    // The lead replies; the rep logs it and the sequence ends.
    const list = (await as(rep).get(`/api/sequences/${sequence.id}/enrollments`)).body;
    expect(list[0]).toMatchObject({ state: "active", leadLastName: lead.lastName });
    const stopped = await as(rep).post(`/api/enrollments/${list[0].id}/stop`, {
      reason: "replied",
    });
    expect(stopped.status).toBe(204);
    const after = (await as(rep).get(`/api/sequences/${sequence.id}/enrollments`)).body;
    expect(after[0]).toMatchObject({ state: "ended", endReason: "replied", nextDueOn: null });
  });

  it("ends the sequence when a person is marked Not Interested", async () => {
    const sequence = (await as(rep).post("/api/sequences", { name: "Status stop" })).body;
    await as(rep).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });
    const lead = (await as(rep).post("/api/leads", newLead())).body;
    await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: lead.id });
    await as(rep).patch(`/api/leads/${lead.id}`, { status: "Not Interested" });
    const list = (await as(rep).get(`/api/sequences/${sequence.id}/enrollments`)).body;
    expect(list[0]).toMatchObject({ state: "ended", endReason: "status_change" });
  });

  it("reorders steps and moves people on when a step is deleted", async () => {
    const sequence = (await as(rep).post("/api/sequences", { name: "Reorder" })).body;
    const ids: string[] = [];
    for (const title of ["A", "B", "C"]) {
      const step = await as(rep).post(`/api/sequences/${sequence.id}/steps`, {
        type: "email",
        title,
      });
      ids.push(step.body.id);
    }
    const reordered = await as(rep).put(`/api/sequences/${sequence.id}/steps/order`, {
      stepIds: [ids[2], ids[0], ids[1]],
    });
    expect(reordered.body.map((x: { title: string }) => x.title)).toEqual(["C", "A", "B"]);
    const bad = await as(rep).put(`/api/sequences/${sequence.id}/steps/order`, {
      stepIds: [ids[0], ids[1]],
    });
    expect(bad.status).toBe(400);

    const lead = (await as(rep).post("/api/leads", newLead())).body;
    const enrolled = (
      await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: lead.id })
    ).body;
    expect(enrolled.task.stepId).toBe(ids[2]); // C is first now

    expect((await as(rep).del(`/api/steps/${ids[2]}`)).status).toBe(204);
    const list = (await as(rep).get(`/api/sequences/${sequence.id}/enrollments`)).body;
    expect(list[0].currentStepId).toBe(ids[0]); // moved on to A
    const steps = (await as(rep).get(`/api/sequences/${sequence.id}/steps`)).body;
    expect(steps.map((x: { title: string }) => x.title)).toEqual(["A", "B"]);
  });

  it("keeps reps out of each other's queues but lets a manager in", async () => {
    const sequence = (await as(rep).post("/api/sequences", { name: "Queues" })).body;
    await as(rep).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });
    const lead = (await as(rep).post("/api/leads", newLead())).body;
    const { task, enrollment } = (
      await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: lead.id })
    ).body;

    const mine = (await as(rep2).get("/api/tasks/due")).body;
    expect(mine.some((t: { taskId: string }) => t.taskId === task.id)).toBe(false);
    expect((await as(rep2).get("/api/tasks/due?owner=all")).status).toBe(403);
    expect((await as(rep2).post(`/api/tasks/${task.id}/complete`)).status).toBe(403);
    expect((await as(rep2).post(`/api/enrollments/${enrollment.id}/pause`)).status).toBe(403);
    expect((await as(viewer).post(`/api/tasks/${task.id}/skip`)).status).toBe(403);
    // A rep cannot assign work to someone else's queue.
    const lead2 = (await as(rep).post("/api/leads", newLead())).body;
    const assign = await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, {
      leadId: lead2.id,
      ownerId: rep2.userId,
    });
    expect(assign.status).toBe(403);

    const all = (await as(manager).get("/api/tasks/due?owner=all")).body;
    expect(all.some((t: { taskId: string }) => t.taskId === task.id)).toBe(true);
    expect((await as(manager).post(`/api/tasks/${task.id}/complete`)).status).toBe(200);
  });

  it("enrolls many people at once and reports who was skipped and why", async () => {
    const sequence = (await as(rep).post("/api/sequences", { name: "Bulk" })).body;
    const empty = await as(rep).post(`/api/sequences/${sequence.id}/enrollments/bulk`, {
      leadIds: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(empty.status).toBe(409); // no steps yet: nobody can be enrolled
    await as(rep).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });

    const fresh = [];
    for (let i = 0; i < 3; i++) fresh.push((await as(rep).post("/api/leads", newLead())).body.id);
    const busy = (await as(rep).post("/api/leads", newLead())).body.id;
    await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: busy });
    const blocked = (await as(rep).post("/api/leads", newLead({ status: "Do Not Contact" }))).body
      .id;

    const res = await as(rep).post(`/api/sequences/${sequence.id}/enrollments/bulk`, {
      leadIds: [...fresh, busy, blocked],
    });
    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(3);
    expect(res.body.skipped).toEqual([
      { id: busy, reason: "already_enrolled" },
      { id: blocked, reason: "do_not_contact" },
    ]);
    expect((await as(viewer).post(`/api/sequences/${sequence.id}/enrollments/bulk`, {
      leadIds: fresh,
    })).status).toBe(403);
  });

  it("counts enrollments per sequence for the list screen", async () => {
    const sequence = (await as(rep).post("/api/sequences", { name: "Counted" })).body;
    await as(rep).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const lead = (await as(rep).post("/api/leads", newLead())).body;
      const res = await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, {
        leadId: lead.id,
      });
      ids.push(res.body.enrollment.id);
    }
    await as(rep).post(`/api/enrollments/${ids[0]}/pause`);
    await as(rep).post(`/api/enrollments/${ids[1]}/stop`, { reason: "opted_out" });
    const stats = (await as(rep).get("/api/sequences/stats")).body;
    expect(stats[sequence.id]).toEqual({ total: 3, active: 1, paused: 1, ended: 1 });
    const foreign = (await as(outsider).get("/api/sequences/stats")).body;
    expect(foreign[sequence.id]).toBeUndefined();
  });

  it("holds a step enrolled on a Saturday until Monday in business-day mode", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-10T15:00:00Z")); // Saturday morning in Chicago
      const org = await createOrg(db); // business days by default
      const sequence = (await as(org).post("/api/sequences", { name: "Weekend" })).body;
      await as(org).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });
      const lead = (await as(org).post("/api/leads", newLead())).body;
      const { task } = (
        await as(org).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: lead.id })
      ).body;
      expect(task.dueOn).toBe("2026-10-12");
      expect((await as(org).get("/api/tasks/due")).body).toHaveLength(0);

      vi.setSystemTime(new Date("2026-10-12T15:00:00Z")); // Monday
      expect((await as(org).get("/api/tasks/due")).body).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a read-only user from enrolling anyone", async () => {
    const sequence = (await as(rep).post("/api/sequences", { name: "No enroll" })).body;
    await as(rep).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });
    const lead = (await as(rep).post("/api/leads", newLead())).body;
    const res = await as(viewer).post(`/api/sequences/${sequence.id}/enrollments`, {
      leadId: lead.id,
    });
    expect(res.status).toBe(403);
  });
});

describe("settings", () => {
  it("lets each user choose their own time zone", async () => {
    const before = (await as(rep).get("/api/me/settings")).body;
    expect(before).toEqual({
      timezone: null,
      effectiveTimezone: "America/Chicago",
      organizationDefault: "America/Chicago",
    });
    const saved = await as(rep).patch("/api/me/settings", { timezone: "America/New_York" });
    expect(saved.body.effectiveTimezone).toBe("America/New_York");
    // One user's choice does not change anyone else's.
    expect((await as(rep2).get("/api/me/settings")).body.effectiveTimezone).toBe(
      "America/Chicago",
    );
    const bad = await as(rep).patch("/api/me/settings", { timezone: "Mars/Olympus" });
    expect(bad.status).toBe(400);
    // Clearing it goes back to the organization default.
    const cleared = await as(rep).patch("/api/me/settings", { timezone: null });
    expect(cleared.body.effectiveTimezone).toBe("America/Chicago");
  });

  it("lets only an admin change the organization's wait-day rule", async () => {
    const org = await createOrg(db);
    const member = await addMember(db, org.orgId, "manager");
    expect((await as(member).get("/api/settings")).body.waitDayMode).toBe("business");
    expect((await as(member).patch("/api/settings", { waitDayMode: "calendar" })).status).toBe(
      403,
    );
    const changed = await as(org).patch("/api/settings", { waitDayMode: "calendar" });
    expect(changed.status).toBe(200);
    expect(changed.body.waitDayMode).toBe("calendar");
    expect((await as(member).get("/api/settings")).body.waitDayMode).toBe("calendar");
    expect((await as(org).patch("/api/settings", { waitDayMode: "weekly" })).status).toBe(400);

    const history = (await as(org).get(`/api/history/org_settings/${org.orgId}`)).body;
    expect(history[0]).toMatchObject({
      field: "waitDayMode",
      oldValue: "business",
      newValue: "calendar",
    });
    // Other organizations are untouched.
    expect((await as(rep).get("/api/settings")).body.waitDayMode).toBe("calendar");
  });
});

describe("users and roles", () => {
  it("lets an admin change a user's role, and nobody else", async () => {
    const temp = await addMember(db, admin.orgId, "rep", "Temp Person");
    const roles = (await as(admin).get("/api/roles")).body;
    expect(roles.map((r: { name: string }) => r.name)).toEqual([
      "Admin",
      "Manager",
      "Rep",
      "Read-only",
    ]);
    const managerRole = roles.find((r: { name: string }) => r.name === "Manager");

    const denied = await as(manager).put(`/api/users/${temp.userId}/role`, {
      roleId: managerRole.id,
    });
    expect(denied.status).toBe(403);

    const ok = await as(admin).put(`/api/users/${temp.userId}/role`, { roleId: managerRole.id });
    expect(ok.status).toBe(204);
    expect((await as(temp).get("/api/me")).body.role).toBe("Manager");
    const listed = (await as(admin).get("/api/users")).body;
    expect(listed.find((u: { id: string }) => u.id === temp.userId).role).toBe("Manager");
  });

  it("never leaves an organization without an Admin", async () => {
    const org = await createOrg(db);
    const other = await addMember(db, org.orgId, "rep");
    const roles = (await as(org).get("/api/roles")).body;
    const repRole = roles.find((r: { name: string }) => r.name === "Rep");
    const adminRole = roles.find((r: { name: string }) => r.name === "Admin");

    // The owner is always an Admin, so an organization can never have none.
    const refused = await as(org).put(`/api/users/${org.userId}/role`, { roleId: repRole.id });
    expect(refused.status).toBe(400);
    expect((await as(org).get("/api/me")).body.role).toBe("Admin");

    // To step down, the owner makes someone else an Admin and hands over first.
    await as(org).put(`/api/users/${other.userId}/role`, { roleId: adminRole.id });
    await as(org).post("/api/organization/transfer", { userId: other.userId });
    const allowed = await as(other).put(`/api/users/${org.userId}/role`, { roleId: repRole.id });
    expect(allowed.status).toBe(204);
    expect((await as(org).get("/api/me")).body.role).toBe("Rep");
  });

  it("cannot reach users or roles in another organization", async () => {
    const roles = (await as(admin).get("/api/roles")).body;
    const foreignRoles = (await as(outsider).get("/api/roles")).body;
    const cross = await as(admin).put(`/api/users/${outsider.userId}/role`, {
      roleId: roles[1].id,
    });
    expect(cross.status).toBe(404);
    const wrongRole = await as(admin).put(`/api/users/${rep.userId}/role`, {
      roleId: foreignRoles[1].id,
    });
    expect(wrongRole.status).toBe(400);
  });
});

describe("the organization owner", () => {
  it("is whoever created the organization, and only they can open the Organization tab", async () => {
    const org = await createOrg(db);
    const secondAdmin = await addMember(db, org.orgId, "admin", "Second Admin");
    expect((await as(org).get("/api/me")).body.isOwner).toBe(true);
    expect((await as(secondAdmin).get("/api/me")).body.isOwner).toBe(false);

    const mine = await as(org).get("/api/organization");
    expect(mine.status).toBe(200);
    expect(mine.body.owner.id).toBe(org.userId);
    expect(mine.body.transferCandidates.map((c: { id: string }) => c.id)).toEqual([
      secondAdmin.userId,
    ]);
    // Another Admin is still not the owner.
    expect((await as(secondAdmin).get("/api/organization")).status).toBe(403);
    expect(
      (await as(secondAdmin).patch("/api/organization", { billingEmail: "x@example.com" })).status,
    ).toBe(403);
  });

  it("sets an optional billing email", async () => {
    const org = await createOrg(db);
    const saved = await as(org).patch("/api/organization", { billingEmail: "AP@Example.com" });
    expect(saved.body.billingEmail).toBe("ap@example.com");
    expect((await as(org).patch("/api/organization", { billingEmail: "nope" })).status).toBe(400);
    const cleared = await as(org).patch("/api/organization", { billingEmail: "" });
    expect(cleared.body.billingEmail).toBeNull();
  });

  it("must stay an Admin until ownership is transferred", async () => {
    const org = await createOrg(db);
    const other = await addMember(db, org.orgId, "admin", "Other Admin");
    const roles = (await as(org).get("/api/roles")).body;
    const repRole = roles.find((r: { name: string }) => r.name === "Rep");
    // There are two Admins, so the "last Admin" rule does not apply; the owner rule does.
    const refused = await as(other).put(`/api/users/${org.userId}/role`, { roleId: repRole.id });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/Transfer ownership first/);
  });

  it("transfers to another Admin at once, and records it", async () => {
    const org = await createOrg(db);
    const rep = await addMember(db, org.orgId, "rep", "Just A Rep");
    const next = await addMember(db, org.orgId, "admin", "Next Owner");

    // Not to a non-admin, not to yourself, not to someone outside.
    expect((await as(org).post("/api/organization/transfer", { userId: rep.userId })).status).toBe(
      400,
    );
    expect((await as(org).post("/api/organization/transfer", { userId: org.userId })).status).toBe(
      400,
    );
    expect(
      (await as(org).post("/api/organization/transfer", { userId: outsider.userId })).status,
    ).toBe(404);
    // And only the owner can do it.
    expect((await as(next).post("/api/organization/transfer", { userId: next.userId })).status).toBe(
      403,
    );

    const done = await as(org).post("/api/organization/transfer", { userId: next.userId });
    expect(done.status).toBe(204);
    expect((await as(next).get("/api/me")).body.isOwner).toBe(true);
    const before = await as(org).get("/api/me");
    expect(before.body.isOwner).toBe(false);
    expect(before.body.role).toBe("Admin"); // the previous owner stays an Admin
    expect((await as(org).get("/api/organization")).status).toBe(403);

    const users = (await as(next).get("/api/users")).body;
    expect(users.filter((u: { isOwner: boolean }) => u.isOwner).map((u: { id: string }) => u.id))
      .toEqual([next.userId]);
    const history = (await as(next).get(`/api/history/organization/${org.orgId}`)).body;
    expect(history[0]).toMatchObject({ field: "owner", oldValue: "Admin", newValue: "Next Owner" });

    // Now the previous owner can be demoted like anyone else.
    const roles = (await as(next).get("/api/roles")).body;
    const repRole = roles.find((r: { name: string }) => r.name === "Rep");
    expect((await as(next).put(`/api/users/${org.userId}/role`, { roleId: repRole.id })).status)
      .toBe(204);
  });
});

describe("a locked account", () => {
  it("can still see who it is, and nothing else", async () => {
    const locked = await createOrg(db);
    await db
      .update(s.organizations)
      .set({ billingStatus: "locked" })
      .where(eq(s.organizations.id, locked.orgId));
    const me = await as(locked).get("/api/me");
    expect(me.status).toBe(200);
    expect(me.body.billingStatus).toBe("locked");
    const leads = await as(locked).get("/api/leads");
    expect(leads.status).toBe(402);
    expect(leads.body.error).toBe("account_locked");
  });
});

describe("unknown routes and ids", () => {
  it("answers 404 instead of crashing", async () => {
    expect((await as(rep).get("/api/nope")).status).toBe(404);
    expect((await as(rep).get("/api/leads/not-a-uuid")).status).toBe(404);
    expect((await request(app).get("/healthz")).body).toEqual({ ok: true });
  });
});
