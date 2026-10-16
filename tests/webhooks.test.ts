import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveActor } from "../server/auth/actor";
import type { Ctx, Db } from "../server/db/types";
import { createApp } from "../server/http/app";
import { runDueJobs } from "../server/jobs/queue";
import { leadService } from "../server/records";
import { checkWebhookUrl, isPrivateAddress } from "../server/webhooks/send";
import { fanOut, webhookJobs } from "../server/webhooks/service";
import * as s from "../shared/schema";
import { addMember, createOrg, createTestDb } from "./helpers";

let db: Db;
let app: ReturnType<typeof createApp>;
let strictApp: ReturnType<typeof createApp>;
let receiver: http.Server;
let base = "";
let answer = 200;
const received: { headers: http.IncomingHttpHeaders; body: string; path: string }[] = [];

const handlers = webhookJobs({ allowPrivateUrls: true });
/** Turn changes into deliveries and send them, as the server does every few seconds. */
async function pump() {
  await fanOut(db);
  await db.update(s.jobs).set({ runAt: new Date() }).where(eq(s.jobs.status, "queued"));
  while ((await runDueJobs(db, handlers, 50)).ran > 0) {
    // until nothing is due
  }
}
const as = (who: Ctx, on = app) => ({
  get: (url: string) => request(on).get(url).set("x-user", who.userId).set("x-org", who.orgId),
  post: (url: string, body?: object) =>
    request(on).post(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
  patch: (url: string, body?: object) =>
    request(on).patch(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
});

beforeAll(async () => {
  db = await createTestDb();
  const authenticate = async (req: { header: (n: string) => string | undefined }) => {
    const userId = req.header("x-user");
    const orgId = req.header("x-org");
    return userId && orgId ? resolveActor(db, { userId, orgId }) : null;
  };
  app = createApp(db, authenticate, { webhooks: { allowPrivateUrls: true } });
  strictApp = createApp(db, authenticate);
  receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body, path: req.url ?? "" });
      res.statusCode = answer;
      res.end(answer === 200 ? "ok" : "receiver is down");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => receiver.close(() => r())));
beforeEach(() => {
  received.length = 0;
  answer = 200;
});

describe("where webhooks may go", () => {
  it("only to https on the public internet", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "52.1.2.3", "2606:4700::1111"])
      expect(isPrivateAddress(ip)).toBe(false);
    expect(() => checkWebhookUrl("http://hooks.example.com/x", false)).toThrow(/https/);
    expect(() => checkWebhookUrl("https://localhost/x", false)).toThrow(/public/);
    expect(() => checkWebhookUrl("https://169.254.169.254/latest", false)).toThrow(/public/);
    expect(() => checkWebhookUrl("https://user:pw@hooks.example.com", false)).toThrow(
      /credentials/,
    );
    expect(() => checkWebhookUrl("not a url", false)).toThrow(/https/);
    expect(checkWebhookUrl("https://hooks.example.com/bagger", false).hostname).toBe(
      "hooks.example.com",
    );
  });

  it("are refused at the door when they point inside", async () => {
    const admin = await createOrg(db);
    const res = await as(admin, strictApp).post("/api/webhooks", { url: "https://127.0.0.1/hook" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/public internet/);
  });
});

describe("webhooks", () => {
  it("are admins' to set up, and send each matching change, signed", async () => {
    const admin = await createOrg(db);
    const rep = await addMember(db, admin.orgId, "rep", "Ray Rep");
    expect((await as(rep).post("/api/webhooks", { url: `${base}/x` })).status).toBe(403);

    const made = await as(admin).post("/api/webhooks", {
      url: `${base}/all`,
      description: "Everything",
    });
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/^whsec_/);
    const onlyContacts = await as(admin).post("/api/webhooks", {
      url: `${base}/contacts`,
      events: ["contact.created"],
    });
    expect(
      (await as(admin).post("/api/webhooks", { url: `${base}/x`, events: ["lead.exploded"] }))
        .status,
    ).toBe(400);
    const list = (await as(admin).get("/api/webhooks")).body;
    expect(list).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain(made.body.secret);

    const actor = (await resolveActor(db, admin))!;
    const lead = await leadService.create(db, actor, {
      firstName: "Wes",
      lastName: "Hook",
      email: "wes@hook.example",
    });
    await leadService.update(db, actor, lead.id, { title: "COO", cellPhone: "312 555 0100" });
    await pump();

    expect(received.map((r) => r.path)).toEqual(["/all", "/all"]);
    const [created, updated] = received.map((r) => JSON.parse(r.body));
    expect(created).toMatchObject({
      type: "lead.created",
      id: expect.stringMatching(/^evt_/),
      data: { object: { id: lead.id, email: "wes@hook.example", firstName: "Wes" } },
    });
    expect(updated.type).toBe("lead.updated");
    expect(updated.data.changedFields.sort()).toEqual(["cellPhone", "title"]);
    expect(updated.data.object.title).toBe("COO");

    // The signature checks out with the endpoint's secret, the way a receiver would check it.
    const sig = String(received[0].headers["bagger-signature"]);
    const [, t, v1] = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    const expected = createHmac("sha256", made.body.secret)
      .update(`${t}.${received[0].body}`)
      .digest("hex");
    expect(v1).toBe(expected);
    expect(received[0].headers["bagger-event"]).toBe("lead.created");
    expect(received[0].headers["user-agent"]).toBe("Bagger-Webhooks/1");

    // Nothing again on the next round.
    received.length = 0;
    await pump();
    expect(received).toEqual([]);
    const log = (await as(admin).get(`/api/webhooks/${made.body.id}/deliveries`)).body;
    expect(log.map((d: { status: string }) => d.status)).toEqual(["delivered", "delivered"]);
    expect((await as(admin).get(`/api/webhooks/${onlyContacts.body.id}/deliveries`)).body).toEqual(
      [],
    );
    expect((await as(admin).post(`/api/webhooks/${made.body.id}/secret`)).body.secret).toBe(
      made.body.secret,
    );
  });

  it("try again while the receiver is down, then deliver", async () => {
    const admin = await createOrg(db);
    const hook = (await as(admin).post("/api/webhooks", { url: `${base}/flaky` })).body;
    const actor = (await resolveActor(db, admin))!;
    answer = 500;
    await leadService.create(db, actor, {
      firstName: "Di",
      lastName: "Down",
      email: "di@down.example",
    });
    await fanOut(db);
    await runDueJobs(db, handlers, 50);
    let [d] = (await as(admin).get(`/api/webhooks/${hook.id}/deliveries`)).body;
    expect(d).toMatchObject({ status: "pending", attempts: 1, lastStatusCode: 500 });
    expect(d.lastError).toContain("receiver is down");
    expect((await as(admin).get("/api/webhooks")).body[0].failingSince).not.toBeNull();

    answer = 200;
    await pump();
    [d] = (await as(admin).get(`/api/webhooks/${hook.id}/deliveries`)).body;
    expect(d).toMatchObject({ status: "delivered", attempts: 2, lastStatusCode: 200 });
    expect((await as(admin).get("/api/webhooks")).body[0].failingSince).toBeNull();
  });

  it("switch an endpoint off after three days of failing, and start fresh when it's back", async () => {
    const admin = await createOrg(db);
    const hook = (await as(admin).post("/api/webhooks", { url: `${base}/dead` })).body;
    await db
      .update(s.webhookEndpoints)
      .set({ failingSince: new Date(Date.now() - 4 * 86_400_000) })
      .where(eq(s.webhookEndpoints.id, hook.id));
    const actor = (await resolveActor(db, admin))!;
    answer = 503;
    await leadService.create(db, actor, {
      firstName: "Ed",
      lastName: "End",
      email: "ed@end.example",
    });
    await fanOut(db);
    // Its last try.
    await db.update(s.jobs).set({ attempts: 7 }).where(eq(s.jobs.kind, "webhooks.deliver"));
    await pump();
    const [endpoint] = (await as(admin).get("/api/webhooks")).body;
    expect(endpoint.status).toBe("disabled");
    expect(endpoint.disabledReason).toMatch(/failing for 3 days/);
    const [d] = (await as(admin).get(`/api/webhooks/${hook.id}/deliveries`)).body;
    expect(d.status).toBe("failed");

    // Switched off: nothing is sent. Back on: only what happens from then.
    answer = 200;
    received.length = 0;
    await leadService.create(db, actor, {
      firstName: "Mo",
      lastName: "Missed",
      email: "mo@missed.example",
    });
    await pump();
    expect(received).toEqual([]);
    expect(
      (await as(admin).patch(`/api/webhooks/${hook.id}`, { status: "active" })).body.status,
    ).toBe("active");
    await leadService.create(db, actor, {
      firstName: "Al",
      lastName: "After",
      email: "al@after.example",
    });
    await pump();
    expect(received.map((r) => JSON.parse(r.body).data.object.firstName)).toEqual(["Al"]);

    // A failed delivery can be sent again by hand.
    expect((await as(admin).post(`/api/webhook-deliveries/${d.id}/resend`)).status).toBe(204);
    await pump();
    expect(received.map((r) => JSON.parse(r.body).data.object.firstName)).toEqual(["Al", "Ed"]);
  });

  it("send a test ping on request", async () => {
    const admin = await createOrg(db);
    const hook = (await as(admin).post("/api/webhooks", { url: `${base}/ping` })).body;
    expect((await as(admin).post(`/api/webhooks/${hook.id}/test`)).status).toBe(200);
    await pump();
    expect(JSON.parse(received[0].body)).toMatchObject({
      type: "ping",
      data: { message: expect.any(String) },
    });
  });
});

describe("subscribing through the API", () => {
  it("lets a key add and remove its own webhooks", async () => {
    const admin = await createOrg(db);
    const key = async (name: string) =>
      (await as(admin).post("/api/api-keys", { name, access: "read_write" })).body.key as string;
    const zapier = await key("Zapier");
    const other = await key("Other");
    const sub = await request(app)
      .post("/api/v1/webhooks")
      .set("authorization", `Bearer ${zapier}`)
      .send({ url: `${base}/zap`, events: ["contact.created", "lead.created"] });
    expect(sub.status).toBe(201);
    expect(sub.body).toMatchObject({
      events: ["contact.created", "lead.created"],
      secret: expect.stringMatching(/^whsec_/),
    });
    const listed = await request(app)
      .get("/api/v1/webhooks")
      .set("authorization", `Bearer ${zapier}`);
    expect(listed.body.data[0]).not.toHaveProperty("secret");
    expect((await as(admin).get("/api/webhooks")).body[0]).toMatchObject({ viaApi: true });

    expect(
      (
        await request(app)
          .delete(`/api/v1/webhooks/${sub.body.id}`)
          .set("authorization", `Bearer ${other}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .delete(`/api/v1/webhooks/${sub.body.id}`)
          .set("authorization", `Bearer ${zapier}`)
      ).status,
    ).toBe(204);
  });
});
