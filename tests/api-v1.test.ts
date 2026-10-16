import { and, eq } from "drizzle-orm";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveActor } from "../server/auth/actor";
import type { Ctx, Db } from "../server/db/types";
import { createApp } from "../server/http/app";
import { sequenceService } from "../server/records";
import * as seq from "../server/sequences/service";
import * as s from "../shared/schema";
import { addMember, createOrg, createTestDb } from "./helpers";

let db: Db;
let app: ReturnType<typeof createApp>;

const as = (who: Ctx) => ({
  get: (url: string) => request(app).get(url).set("x-user", who.userId).set("x-org", who.orgId),
  post: (url: string, body?: object) =>
    request(app).post(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
  delete: (url: string) =>
    request(app).delete(url).set("x-user", who.userId).set("x-org", who.orgId),
});
/** Calls to the public API with a key, the way another system would. */
const withKey = (key: string) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set("authorization", `Bearer ${key}`),
  post: (url: string, body?: object, headers: Record<string, string> = {}) =>
    request(app)
      .post(`/api/v1${url}`)
      .set("authorization", `Bearer ${key}`)
      .set(headers)
      .send(body),
  patch: (url: string, body?: object) =>
    request(app).patch(`/api/v1${url}`).set("authorization", `Bearer ${key}`).send(body),
  delete: (url: string) =>
    request(app).delete(`/api/v1${url}`).set("authorization", `Bearer ${key}`),
});

async function makeKey(admin: Ctx, name = "Zapier", access = "read_write") {
  const res = await as(admin).post("/api/api-keys", { name, access });
  expect(res.status).toBe(201);
  return res.body.key as string;
}

beforeAll(async () => {
  db = await createTestDb();
  app = createApp(db, async (req) => {
    const userId = req.header("x-user");
    const orgId = req.header("x-org");
    return userId && orgId ? resolveActor(db, { userId, orgId }) : null;
  });
});

describe("API keys", () => {
  it("are made by admins, shown once, and stop working when revoked", async () => {
    const admin = await createOrg(db, { name: "Keys Co" });
    const rep = await addMember(db, admin.orgId, "rep", "Ray Rep");
    expect((await as(rep).post("/api/api-keys", { name: "x", access: "read" })).status).toBe(403);
    expect((await as(rep).get("/api/api-keys")).status).toBe(403);

    const key = await makeKey(admin);
    expect(key).toMatch(/^bgr_[A-Za-z0-9]{10}_[A-Za-z0-9]{40}$/);
    const list = (await as(admin).get("/api/api-keys")).body;
    expect(list[0]).toMatchObject({ name: "Zapier", access: "read_write", createdBy: "Admin" });
    expect(JSON.stringify(list)).not.toContain(key);
    const [stored] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, list[0].id));
    expect(stored.secretHash).not.toContain(key.slice(-40));

    const me = await withKey(key).get("/me");
    expect(me.body).toEqual({
      organization: { id: admin.orgId, name: "Keys Co" },
      key: { name: "Zapier", access: "read_write" },
    });
    expect((await as(admin).get("/api/api-keys")).body[0].lastUsedAt).not.toBeNull();

    expect((await as(admin).delete(`/api/api-keys/${list[0].id}`)).status).toBe(204);
    const after = await withKey(key).get("/me");
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("unauthorized");
  });

  it("refuses missing, malformed and made-up keys in the same way", async () => {
    for (const header of [undefined, "Bearer nope", "Bearer bgr_abc_def", "Basic abc"]) {
      const req = request(app).get("/api/v1/me");
      const res = header ? await req.set("authorization", header) : await req;
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: { code: "unauthorized", message: expect.stringContaining("API key") },
      });
    }
  });

  it("can be read-only", async () => {
    const admin = await createOrg(db);
    const key = await makeKey(admin, "Warehouse", "read");
    expect((await withKey(key).get("/leads")).status).toBe(200);
    const res = await withKey(key).post("/leads", {
      firstName: "A",
      lastName: "B",
      email: "a@b.example",
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("read_only_key");
  });

  it("keep working when the person who made them leaves, as the owner", async () => {
    const owner = await createOrg(db);
    const other = await addMember(db, owner.orgId, "admin", "Ann Admin");
    const key = await makeKey(other);
    await db
      .update(s.memberships)
      .set({ status: "removed" })
      .where(eq(s.memberships.userId, other.userId));
    const res = await withKey(key).post("/accounts", { name: "Left Behind Inc" });
    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe(owner.userId);
  });

  it("stop at a locked account", async () => {
    const admin = await createOrg(db);
    const key = await makeKey(admin);
    await db
      .update(s.organizations)
      .set({ billingStatus: "locked" })
      .where(eq(s.organizations.id, admin.orgId));
    const res = await withKey(key).get("/leads");
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: "account_locked", details: { status: "locked" } });
  });
});

describe("records through the API", () => {
  it("creates, reads, changes and deletes, with the app's rules and History", async () => {
    const admin = await createOrg(db);
    const key = await makeKey(admin);
    const api = withKey(key);

    const bad = await api.post("/leads", { firstName: "No", email: "not-an-email" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_input");
    expect(bad.body.error.details.fields.map((f: { field: string }) => f.field)).toEqual(
      expect.arrayContaining(["lastName", "email"]),
    );

    const made = await api.post("/leads", {
      firstName: "Ada",
      lastName: "Api",
      email: "ADA@Api.example",
      company: "Api Co",
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      firstName: "Ada",
      email: "ada@api.example",
      status: "New",
      ownerId: admin.userId,
      custom: {},
      deletedAt: null,
    });
    expect(Object.keys(made.body)).not.toContain("orgId");

    const dup = await api.post("/leads", {
      firstName: "Ada",
      lastName: "Again",
      email: "ada@api.example",
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({
      code: "duplicate",
      details: { matches: [expect.objectContaining({ id: made.body.id })] },
    });
    expect(
      (
        await api.post("/leads?allowDuplicate=true", {
          firstName: "Ada",
          lastName: "Again",
          email: "ada@api.example",
        })
      ).status,
    ).toBe(201);

    const changed = await api.patch(`/leads/${made.body.id}`, { title: "CTO", status: "Nope" });
    expect(changed.status).toBe(400);
    const ok = await api.patch(`/leads/${made.body.id}`, { title: "CTO" });
    expect(ok.body.title).toBe("CTO");
    expect((await api.get(`/leads/${made.body.id}`)).body.title).toBe("CTO");

    const history = await db
      .select()
      .from(s.fieldHistory)
      .where(and(eq(s.fieldHistory.recordId, made.body.id), eq(s.fieldHistory.field, "title")));
    expect(history[0]).toMatchObject({ source: "api", via: "API: Zapier", userId: admin.userId });

    expect((await api.delete(`/leads/${made.body.id}`)).status).toBe(204);
    expect((await api.get("/leads")).body.data.map((l: { id: string }) => l.id)).not.toContain(
      made.body.id,
    );
    const withDeleted = (await api.get("/leads?includeDeleted=true")).body.data;
    expect(withDeleted.find((l: { id: string }) => l.id === made.body.id).deletedAt).not.toBeNull();

    // Another organization's records don't exist as far as this key knows.
    const other = await createOrg(db);
    const theirs = await withKey(await makeKey(other)).post("/accounts", { name: "Private Co" });
    expect((await api.get(`/accounts/${theirs.body.id}`)).status).toBe(404);
    expect((await api.patch(`/accounts/${theirs.body.id}`, { name: "Mine now" })).status).toBe(404);
    expect((await api.get("/accounts/not-an-id")).status).toBe(404);
    expect((await api.get("/nothing-here")).body.error.code).toBe("not_found");
  });

  it("pages through everything, oldest change first, and picks up only what changed", async () => {
    const admin = await createOrg(db);
    const api = withKey(await makeKey(admin));
    for (let i = 1; i <= 5; i++) await api.post("/accounts", { name: `Paged ${i}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await api.get(`/accounts?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((a: { name: string }) => a.name));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(["Paged 1", "Paged 2", "Paged 3", "Paged 4", "Paged 5"]);

    const all = (await api.get("/accounts")).body.data;
    const since = all[2].updatedAt;
    await api.patch(`/accounts/${all[0].id}`, { notes: "touched" });
    const changed = (await api.get(`/accounts?updatedSince=${encodeURIComponent(since)}`)).body
      .data;
    expect(changed.map((a: { name: string }) => a.name)).toEqual(["Paged 4", "Paged 5", "Paged 1"]);
    expect((await api.get("/accounts?cursor=garbage")).body.error.code).toBe("invalid_cursor");
    expect((await api.get("/accounts?limit=500")).status).toBe(400);
  });

  it("filters, links contacts to accounts, logs activities and enrolls people", async () => {
    const admin = await createOrg(db, { waitDayMode: "calendar" });
    const api = withKey(await makeKey(admin));
    const acme = (await api.post("/accounts", { name: "Acme" })).body;
    const dan = (
      await api.post("/contacts", {
        firstName: "Dan",
        lastName: "Smith",
        email: "dan@acme.example",
        accountId: acme.id,
      })
    ).body;
    await api.post("/contacts", {
      firstName: "Eve",
      lastName: "Other",
      email: "eve@acme.example",
      accountId: acme.id,
    });
    const found = (await api.get("/contacts?email=DAN@acme.example")).body.data;
    expect(found.map((c: { id: string }) => c.id)).toEqual([dan.id]);
    expect((await api.get(`/contacts?accountId=${acme.id}`)).body.data).toHaveLength(2);
    expect((await api.get("/contacts?accountId=nope")).status).toBe(400);

    const opp = await api.post("/opportunities", {
      name: "Big deal",
      accountId: acme.id,
      contactId: dan.id,
      amount: "12,500",
    });
    expect(opp.body).toMatchObject({ amount: 12500, status: expect.any(String) });

    const note = await api.post("/activities", {
      type: "note",
      body: "Called from our dialer",
      contactId: dan.id,
    });
    expect(note.status).toBe(201);
    expect(note.body).toMatchObject({ type: "note", status: "completed", contactId: dan.id });
    expect((await api.get(`/activities?contactId=${dan.id}`)).body.data).toHaveLength(1);

    const actor = (await resolveActor(db, admin))!;
    const sequence = await sequenceService.create(db, actor, { name: "Outbound" });
    await seq.addStep(db, actor, sequence.id, { type: "phone_call", title: "Call" });
    expect((await api.get("/sequences")).body.data[0]).toMatchObject({
      name: "Outbound",
      isActive: true,
    });
    const enrolled = await api.post(`/sequences/${sequence.id}/enrollments`, { contactId: dan.id });
    expect(enrolled.status).toBe(201);
    expect(enrolled.body).toMatchObject({
      sequenceId: sequence.id,
      contactId: dan.id,
      state: "active",
    });
    const twice = await api.post(`/sequences/${sequence.id}/enrollments`, { contactId: dan.id });
    expect(twice.status).toBe(400);

    expect((await api.get("/users")).body.data).toEqual([
      expect.objectContaining({ id: admin.userId, role: "Admin", status: "active" }),
    ]);
    const statuses = (await api.get("/statuses")).body;
    expect(statuses.leads[0]).toMatchObject({ name: "New", isDefault: true });
    expect(Object.keys(statuses)).toEqual(
      expect.arrayContaining(["leads", "contacts", "accounts", "opportunities"]),
    );
    expect((await api.get("/custom-fields")).body).toEqual({ data: [] });
  });
});

describe("safe retries and limits", () => {
  it("does a write with an Idempotency-Key once", async () => {
    const admin = await createOrg(db);
    const api = withKey(await makeKey(admin));
    const body = { name: "Once Only" };
    const first = await api.post("/accounts", body, { "Idempotency-Key": "abc-1" });
    const again = await api.post("/accounts", body, { "Idempotency-Key": "abc-1" });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body.id).toBe(first.body.id);
    const rows = await db
      .select()
      .from(s.accounts)
      .where(and(eq(s.accounts.orgId, admin.orgId), eq(s.accounts.name, "Once Only")));
    expect(rows).toHaveLength(1);
    const clash = await api.post(
      "/accounts",
      { name: "Something else" },
      { "Idempotency-Key": "abc-1" },
    );
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("idempotency_conflict");
    // A request that failed can be sent again with the same key.
    expect((await api.post("/accounts", {}, { "Idempotency-Key": "abc-2" })).status).toBe(400);
    expect((await api.post("/accounts", {}, { "Idempotency-Key": "abc-2" })).status).toBe(400);
  });

  it("allows 120 requests a minute per key", async () => {
    const admin = await createOrg(db);
    const api = withKey(await makeKey(admin, "Busy"));
    let last = await api.get("/me");
    expect(last.headers["x-ratelimit-limit"]).toBe("120");
    for (let i = 0; i < 125 && last.status === 200; i++) last = await api.get("/me");
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe("rate_limited");
    expect(Number(last.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("the API description", () => {
  it("is public, and covers every endpoint", async () => {
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        "/leads",
        "/leads/{id}",
        "/contacts",
        "/accounts/{id}",
        "/opportunities",
        "/activities/{id}",
        "/sequences/{id}/enrollments",
        "/users",
        "/statuses",
        "/custom-fields",
        "/me",
      ]),
    );
    const leadBody = res.body.paths["/leads"].post.requestBody.content["application/json"].schema;
    expect(leadBody.required).toEqual(expect.arrayContaining(["firstName", "lastName", "email"]));
    expect(res.body.components.schemas.Lead.properties.email).toMatchObject({ format: "email" });
  });
});
