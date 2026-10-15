import { and, eq } from "drizzle-orm";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveActor } from "../server/auth/actor";
import type { Ctx, Db } from "../server/db/types";
import { createApp } from "../server/http/app";
import { IntegrationKey } from "../server/integrations/crypto";
import { DemoCrm } from "../server/integrations/demo-crm";
import { feedHead, readFeed } from "../server/integrations/feed";
import { integrationJobs, scheduleSyncs } from "../server/integrations/jobs";
import type { IntegrationsConfig } from "../server/integrations/sync";
import { enqueue, PermanentJobError, RetryLaterError, runDueJobs } from "../server/jobs/queue";
import { accountService, contactService, leadService } from "../server/records";
import * as s from "../shared/schema";
import { addMember, createOrg, createTestDb } from "./helpers";

let db: Db;
let app: ReturnType<typeof createApp>;
let demo: DemoCrm;
const key = IntegrationKey.generate();
const config: IntegrationsConfig = { key, providers: {} };

const as = (who: Ctx) => ({
  get: (url: string) => request(app).get(url).set("x-user", who.userId).set("x-org", who.orgId),
  post: (url: string, body?: object) =>
    request(app).post(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
  patch: (url: string, body?: object) =>
    request(app).patch(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
  delete: (url: string) =>
    request(app).delete(url).set("x-user", who.userId).set("x-org", who.orgId),
});
const work = () => runDueJobs(db, integrationJobs(config), 20);

/** Connect the demo CRM the way an admin would, through its sign-in page. */
async function connect(admin: Ctx) {
  const start = await as(admin).post("/api/integrations/demo/connect");
  expect(start.status).toBe(200);
  const back = new URL(start.body.url);
  expect(back.pathname).toBe("/integrations/callback");
  const done = await as(admin).post("/api/integrations/callback", {
    code: back.searchParams.get("code"),
    state: back.searchParams.get("state"),
  });
  expect(done.status).toBe(200);
  return done.body.id as string;
}
const runsOf = (connectionId: string) =>
  db.select().from(s.syncRuns).where(eq(s.syncRuns.connectionId, connectionId));

beforeAll(async () => {
  db = await createTestDb();
  app = createApp(
    db,
    async (req) => {
      const userId = req.header("x-user");
      const orgId = req.header("x-org");
      return userId && orgId ? resolveActor(db, { userId, orgId }) : null;
    },
    { integrations: config },
  );
});
beforeEach(() => {
  demo = new DemoCrm();
  config.providers = { demo };
});

describe("the change feed", () => {
  it("has one entry per record per transaction, from whatever wrote history", async () => {
    const admin = await createOrg(db);
    const actor = (await resolveActor(db, admin))!;
    const start = await feedHead(db);
    const lead = await leadService.create(db, actor, {
      firstName: "Fay",
      lastName: "Feed",
      email: "fay@feed.example",
    });
    await leadService.update(db, actor, lead.id, { title: "CFO", cellPhone: "312 555 0100" });
    await leadService.remove(db, actor, lead.id);
    const { rows, position } = await readFeed(db, admin.orgId, start);
    expect(rows.map((r) => [r.recordType, r.action, r.source])).toEqual([
      ["lead", "create", "user"],
      ["lead", "update", "user"], // two fields, one entry
      ["lead", "delete", "user"],
    ]);
    // Reading on from there finds nothing new, and other organizations' changes never show.
    const other = await createOrg(db);
    await leadService.create(db, (await resolveActor(db, other))!, {
      firstName: "Oz",
      lastName: "Other",
      email: "oz@other.example",
    });
    expect((await readFeed(db, admin.orgId, position)).rows).toEqual([]);
  });
});

describe("the job queue", () => {
  it("runs once per key, retries with growing waits, and gives up in the end", async () => {
    let calls = 0;
    const handlers = {
      flaky: async () => {
        calls += 1;
        throw new Error("down");
      },
      ok: async () => {
        calls += 100;
      },
      broken: async () => {
        throw new PermanentJobError("never going to work");
      },
      later: async () => {
        throw new RetryLaterError("slow down", 120);
      },
    };
    expect((await enqueue(db, { kind: "ok", dedupeKey: "k1" })).queued).toBe(true);
    expect((await enqueue(db, { kind: "ok", dedupeKey: "k1" })).queued).toBe(false);
    await runDueJobs(db, handlers);
    expect(calls).toBe(100);
    expect((await enqueue(db, { kind: "ok", dedupeKey: "k1" })).queued).toBe(true); // done frees the key
    await runDueJobs(db, handlers);

    const { id } = await enqueue(db, { kind: "flaky", maxAttempts: 2 });
    await runDueJobs(db, handlers);
    let [job] = await db.select().from(s.jobs).where(eq(s.jobs.id, id!));
    expect(job).toMatchObject({ status: "queued", attempts: 1, lastError: "down" });
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    await db.update(s.jobs).set({ runAt: new Date() }).where(eq(s.jobs.id, id!));
    await runDueJobs(db, handlers);
    [job] = await db.select().from(s.jobs).where(eq(s.jobs.id, id!));
    expect(job).toMatchObject({ status: "failed", attempts: 2 });

    const broken = await enqueue(db, { kind: "broken" });
    const later = await enqueue(db, { kind: "later" });
    await runDueJobs(db, handlers);
    const [b] = await db.select().from(s.jobs).where(eq(s.jobs.id, broken.id!));
    const [l] = await db.select().from(s.jobs).where(eq(s.jobs.id, later.id!));
    expect(b.status).toBe("failed");
    expect(l.status).toBe("queued");
    expect(l.runAt.getTime()).toBeGreaterThan(Date.now() + 100_000);
    await db.delete(s.jobs);
  });
});

describe("keeping credentials secret", () => {
  it("seals and signs with the key, and nothing else opens them", () => {
    const sealed = key.seal({ accessToken: "secret-token" });
    expect(sealed).not.toContain("secret-token");
    expect(key.open(sealed)).toEqual({ accessToken: "secret-token" });
    expect(() => IntegrationKey.generate().open(sealed)).toThrow();
    const state = key.signState({ o: "org" });
    expect(key.readState(state)).toEqual({ o: "org" });
    expect(key.readState(`${state}x`)).toBeNull();
    expect(IntegrationKey.generate().readState(state)).toBeNull();
    expect(() => IntegrationKey.fromSecret("too-short")).toThrow();
    // Any long random secret works, and the same secret always gives the same key.
    const long = "x9Kq2LmZ7vB4nR8tY1wE5uI3oP6aS0dF";
    expect(IntegrationKey.fromSecret(long).open(IntegrationKey.fromSecret(long).seal(1))).toBe(1);
  });
});

describe("connecting a service", () => {
  it("is for admins, comes back only to who started it, and stores credentials sealed", async () => {
    const admin = await createOrg(db);
    const rep = await addMember(db, admin.orgId, "rep", "Ray Rep");
    expect((await as(rep).get("/api/integrations")).status).toBe(403);
    expect((await as(rep).post("/api/integrations/demo/connect")).status).toBe(403);

    const list = (await as(admin).get("/api/integrations")).body;
    expect(list.enabled).toBe(true);
    expect(list.services.find((x: { id: string }) => x.id === "hubspot")).toMatchObject({
      available: false,
      connection: null,
    });
    expect(list.services.find((x: { id: string }) => x.id === "demo").available).toBe(true);

    // A state from someone else, or tampered with, is refused.
    const start = await as(admin).post("/api/integrations/demo/connect");
    const state = new URL(start.body.url).searchParams.get("state")!;
    const otherAdmin = await addMember(db, admin.orgId, "admin", "Other Admin");
    expect(
      (await as(otherAdmin).post("/api/integrations/callback", { code: "demo-code", state }))
        .status,
    ).toBe(400);
    expect(
      (
        await as(admin).post("/api/integrations/callback", {
          code: "demo-code",
          state: `${state}x`,
        })
      ).status,
    ).toBe(400);

    const id = await connect(admin);
    const [row] = await db
      .select()
      .from(s.integrationConnections)
      .where(eq(s.integrationConnections.id, id));
    expect(row.credentials).not.toContain("demo-token");
    const after = (await as(admin).get("/api/integrations")).body;
    const conn = after.services.find((x: { id: string }) => x.id === "demo").connection;
    expect(conn).toMatchObject({
      status: "connected",
      accountLabel: "Demo CRM sandbox",
      connectedBy: "Admin",
    });
    expect(JSON.stringify(after)).not.toContain("demo-token");
    // Connecting queues the first sync.
    const queued = await db
      .select()
      .from(s.jobs)
      .where(and(eq(s.jobs.kind, "integration.sync"), eq(s.jobs.status, "queued")));
    expect(queued.some((j) => j.payload.connectionId === id)).toBe(true);
    await work();
  });
});

describe("syncing", () => {
  it("pulls, matches, creates and sends back, without echoes or duplicates", async () => {
    const admin = await createOrg(db);
    const actor = (await resolveActor(db, admin))!;
    // Already in Bagger: Acme (matches by name) with Dan (matches by email); Beta is Bagger-only.
    const acme = await accountService.create(db, actor, { name: "Acme", website: "acme.example" });
    const dan = await contactService.create(db, actor, {
      firstName: "Dan",
      lastName: "Smith",
      email: "dan@acme.example",
      accountId: acme.id,
    });
    const beta = await accountService.create(db, actor, { name: "Beta Corp" });
    await contactService.create(db, actor, {
      firstName: "Bea",
      lastName: "Bagger",
      email: "bea@beta.example",
      accountId: beta.id,
    });
    // In the CRM: Acme with Dan (new title) and Cy, and Zed with no company.
    const coAcme = demo.put("companies", { name: "Acme", domain: "acme.example", phone: null });
    demo.put("contacts", {
      firstname: "Dan",
      lastname: "Smith",
      email: "dan@acme.example",
      jobtitle: "VP Sales",
      companyId: coAcme.id,
    });
    demo.put("contacts", {
      firstname: "Cy",
      lastname: "Crm",
      email: "cy@acme.example",
      jobtitle: null,
      companyId: coAcme.id,
    });
    demo.put("contacts", { firstname: "Zed", lastname: "Nocompany", email: "zed@x.example" });

    const id = await connect(admin);
    await work();

    const [run] = await runsOf(id);
    expect(run.status).toBe("done");
    expect(run.counts).toMatchObject({
      pulled: { account: { matched: 1 }, contact: { updated: 1, created: 1 } },
      pushed: { account: { created: 1 }, contact: { created: 1 } },
    });
    expect(run.errors).toEqual([
      expect.objectContaining({
        object: "contact",
        message: expect.stringContaining("no company"),
      }),
    ]);
    // Dan was matched, not duplicated, and took the CRM's title; History says where it came from.
    const [danNow] = await db.select().from(s.contacts).where(eq(s.contacts.id, dan.id));
    expect(danNow.title).toBe("VP Sales");
    const danHistory = await db
      .select()
      .from(s.fieldHistory)
      .where(and(eq(s.fieldHistory.recordId, dan.id), eq(s.fieldHistory.field, "title")));
    expect(danHistory[0]).toMatchObject({
      source: "integration",
      via: "Demo CRM",
      newValue: "VP Sales",
    });
    const cys = await db.select().from(s.contacts).where(eq(s.contacts.email, "cy@acme.example"));
    expect(cys).toHaveLength(1);
    expect(cys[0].accountId).toBe(acme.id);
    // Beta and Bea went to the CRM, Bea under Beta's company.
    const coBeta = demo.find("companies", "name", "Beta Corp")!;
    expect(demo.find("contacts", "email", "bea@beta.example")?.fields.companyId).toBe(coBeta.id);
    // Nothing that came in was sent back out.
    expect(demo.calls.update).toBe(0);
    expect(demo.calls.create).toBe(2);

    // A second sync with nothing new changes nothing.
    await as(admin).post(`/api/integrations/connections/${id}/sync`);
    await work();
    expect(demo.calls.create + demo.calls.update).toBe(2);
    const contactsNow = await db.select().from(s.contacts).where(eq(s.contacts.orgId, admin.orgId));
    expect(contactsNow).toHaveLength(3);

    // A change in Bagger goes out; a change in the CRM comes in.
    await contactService.update(db, actor, dan.id, { title: "Chief Revenue Officer" });
    const crmCy = demo.find("contacts", "email", "cy@acme.example")!;
    demo.put("contacts", { jobtitle: "Buyer" }, crmCy.id);
    await as(admin).post(`/api/integrations/connections/${id}/sync`);
    await work();
    expect(demo.find("contacts", "email", "dan@acme.example")?.fields.jobtitle).toBe(
      "Chief Revenue Officer",
    );
    const [cyNow] = await db.select().from(s.contacts).where(eq(s.contacts.id, cys[0].id));
    expect(cyNow.title).toBe("Buyer");
    expect(demo.calls.update).toBe(1); // Dan only; Cy's change didn't bounce back
  });

  it("lets the more recent change win when both sides changed", async () => {
    const admin = await createOrg(db);
    const actor = (await resolveActor(db, admin))!;
    const co = demo.put("companies", { name: "Gamma" });
    const ct = demo.put("contacts", {
      firstname: "Gil",
      lastname: "Both",
      email: "gil@gamma.example",
      jobtitle: "Old",
      companyId: co.id,
    });
    const id = await connect(admin);
    await work();
    const [gil] = await db
      .select()
      .from(s.contacts)
      .where(eq(s.contacts.email, "gil@gamma.example"));

    demo.put("contacts", { jobtitle: "From CRM" }, ct.id); // first
    await new Promise((r) => setTimeout(r, 5));
    await contactService.update(db, actor, gil.id, { title: "From Bagger" }); // then, later
    await as(admin).post(`/api/integrations/connections/${id}/sync`);
    await work();
    const [gilNow] = await db.select().from(s.contacts).where(eq(s.contacts.id, gil.id));
    expect(gilNow.title).toBe("From Bagger");
    expect(demo.store.contacts.get(ct.id)?.fields.jobtitle).toBe("From Bagger");
  });

  it("follows each kind of record's direction", async () => {
    const admin = await createOrg(db);
    const actor = (await resolveActor(db, admin))!;
    const id = await connect(admin);
    await work();
    await as(admin).patch(`/api/integrations/connections/${id}`, {
      objects: { contact: "pull", account: "off" },
    });
    const acc = await accountService.create(db, actor, { name: "Delta" });
    await contactService.create(db, actor, {
      firstName: "Di",
      lastName: "Direction",
      email: "di@delta.example",
      accountId: acc.id,
    });
    demo.put("companies", { name: "Epsilon" });
    await as(admin).post(`/api/integrations/connections/${id}/sync`);
    await work();
    expect(demo.find("companies", "name", "Delta")).toBeUndefined();
    expect(demo.find("contacts", "email", "di@delta.example")).toBeUndefined();
    const eps = await db.select().from(s.accounts).where(eq(s.accounts.name, "Epsilon"));
    expect(eps.filter((a) => a.orgId === admin.orgId)).toEqual([]);
    expect(
      (await as(admin).patch(`/api/integrations/connections/${id}`, { objects: { lead: "both" } }))
        .status,
    ).toBe(400);
  });
});

describe("when the service stops accepting us", () => {
  it("waits for an admin to connect again, then carries on", async () => {
    const admin = await createOrg(db);
    const id = await connect(admin);
    await work();
    demo.revoked = true;
    await db
      .update(s.integrationConnections)
      .set({
        credentials: key.seal({ accessToken: "demo-token-1", expiresAt: 0, refreshToken: "r" }),
      })
      .where(eq(s.integrationConnections.id, id));
    await as(admin).post(`/api/integrations/connections/${id}/sync`);
    await work();
    const list = (await as(admin).get("/api/integrations")).body;
    const conn = list.services.find((x: { id: string }) => x.id === "demo").connection;
    expect(conn).toMatchObject({ status: "error", lastError: "Access was revoked in Demo CRM" });
    const runs = (await as(admin).get(`/api/integrations/connections/${id}/runs`)).body;
    expect(runs[0].status).toBe("failed");
    // No retries pile up, and it isn't scheduled while waiting.
    expect((await as(admin).post(`/api/integrations/connections/${id}/sync`)).status).toBe(400);
    await scheduleSyncs(db, 0);
    const waiting = await db
      .select()
      .from(s.jobs)
      .where(and(eq(s.jobs.status, "queued"), eq(s.jobs.orgId, admin.orgId)));
    expect(waiting).toEqual([]);

    demo.revoked = false;
    expect(await connect(admin)).toBe(id); // the same connection, links kept
    await work();
    const again = (await as(admin).get("/api/integrations")).body;
    expect(again.services.find((x: { id: string }) => x.id === "demo").connection.status).toBe(
      "connected",
    );
  });
});

describe("disconnecting", () => {
  it("forgets the service but keeps the records and their history", async () => {
    const admin = await createOrg(db);
    const co = demo.put("companies", { name: "Zeta" });
    const id = await connect(admin);
    await work();
    const [zeta] = await db
      .select()
      .from(s.accounts)
      .where(and(eq(s.accounts.orgId, admin.orgId), eq(s.accounts.name, "Zeta")));
    expect((await as(admin).delete(`/api/integrations/connections/${id}`)).status).toBe(204);
    expect(
      await db.select().from(s.externalLinks).where(eq(s.externalLinks.connectionId, id)),
    ).toEqual([]);
    expect(zeta).toBeDefined();
    const [created] = await db
      .select()
      .from(s.fieldHistory)
      .where(and(eq(s.fieldHistory.recordId, zeta.id), eq(s.fieldHistory.action, "create")));
    expect(created).toMatchObject({ source: "integration", via: "Demo CRM", connectionId: null });
    expect(co.id).toBeTruthy();
  });
});

describe("showing Integrations in Admin", () => {
  it("only once there's a real service to connect", async () => {
    const admin = await createOrg(db);
    expect((await as(admin).get("/api/me")).body.features).toEqual({ integrations: true });
    const bare = createApp(
      db,
      async (req) =>
        resolveActor(db, { userId: req.header("x-user")!, orgId: req.header("x-org")! }),
      { integrations: { key, providers: {} } },
    );
    const me = await request(bare)
      .get("/api/me")
      .set("x-user", admin.userId)
      .set("x-org", admin.orgId);
    expect(me.body.features).toEqual({ integrations: false });
  });
});
