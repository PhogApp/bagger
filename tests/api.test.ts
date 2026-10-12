import { eq } from "drizzle-orm";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { resolveActor } from "../server/auth/actor";
import type { Ctx, Db } from "../server/db/types";
import { createApp } from "../server/http/app";
import * as s from "../shared/schema";
import { localDate } from "../server/sequences/dates";
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

describe("custom fields and record layouts", () => {
  let boss: Ctx;
  let seller: Ctx;
  type Setup = {
    fields: { id: string; object: string; key: string; label: string; options: string[]; archived: boolean }[];
    layouts: Record<string, { field: string; width: string; hidden?: boolean }[]>;
  };
  const setup = async (): Promise<Setup> => (await as(boss).get("/api/fields")).body;
  const field = async (object: string, label: string) =>
    (await setup()).fields.find((f) => f.object === object && f.label === label)!;
  const add = (body: object) => as(boss).post("/api/fields", body);
  const lead = (email: string, custom?: object) => ({
    firstName: "Cy",
    lastName: "Custom",
    email,
    ...(custom ? { custom } : {}),
  });

  beforeAll(async () => {
    boss = await createOrg(db, { waitDayMode: "calendar" });
    seller = await addMember(db, boss.orgId, "rep", "Sal Seller");
  });

  it("lets only an admin add fields, with a key made from the label", async () => {
    expect((await add({ object: "leads", label: "Current ERP", type: "picklist", options: ["QuickBooks", "Sage", "Xero"] })).status).toBe(201);
    await add({ object: "leads", label: "Locations", type: "number" });
    await add({ object: "leads", label: "Budget", type: "currency" });
    await add({ object: "leads", label: "Decision maker?", type: "checkbox" });
    await add({ object: "leads", label: "Modules", type: "multipicklist", options: ["GL", "AP", "AR"] });
    await add({ object: "leads", label: "Renewal date", type: "date" });
    await add({ object: "leads", label: "Industry", type: "text", required: true });
    await add({ object: "leads", label: "Referred by", type: "user" });
    const keys = (await setup()).fields.map((f) => f.key);
    expect(keys).toEqual([
      "currentErp", "locations", "budget", "decisionMaker", "modules", "renewalDate", "industry", "referredBy",
    ]);
    expect((await as(seller).post("/api/fields", { object: "leads", label: "X", type: "text" })).status).toBe(403);
    expect((await as(seller).get("/api/fields")).status).toBe(200);
    expect((await add({ object: "leads", label: "industry", type: "text" })).status).toBe(400);
    expect((await add({ object: "leads", label: "Tier", type: "picklist" })).status).toBe(400);
    // A label matching a Bagger field still gets its own key.
    await add({ object: "accounts", label: "Website", type: "url" });
    expect((await field("accounts", "Website")).key).toBe("website2");
  });

  it("checks, tidies and records custom values on leads", async () => {
    const res = await as(seller).post(
      "/api/leads",
      lead("cy@custom.example", {
        currentErp: "quickbooks",
        locations: "1,200",
        budget: "$45,000.50",
        decisionMaker: "yes",
        modules: "AR; gl",
        renewalDate: "2027-03-31",
        industry: "Logistics",
        referredBy: boss.userId,
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.custom).toEqual({
      currentErp: "QuickBooks",
      locations: 1200,
      budget: 45000.5,
      decisionMaker: true,
      modules: ["GL", "AR"],
      renewalDate: "2027-03-31",
      industry: "Logistics",
      referredBy: boss.userId,
    });

    const bad = async (custom: object) =>
      (await as(seller).post("/api/leads", lead(`bad${Math.random()}@custom.example`, { industry: "x", ...custom })));
    expect((await as(seller).post("/api/leads", lead("noind@custom.example"))).body.message).toMatch(/Industry is required/);
    expect((await bad({ currentErp: "SAP" })).body.message).toMatch(/not one of the choices/);
    expect((await bad({ locations: "many" })).status).toBe(400);
    expect((await bad({ renewalDate: "03/31/2027" })).status).toBe(400);
    expect((await bad({ nope: "x" })).status).toBe(400);
    expect((await bad({ referredBy: outsider.userId })).status).toBe(400);

    // Editing one field leaves the others; clearing a required one is refused.
    const id = res.body.id;
    const edited = await as(seller).patch(`/api/leads/${id}`, { custom: { locations: 14, budget: "" } });
    expect(edited.body.custom).toMatchObject({ locations: 14, currentErp: "QuickBooks" });
    expect(edited.body.custom.budget).toBeUndefined();
    expect((await as(seller).patch(`/api/leads/${id}`, { custom: { industry: "" } })).status).toBe(400);
    const history = (await as(seller).get(`/api/history/lead/${id}`)).body;
    expect(history.filter((h: { field: string }) => h.field?.startsWith("custom."))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "custom.locations", oldValue: "1200", newValue: "14" }),
        expect.objectContaining({ field: "custom.budget", oldValue: "45000.5", newValue: null }),
      ]),
    );
    // A lead made before Industry was required can still be edited elsewhere.
    await db.update(s.leads).set({ custom: {} }).where(eq(s.leads.id, id));
    expect((await as(seller).patch(`/api/leads/${id}`, { title: "Buyer" })).status).toBe(200);
  });

  it("renames picklist choices on records, and asks where removed ones go", async () => {
    const erp = await field("leads", "Current ERP");
    const a = (await as(seller).post("/api/leads", lead("a@pick.example", { industry: "x", currentErp: "Sage", modules: ["GL", "AP"] }))).body;
    const b = (await as(seller).post("/api/leads", lead("b@pick.example", { industry: "x", currentErp: "Xero" }))).body;

    const renamed = await as(boss).patch(`/api/fields/${erp.id}`, {
      options: ["QuickBooks", "Sage Intacct", "Xero"],
      renamed: { Sage: "Sage Intacct" },
    });
    expect(renamed.status).toBe(200);
    expect((await as(seller).get(`/api/leads/${a.id}`)).body.custom.currentErp).toBe("Sage Intacct");

    const usage = (await as(boss).get(`/api/fields/${erp.id}/usage`)).body;
    expect(usage.byOption).toMatchObject({ Xero: 1, "Sage Intacct": 1 });
    expect((await as(boss).patch(`/api/fields/${erp.id}`, { options: ["QuickBooks", "Sage Intacct"] })).status).toBe(400);
    await as(boss).patch(`/api/fields/${erp.id}`, {
      options: ["QuickBooks", "Sage Intacct"],
      replace: { Xero: "QuickBooks" },
    });
    expect((await as(seller).get(`/api/leads/${b.id}`)).body.custom.currentErp).toBe("QuickBooks");
    const history = (await as(seller).get(`/api/history/lead/${b.id}`)).body;
    expect(history[0]).toMatchObject({ field: "custom.currentErp", oldValue: "Xero", newValue: "QuickBooks", source: "system" });

    const modules = await field("leads", "Modules");
    await as(boss).patch(`/api/fields/${modules.id}`, { options: ["GL", "AR"], replace: { AP: null } });
    expect((await as(seller).get(`/api/leads/${a.id}`)).body.custom.modules).toEqual(["GL"]);
  });

  it("archives a field without losing its values", async () => {
    const locations = await field("leads", "Locations");
    const kept = (await as(seller).post("/api/leads", lead("arch@custom.example", { industry: "x", locations: 3 }))).body;
    await as(boss).patch(`/api/fields/${locations.id}`, { archived: true });
    expect((await as(seller).patch(`/api/leads/${kept.id}`, { custom: { locations: 4 } })).status).toBe(400);
    expect((await as(seller).get(`/api/leads/${kept.id}`)).body.custom.locations).toBe(3);
    await as(boss).patch(`/api/fields/${locations.id}`, { archived: false });
    expect((await as(seller).patch(`/api/leads/${kept.id}`, { custom: { locations: 4 } })).status).toBe(200);
  });

  it("saves the record page layout, keeping Bagger's essential fields visible", async () => {
    const entries = [
      { field: "firstName", width: "half" },
      { field: "lastName", width: "half" },
      { field: "custom.currentErp", width: "full" },
      { field: "directPhone", width: "third", hidden: true },
    ];
    const saved = await as(boss).put("/api/fields/layout", { object: "leads", entries });
    expect(saved.status).toBe(200);
    expect(saved.body.layouts.leads).toEqual(entries);
    const hideEmail = [{ field: "email", width: "half", hidden: true }];
    expect((await as(boss).put("/api/fields/layout", { object: "leads", entries: hideEmail })).status).toBe(400);
    expect((await as(boss).put("/api/fields/layout", { object: "leads", entries: [{ field: "custom.nope", width: "half" }] })).status).toBe(400);
    expect((await as(seller).put("/api/fields/layout", { object: "leads", entries })).status).toBe(403);
  });

  it("imports custom columns, and lists rows missing a required value", async () => {
    const rows = [
      { firstName: "Ia", lastName: "One", email: "ia@import-custom.example", "custom.industry": "Retail", "custom.referredBy": "SAL SELLER", "custom.decisionMaker": "x" },
      { firstName: "Ib", lastName: "Two", email: "ib@import-custom.example" },
      { firstName: "Ic", lastName: "Three", email: "ic@import-custom.example", "custom.renewalDate": "soon" },
    ];
    const res = await as(seller).post("/api/import/leads", { rows });
    expect(res.body).toMatchObject({
      created: 2,
      incomplete: [{ row: 2, label: "ib@import-custom.example", missing: ["Industry"] }],
      errors: [{ row: 3 }],
    });
    const ia = (await as(seller).get("/api/leads?q=ia@import-custom")).body[0];
    expect(ia.custom).toEqual({ industry: "Retail", referredBy: seller.userId, decisionMaker: true });

    const again = await as(seller).post("/api/import/leads", {
      rows: [{ firstName: "Ia", lastName: "One", email: "ia@import-custom.example", "custom.industry": "Grocery" }],
      mode: "update",
    });
    expect(again.body).toMatchObject({ updated: 1 });
    const after = (await as(seller).get(`/api/leads/${ia.id}`)).body;
    expect(after.custom).toEqual({ industry: "Grocery", referredBy: seller.userId, decisionMaker: true });
  });

  it("carries matching fields through conversion and fills custom merge fields", async () => {
    await add({ object: "contacts", label: "Industry", type: "text" });
    await add({ object: "contacts", label: "Locations", type: "text" }); // a different type: not carried
    await add({ object: "accounts", label: "Tier", type: "picklist", options: ["Gold", "Silver"] });
    const account = (await as(seller).post("/api/accounts", { name: "Merge Co", custom: { tier: "Gold" } })).body;
    const l = (await as(seller).post("/api/leads", lead("merge@custom.example", { industry: "Hospitality", locations: 9 }))).body;
    const converted = (await as(seller).post(`/api/leads/${l.id}/convert`, { accountId: account.id })).body;
    const contact = (await as(seller).get(`/api/contacts/${converted.contactId}`)).body;
    expect(contact.custom).toEqual({ industry: "Hospitality" });

    const sequence = (await as(seller).post("/api/sequences", { name: "Merge" })).body;
    await as(seller).post(`/api/sequences/${sequence.id}/steps`, {
      type: "email",
      title: "Hi",
      subject: "{firstName} in {custom.industry}",
      body: "As a {account.tier} customer… {custom.missing}{account.nothing}",
    });
    const enrolled = (await as(seller).post(`/api/sequences/${sequence.id}/enrollments`, { contactId: contact.id })).body;
    const task = (await as(seller).get(`/api/tasks/${enrolled.task.id}`)).body;
    expect(task.content).toMatchObject({ subject: "Cy in Hospitality", body: "As a Gold customer… " });
  });
});

describe("standard reports", () => {
  let boss: Ctx;
  let seller: Ctx;
  let seller2: Ctx;
  let viewer2: Ctx;
  const today = localDate(new Date(), "America/Chicago");
  const range = (extra = "") => `from=${today}&to=${today}${extra}`;

  beforeAll(async () => {
    boss = await createOrg(db, { waitDayMode: "calendar" });
    seller = await addMember(db, boss.orgId, "rep", "Sal Seller");
    seller2 = await addMember(db, boss.orgId, "rep", "Sue Seller");
    viewer2 = await addMember(db, boss.orgId, "read_only", "Vee Viewer");

    // A sequence with two steps: three people in, one replies, one finishes.
    const sequence = (await as(seller).post("/api/sequences", { name: "Report me" })).body;
    await as(seller).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "Email" });
    await as(seller).post(`/api/sequences/${sequence.id}/steps`, { type: "phone_call", title: "Call" });
    const people = [];
    for (const i of [1, 2, 3]) {
      const l = (await as(seller).post("/api/leads", { firstName: "R", lastName: `P${i}`, email: `rp${i}@reports.example` })).body;
      people.push((await as(seller).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: l.id })).body);
    }
    const done = (await as(seller).post(`/api/tasks/${people[0].task.id}/complete`, {})).body;
    await as(seller).post(`/api/tasks/${done.nextTask.id}/complete`, {}); // finished
    await as(seller).post(`/api/tasks/${people[1].task.id}/skip`, {});
    await as(seller).post(`/api/enrollments/${people[2].enrollment.id}/stop`, { reason: "replied" });

    await as(seller2).post("/api/activities", { type: "call", subject: "c1", leadId: people[0].enrollment.leadId });
    await as(seller2).post("/api/activities", { type: "call", subject: "c2", leadId: people[0].enrollment.leadId });

    const account = (await as(seller).post("/api/accounts", { name: "Reports Co" })).body;
    const opp = (name: string, amount: number, who = seller) =>
      as(who).post("/api/opportunities", { name, accountId: account.id, amount }).then((r) => r.body);
    const a = await opp("Win A", 1000);
    const b = await opp("Win B", 3000);
    const c = await opp("Lose C", 500);
    await opp("Open D", 700);
    await opp("Open E", 900, seller2);
    await as(seller).patch(`/api/opportunities/${a.id}`, { status: "Proposal" });
    await as(seller).patch(`/api/opportunities/${a.id}`, { status: "Closed Won" });
    await as(seller).patch(`/api/opportunities/${b.id}`, { status: "Closed Won" });
    await as(seller).patch(`/api/opportunities/${c.id}`, { status: "Closed Lost" });

    const toConvert = (await as(seller).post("/api/leads", { firstName: "Con", lastName: "Vert", email: "conv@reports.example" })).body;
    await as(seller).post(`/api/leads/${toConvert.id}/convert`, { accountId: account.id });
  });

  it("reports how each sequence and step is doing", async () => {
    const res = await as(seller).get(`/api/reports/sequences?${range()}`);
    expect(res.status).toBe(200);
    const row = res.body.sequences.find((q: { name: string }) => q.name === "Report me");
    expect(row).toMatchObject({ enrolled: 3, active: 1, finished: 1, replied: 1, meetingBooked: 0, responseRate: 0.5 });
    expect(row.steps).toEqual([
      expect.objectContaining({ title: "Email", completed: 1, skipped: 1 }),
      expect.objectContaining({ title: "Call", completed: 1, skipped: 0 }),
    ]);
    // Seller2 has none of it; yesterday has none of it.
    const theirs = (await as(boss).get(`/api/reports/sequences?${range(`&owner=${seller2.userId}`)}`)).body;
    expect(theirs.sequences.find((q: { name: string }) => q.name === "Report me").enrolled).toBe(0);
  });

  it("counts activity by rep and over time, including completed steps", async () => {
    const all = (await as(boss).get(`/api/reports/activity?${range("&owner=all&interval=day")}`)).body;
    const byRep = Object.fromEntries(all.byRep.map((r: { ownerId: string }) => [r.ownerId, r]));
    expect(byRep[seller.userId]).toMatchObject({ email: 1, call: 1 });
    expect(byRep[seller2.userId]).toMatchObject({ call: 2 });
    expect(all.overTime).toEqual([{ period: today, email: 1, call: 3 }]);
  });

  it("reports the pipeline, win rate and time in each stage", async () => {
    const p = (await as(seller).get(`/api/reports/pipeline?${range()}`)).body;
    expect(p.open).toEqual([{ stage: "Prospecting", ownerId: seller.userId, count: 1, amount: 700 }]);
    expect(p.closed).toMatchObject({ won: 2, lost: 1, wonAmount: 4000, lostAmount: 500, averageWon: 2000 });
    expect(p.closed.winRate).toBeCloseTo(2 / 3);
    const stages = Object.fromEntries(p.timeInStage.map((t: { stage: string }) => [t.stage, t]));
    expect(stages.Prospecting.entries).toBe(4);
    expect(stages.Proposal.entries).toBe(1);
    const everyone = (await as(boss).get(`/api/reports/pipeline?${range("&owner=all")}`)).body;
    expect(everyone.byRep.find((r: { ownerId: string }) => r.ownerId === seller2.userId)).toMatchObject({ openCount: 1, openAmount: 900, winRate: null });
  });

  it("reports lead conversion", async () => {
    const c = (await as(seller).get(`/api/reports/conversion?${range()}`)).body;
    expect(c).toMatchObject({ created: 4, converted: 1, conversionRate: 0.25 });
    expect(c.averageDaysToConvert).toBeLessThan(1);
  });

  it("limits who sees whose numbers, and checks the range", async () => {
    expect((await as(seller).get(`/api/reports/pipeline?${range("&owner=all")}`)).status).toBe(403);
    expect((await as(seller).get(`/api/reports/pipeline?${range(`&owner=${seller2.userId}`)}`)).status).toBe(403);
    expect((await as(viewer2).get(`/api/reports/pipeline?${range()}`)).status).toBe(200);
    expect((await as(seller).get("/api/reports/pipeline?from=2026-10-10&to=2026-10-01")).status).toBe(400);
    expect((await as(seller).get("/api/reports/pipeline")).status).toBe(400);
    expect((await as(boss).get(`/api/reports/pipeline?${range(`&owner=${outsider.userId}`)}`)).status).toBe(400);
    const other = (await as(outsider).get(`/api/reports/conversion?${range()}`)).body;
    expect(other.converted).toBe(0);
  });
});

describe("the report builder", () => {
  let boss: Ctx;
  let mgr: Ctx;
  let seller: Ctx;
  let seller2: Ctx;
  let watcher: Ctx;
  type Result = { columns: { key: string; label: string }[]; rows: unknown[][]; total: number; truncated: boolean };
  const run = async (who: Ctx, definition: object, extra: object = {}) =>
    as(who).post("/api/reports/run", { definition, ...extra });
  const rows = async (definition: object, who = boss): Promise<Result> => {
    const res = await run(who, definition);
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    return res.body;
  };

  beforeAll(async () => {
    boss = await createOrg(db, { waitDayMode: "calendar" });
    mgr = await addMember(db, boss.orgId, "manager", "Mo Manager");
    seller = await addMember(db, boss.orgId, "rep", "Sal Seller");
    seller2 = await addMember(db, boss.orgId, "rep", "Sue Seller");
    watcher = await addMember(db, boss.orgId, "read_only", "Wes Watcher");
    await as(boss).post("/api/fields", { object: "leads", label: "Current ERP", type: "picklist", options: ["QuickBooks", "Sage", "Xero"] });
    await as(boss).post("/api/fields", { object: "leads", label: "Locations", type: "number" });
    await as(boss).post("/api/fields", { object: "leads", label: "Modules", type: "multipicklist", options: ["GL", "AP", "AR"] });
    const lead = (who: Ctx, first: string, custom: object, extra: object = {}) =>
      as(who).post("/api/leads", { firstName: first, lastName: "Builder", email: `${first}@builder.example`, company: `${first} Co`, custom, ...extra });
    await lead(seller, "ann", { currentErp: "QuickBooks", locations: 3, modules: ["GL"] });
    await lead(seller, "bob", { currentErp: "Sage", locations: 12, modules: ["AP", "AR"] }, { status: "Prospecting" });
    await lead(seller2, "cat", { currentErp: "QuickBooks", locations: 40 });
    const converted = (await lead(seller2, "dan", { currentErp: "Xero" })).body;
    const account = (await as(seller).post("/api/accounts", { name: "Builder Co" })).body;
    await as(seller2).post(`/api/leads/${converted.id}/convert`, { accountId: account.id });
    const opp = (who: Ctx, name: string, amount: number, status: string, closeDate: string) =>
      as(who).post("/api/opportunities", { name, accountId: account.id, amount, status, closeDate });
    await opp(seller, "O1", 1000, "Proposal", "2026-11-05");
    await opp(seller, "O2", 3000, "Proposal", "2026-11-20");
    await opp(seller2, "O3", 500, "Prospecting", "2026-12-01");
    await opp(seller2, "O4", 2500, "Closed Won", "2026-12-15");
  });

  it("lists matching records with the chosen columns, leaving out converted leads", async () => {
    const r = await rows({ object: "leads", columns: ["name", "company", "custom.currentErp", "custom.modules", "ownerId"], sort: { column: "name", dir: "asc" } });
    expect(r.columns.map((c) => c.label)).toEqual(["Name", "Company", "Current ERP", "Modules", "Owner"]);
    expect(r.rows).toEqual([
      ["ann Builder", "ann Co", "QuickBooks", "GL", "Sal Seller"],
      ["bob Builder", "bob Co", "Sage", "AP; AR", "Sal Seller"],
      ["cat Builder", "cat Co", "QuickBooks", null, "Sue Seller"],
    ]);
    expect(r.total).toBe(3);
    const withConverted = await rows({ object: "leads", columns: ["name"], filters: [{ field: "converted", op: "isTrue" }] });
    expect(withConverted.rows).toEqual([["dan Builder"]]);
  });

  it("keeps columns apart when two fields share a name", async () => {
    const r = await rows({ object: "opportunities", columns: ["name", "account", "amount"], sort: { column: "name", dir: "asc" } });
    expect(r.rows[0]).toEqual(["O1", "Builder Co", "1000.00"]);
  });

  it("filters on every kind of field", async () => {
    const names = async (filters: object[]) =>
      (await rows({ object: "leads", columns: ["firstName"], filters, sort: { column: "firstName", dir: "asc" } })).rows.map((r) => r[0]);
    expect(await names([{ field: "custom.currentErp", op: "in", value: ["QuickBooks"] }])).toEqual(["ann", "cat"]);
    expect(await names([{ field: "custom.locations", op: "gte", value: "12" }])).toEqual(["bob", "cat"]);
    expect(await names([{ field: "custom.modules", op: "includesAny", value: ["AR", "GL"] }])).toEqual(["ann", "bob"]);
    expect(await names([{ field: "custom.modules", op: "empty" }])).toEqual(["cat"]);
    expect(await names([{ field: "status", op: "notIn", value: ["New"] }])).toEqual(["bob"]);
    expect(await names([{ field: "company", op: "contains", value: "AN" }])).toEqual(["ann"]);
    expect(await names([{ field: "createdAt", op: "within", value: "thisMonth" }])).toEqual(["ann", "bob", "cat"]);
    expect(await names([{ field: "createdAt", op: "within", value: "lastYear" }])).toEqual([]);
    expect(await names([{ field: "ownerId", op: "in", value: [seller2.userId] }])).toEqual(["cat"]);
    expect(await names([{ field: "company", op: "contains", value: "'; drop table leads; --" }])).toEqual([]);
    // "me" is whoever runs it.
    const mine = await rows({ object: "leads", columns: ["firstName"], filters: [{ field: "ownerId", op: "in", value: ["me"] }] }, seller);
    expect(mine.total).toBe(2);
  });

  it("groups and totals", async () => {
    const byStage = await rows({
      object: "opportunities",
      groupBy: [{ field: "status" }],
      measures: [{ fn: "count" }, { fn: "sum", field: "amount" }, { fn: "avg", field: "amount" }],
    });
    expect(byStage.columns.map((c) => c.label)).toEqual(["Stage", "Record Count", "Sum of Amount", "Average of Amount"]);
    expect(byStage.rows.map((r) => [r[0], r[1], Number(r[2]), Number(r[3])])).toEqual([
      ["Closed Won", 1, 2500, 2500],
      ["Proposal", 2, 4000, 2000],
      ["Prospecting", 1, 500, 500],
    ]);
    const byMonthAndRep = await rows({
      object: "opportunities",
      groupBy: [{ field: "closeDate", by: "month" }, { field: "ownerId" }],
      measures: [{ fn: "sum", field: "amount" }],
    });
    expect(byMonthAndRep.rows.map((r) => [r[0], r[1], Number(r[2])])).toEqual([
      ["2026-11", "Sal Seller", 4000],
      ["2026-12", "Sue Seller", 3000],
    ]);
    const outcome = await rows({ object: "opportunities", groupBy: [{ field: "outcome" }], sort: { column: "count", dir: "desc" } });
    expect(outcome.rows).toEqual([["Open", 3], ["Won", 1]]);
    const erp = await rows({ object: "leads", groupBy: [{ field: "custom.currentErp" }], measures: [{ fn: "sum", field: "custom.locations" }] });
    expect(erp.rows.map((r) => [r[0], Number(r[1])])).toEqual([["QuickBooks", 43], ["Sage", 12]]);
  });

  it("refuses fields and filters it doesn't know", async () => {
    expect((await run(boss, { object: "leads", columns: ["password"] })).status).toBe(400);
    expect((await run(boss, { object: "leads", groupBy: [{ field: "status" }], measures: [{ fn: "sum", field: "company" }] })).status).toBe(400);
    expect((await run(boss, { object: "leads", filters: [{ field: "company", op: "contains" }] })).status).toBe(400);
    expect((await run(boss, { object: "users" })).status).toBe(400);
    const fields = (await as(watcher).get("/api/reports/fields")).body.fields;
    expect(fields.leads.map((f: { key: string }) => f.key)).toContain("custom.currentErp");
    expect(fields.opportunities.find((f: { key: string }) => f.key === "status").options).toContain("Closed Won");
  });

  it("saves reports privately or shared, and guards who may change them", async () => {
    const definition = { object: "opportunities", groupBy: [{ field: "status" }] };
    expect((await as(watcher).post("/api/reports/saved", { name: "Nope", definition })).status).toBe(403);
    const mineOnly = (await as(seller).post("/api/reports/saved", { name: "My pipeline", definition })).body;
    const shared = (await as(seller).post("/api/reports/saved", { name: "Team pipeline", definition, shared: true })).body;
    expect((await as(seller2).get(`/api/reports/saved/${mineOnly.id}`)).status).toBe(404);
    const seen = (await as(seller2).get("/api/reports/saved")).body.map((r: { name: string }) => r.name);
    expect(seen).toEqual(["Team pipeline"]);
    expect((await as(seller2).get(`/api/reports/saved/${shared.id}`)).body).toMatchObject({ name: "Team pipeline", canEdit: false });
    expect((await as(seller2).patch(`/api/reports/saved/${shared.id}`, { name: "Mine now" })).status).toBe(403);
    expect((await as(mgr).patch(`/api/reports/saved/${shared.id}`, { name: "Team pipeline (Q4)" })).status).toBe(204);
    expect((await as(seller).patch(`/api/reports/saved/${mineOnly.id}`, { definition: { object: "nope" } })).status).toBe(400);
    expect((await as(seller).del(`/api/reports/saved/${mineOnly.id}`)).status).toBe(204);
    expect((await as(seller).get("/api/reports/saved")).body.map((r: { name: string }) => r.name)).toEqual(["Team pipeline (Q4)"]);
    expect((await as(outsider).get(`/api/reports/saved/${shared.id}`)).status).toBe(404);
  });

  it("downloads every row only for roles allowed to export", async () => {
    const definition = { object: "leads", columns: ["name"] };
    expect((await run(seller, definition, { export: true })).status).toBe(403);
    expect((await run(mgr, definition, { export: true })).status).toBe(200);
    expect((await run(watcher, definition)).status).toBe(200);
  });
});

describe("list paging, sorting, filters and bulk changes", () => {
  let boss: Ctx;
  let mgr: Ctx;
  let seller: Ctx;
  let seller2: Ctx;
  const names = (rows: { firstName: string }[]) => rows.map((r) => r.firstName);

  beforeAll(async () => {
    boss = await createOrg(db);
    mgr = await addMember(db, boss.orgId, "manager", "Mo Manager");
    seller = await addMember(db, boss.orgId, "rep", "Sal Seller");
    seller2 = await addMember(db, boss.orgId, "rep", "Sue Seller");
    await as(boss).post("/api/fields", { object: "leads", label: "Locations", type: "number" });
    const rows = ["Ava", "Ben", "Cal", "Dee", "Eli", "Fay", "Gus"].map((n, i) => ({
      firstName: n,
      lastName: `L${i}`,
      email: `${n.toLowerCase()}@lists.example`,
      "custom.locations": String([5, 40, 3, 12, 100, 7, 9][i]),
    }));
    await as(seller).post("/api/import/leads", { rows: rows.slice(0, 4) });
    await as(seller2).post("/api/import/leads", { rows: rows.slice(4) });
    const all = (await as(boss).get("/api/leads?q=lists.example")).body;
    const id = (n: string) => all.find((l: { firstName: string }) => l.firstName === n).id;
    await as(seller).patch(`/api/leads/${id("Ben")}`, { status: "Prospecting" });
    await as(seller2).patch(`/api/leads/${id("Fay")}`, { status: "Active" });
  });

  it("pages through a list with a total", async () => {
    const page = (await as(boss).get("/api/leads?q=lists.example&withTotal=1&limit=3&offset=3&sort=name")).body;
    expect(page.total).toBe(7);
    expect(names(page.rows)).toEqual(["Dee", "Eli", "Fay"]);
    const plain = (await as(boss).get("/api/leads?q=lists.example&limit=2")).body;
    expect(Array.isArray(plain)).toBe(true);
  });

  it("sorts by a column or a custom field, either way", async () => {
    const byName = (await as(boss).get("/api/leads?q=lists.example&sort=name&dir=desc")).body;
    expect(names(byName).slice(0, 2)).toEqual(["Gus", "Fay"]);
    const byLocations = (await as(boss).get("/api/leads?q=lists.example&sort=custom.locations&dir=desc")).body;
    expect(names(byLocations).slice(0, 3)).toEqual(["Eli", "Ben", "Dee"]); // 100, 40, 12: numbers, not text
    const byOwner = (await as(boss).get("/api/leads?q=lists.example&sort=owner")).body;
    expect(byOwner[0].ownerId).toBe(seller.userId);
    expect((await as(boss).get("/api/leads?sort=password")).status).toBe(400);
  });

  it("filters by owner and status", async () => {
    const mine = (await as(seller2).get("/api/leads?q=lists.example&owner=me&withTotal=1")).body;
    expect(mine.total).toBe(3);
    const both = (await as(boss).get(`/api/leads?q=lists.example&owner=${seller.userId},${seller2.userId}&withTotal=1`)).body;
    expect(both.total).toBe(7);
    const statuses = (await as(boss).get("/api/leads?q=lists.example&status=Prospecting&status=Active&sort=name")).body;
    expect(names(statuses)).toEqual(["Ben", "Fay"]);
    const one = (await as(boss).get("/api/leads?q=lists.example&status=Prospecting")).body;
    expect(names(one)).toEqual(["Ben"]);
    expect((await as(boss).get("/api/leads?owner=not-a-user")).status).toBe(400);
  });

  it("changes many at once, record by record, within each role's rights", async () => {
    const all = (await as(boss).get("/api/leads?q=lists.example&sort=name")).body;
    const ids = all.map((l: { id: string }) => l.id);
    const foreign = (await as(outsider).post("/api/leads", { firstName: "X", lastName: "Y", email: "xy@lists-other.example" })).body.id;

    const status = await as(seller).post("/api/leads/bulk", { ids: [...ids.slice(0, 3), foreign], action: "update", patch: { status: "Active" } });
    expect(status.body).toEqual({ done: 3, skipped: [{ id: foreign, reason: "No longer exists" }] });
    expect(names((await as(boss).get("/api/leads?q=lists.example&status=Active&sort=name")).body)).toEqual(["Ava", "Ben", "Cal", "Fay"]);
    const history = (await as(boss).get(`/api/history/lead/${ids[0]}`)).body;
    expect(history[0]).toMatchObject({ field: "status", newValue: "Active", userId: seller.userId });

    const bad = await as(seller).post("/api/leads/bulk", { ids: ids.slice(0, 2), action: "update", patch: { status: "Nope" } });
    expect(bad.body.done).toBe(0);
    expect(bad.body.skipped[0].reason).toMatch(/not one of your/);

    // Reassigning and deleting take more than a rep has.
    expect((await as(seller).post("/api/leads/bulk", { ids, action: "update", patch: { ownerId: seller.userId } })).status).toBe(403);
    expect((await as(seller).post("/api/leads/bulk", { ids, action: "delete" })).status).toBe(403);
    const moved = await as(mgr).post("/api/leads/bulk", { ids: ids.slice(4), action: "update", patch: { ownerId: seller.userId } });
    expect(moved.body).toEqual({ done: 3, skipped: [] });
    const gone = await as(mgr).post("/api/leads/bulk", { ids: ids.slice(5), action: "delete" });
    expect(gone.body.done).toBe(2);
    expect((await as(boss).get("/api/leads?q=lists.example&withTotal=1")).body.total).toBe(5);
    expect((await as(mgr).post("/api/leads/bulk", { ids: [], action: "delete" })).status).toBe(400);
    expect((await as(mgr).post("/api/leads/bulk", { ids, action: "update", patch: {} })).status).toBe(400);
  });
});

describe("to-dos", () => {
  let boss: Ctx;
  let seller: Ctx;
  let seller2: Ctx;
  let watcher: Ctx;
  let account: { id: string };
  let contact: { id: string };
  const today = localDate(new Date(), "America/Chicago");
  const shift = (days: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    boss = await createOrg(db, { waitDayMode: "calendar" });
    seller = await addMember(db, boss.orgId, "rep", "Sal Seller");
    seller2 = await addMember(db, boss.orgId, "rep", "Sue Seller");
    watcher = await addMember(db, boss.orgId, "read_only", "Wes Watcher");
    account = (await as(seller).post("/api/accounts", { name: "Todo Co" })).body;
    contact = (await as(seller).post("/api/contacts", { firstName: "Tia", lastName: "Todo", email: "tia@todo.example", accountId: account.id })).body;
  });

  it("makes to-dos about a record, files them under its account, and lists what is due", async () => {
    const call = await as(seller).post("/api/todos", { title: "Call Tia back", type: "call", dueOn: today, contactId: contact.id });
    expect(call.status).toBe(201);
    expect(call.body).toMatchObject({ ownerId: seller.userId, accountId: account.id, state: "open" });
    await as(seller).post("/api/todos", { title: "Overdue thing", dueOn: shift(-2) });
    await as(seller).post("/api/todos", { title: "Next week", dueOn: shift(7), accountId: account.id });
    await as(seller).post("/api/todos", { title: "For Sue", dueOn: today, ownerId: seller2.userId });

    const due = (await as(seller).get("/api/todos?show=due")).body;
    expect(due.map((t: { title: string }) => t.title)).toEqual(["Overdue thing", "Call Tia back"]);
    expect(due[1]).toMatchObject({ personName: "Tia Todo", accountName: "Todo Co" });
    expect((await as(seller).get("/api/todos?show=open")).body).toHaveLength(3);
    const onAccount = (await as(seller2).get(`/api/todos?accountId=${account.id}`)).body;
    expect(onAccount.map((t: { title: string }) => t.title)).toEqual(["Call Tia back", "Next week"]);
    expect((await as(seller2).get("/api/todos?show=due")).body.map((t: { title: string }) => t.title)).toEqual(["For Sue"]);
    // A rep sees only their own list; a manager or admin can look at another's.
    expect((await as(seller2).get(`/api/todos?owner=${seller.userId}`)).status).toBe(403);
    expect((await as(boss).get(`/api/todos?owner=${seller.userId}&show=due`)).body).toHaveLength(2);

    const dash = (await as(seller).get("/api/dashboard")).body;
    expect(dash.todos).toEqual({ dueToday: 1, overdue: 1 });

    const bad = (body: object) => as(seller).post("/api/todos", { title: "x", dueOn: today, ...body });
    expect((await bad({ dueOn: "tomorrow" })).status).toBe(400);
    expect((await bad({ title: "" })).status).toBe(400);
    expect((await bad({ ownerId: outsider.userId })).status).toBe(400);
    const foreign = (await as(outsider).post("/api/accounts", { name: "Foreign Todo" })).body;
    expect((await bad({ accountId: foreign.id })).status).toBe(400);
    expect((await as(watcher).post("/api/todos", { title: "x", dueOn: today })).status).toBe(403);
  });

  it("logs the activity when a call to-do is done, and can be reopened", async () => {
    const todo = (await as(seller).post("/api/todos", { title: "Discovery call", type: "call", dueOn: today, contactId: contact.id, notes: "Ask about ERP" })).body;
    const done = await as(seller).post(`/api/todos/${todo.id}/complete`, { note: "Booked a demo" });
    expect(done.body).toMatchObject({ state: "done", doneBy: seller.userId });
    const timeline = (await as(seller).get(`/api/activities?contactId=${contact.id}`)).body;
    expect(timeline[0]).toMatchObject({ type: "call", subject: "Discovery call", body: "Ask about ERP\n\nBooked a demo" });
    expect((await as(seller).post(`/api/todos/${todo.id}/complete`, {})).status).toBe(400);
    expect((await as(seller).post(`/api/todos/${todo.id}/reopen`)).body.state).toBe("open");
    // A plain to-do logs nothing.
    const plain = (await as(seller).post("/api/todos", { title: "Send proposal", dueOn: today, contactId: contact.id })).body;
    await as(seller).post(`/api/todos/${plain.id}/complete`, {});
    expect((await as(seller).get(`/api/activities?contactId=${contact.id}`)).body).toHaveLength(1);
  });

  it("lets people reschedule and reassign, and guards deleting", async () => {
    const todo = (await as(seller).post("/api/todos", { title: "Move me", dueOn: today })).body;
    const moved = await as(seller).patch(`/api/todos/${todo.id}`, { dueOn: shift(3), ownerId: seller2.userId });
    expect(moved.body).toMatchObject({ dueOn: shift(3), ownerId: seller2.userId });
    const history = (await as(boss).get(`/api/history/todo/${todo.id}`)).body;
    expect(history.map((h: { field: string }) => h.field).sort()).toEqual(["dueOn", "ownerId", null].sort());
    // The person who made it, or whoever it is for, may delete it; another rep may not.
    const third = await addMember(db, boss.orgId, "rep", "Tom Third");
    expect((await as(third).del(`/api/todos/${todo.id}`)).status).toBe(403);
    expect((await as(seller).del(`/api/todos/${todo.id}`)).status).toBe(204);
    expect((await as(outsider).patch(`/api/todos/${todo.id}`, { title: "x" })).status).toBe(404);
  });

  it("moves a lead's to-dos to the contact on conversion", async () => {
    const lead = (await as(seller).post("/api/leads", { firstName: "Lu", lastName: "Todo", email: "lu@todo.example" })).body;
    await as(seller).post("/api/todos", { title: "Follow up with Lu", dueOn: today, leadId: lead.id });
    const converted = (await as(seller).post(`/api/leads/${lead.id}/convert`, { accountId: account.id })).body;
    const onContact = (await as(seller).get(`/api/todos?contactId=${converted.contactId}`)).body;
    expect(onContact.map((t: { title: string }) => t.title)).toEqual(["Follow up with Lu"]);
    expect((await as(seller).post("/api/todos", { title: "x", dueOn: today, leadId: lead.id })).status).toBe(400);
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
