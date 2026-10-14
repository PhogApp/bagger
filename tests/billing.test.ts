import { eq } from "drizzle-orm";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveActor } from "../server/auth/actor";
import { FakeGateway } from "../server/billing/gateway";
import { linesFor, proratedCents, runBillingCycle, SEAT_CENTS } from "../server/billing/service";
import type { Ctx, Db } from "../server/db/types";
import { createApp } from "../server/http/app";
import { localDate } from "../server/sequences/dates";
import * as s from "../shared/schema";
import { addMember, createOrg, createTestDb } from "./helpers";

let db: Db;
let app: ReturnType<typeof createApp>;
const gateway = new FakeGateway();

const as = (who: Ctx) => ({
  get: (url: string) => request(app).get(url).set("x-user", who.userId).set("x-org", who.orgId),
  post: (url: string, body?: object) =>
    request(app).post(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
});

// Dates around today, in the organizations' time zone.
const today = localDate(new Date(), "America/Chicago");
const thisFirst = `${today.slice(0, 7)}-01`;
const shiftMonth = (first: string, by: number) => {
  const [y, m] = first.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 10);
};
const lastFirst = shiftMonth(thisFirst, -1);
const lastMonthDay = (d: number) => `${lastFirst.slice(0, 8)}${String(d).padStart(2, "0")}`;
const lastDayOf = (first: string) => {
  const [y, m] = first.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** An organization that has a card on file. */
async function payingOrg(): Promise<Ctx> {
  const owner = await createOrg(db);
  const start = await as(owner).post("/api/billing/card");
  const sessionId = new URL(start.body.url).searchParams.get("session_id");
  await as(owner).post("/api/billing/card/confirm", { sessionId });
  return owner;
}
/** Pretend it started before this month, so this month gets a bill. */
async function startedLastMonth(owner: Ctx) {
  await db
    .update(s.organizations)
    .set({ createdAt: new Date(`${lastFirst}T18:00:00Z`) })
    .where(eq(s.organizations.id, owner.orgId));
  await db
    .update(s.memberships)
    .set({ seatStartedOn: "2020-01-01" })
    .where(eq(s.memberships.orgId, owner.orgId));
}
const invoicesOf = (orgId: string) =>
  db.select().from(s.invoices).where(eq(s.invoices.orgId, orgId));

beforeAll(async () => {
  db = await createTestDb();
  app = createApp(
    db,
    async (req) => {
      const userId = req.header("x-user");
      const orgId = req.header("x-org");
      return userId && orgId ? resolveActor(db, { userId, orgId }) : null;
    },
    { billing: gateway },
  );
});

describe("what a seat costs", () => {
  it("prorates by day, counting the day added", () => {
    expect(proratedCents("2026-09-20", "2026-09-01")).toBe(183); // 11 of 30 days: $1.83
    expect(proratedCents("2026-09-01", "2026-09-01")).toBe(SEAT_CENTS);
    expect(proratedCents("2026-10-31", "2026-10-01")).toBe(16); // 1 of 31 days
    expect(proratedCents("2028-02-15", "2028-02-01")).toBe(259); // 15 of 29 days
  });
});

describe("getting a card on file", () => {
  it("keeps a new organization waiting until the owner saves a card", async () => {
    const owner = await createOrg(db);
    const admin = await addMember(db, owner.orgId, "admin", "Ada Admin");
    expect((await as(owner).get("/api/me")).body.billingStatus).toBe("setup");
    expect((await as(owner).get("/api/leads")).body).toEqual({
      error: "account_locked",
      status: "setup",
    });
    // Billing is the owner's alone.
    expect((await as(admin).get("/api/billing")).status).toBe(403);
    expect((await as(admin).post("/api/billing/card")).status).toBe(403);

    const start = await as(owner).post("/api/billing/card");
    expect(start.status).toBe(200);
    const sessionId = new URL(start.body.url).searchParams.get("session_id");
    expect(
      (await as(owner).post("/api/billing/card/confirm", { sessionId: "cs_someone_else" })).status,
    ).toBe(400);
    const done = await as(owner).post("/api/billing/card/confirm", { sessionId });
    expect(done.body.card).toEqual({ brand: "visa", last4: "4242", expires: "12/2030" });

    expect((await as(owner).get("/api/me")).body.billingStatus).toBe("active");
    expect((await as(admin).get("/api/leads")).status).toBe(200);
    const billing = (await as(owner).get("/api/billing")).body;
    expect(billing).toMatchObject({ enabled: true, status: "active", card: { last4: "4242" } });
    // Nothing is charged the day you sign up: the first bill is the 1st of next month.
    expect(billing.nextInvoice.date).toBe(shiftMonth(thisFirst, 1));
    expect(billing.invoices).toEqual([]);
  });
});

describe("the bill on the 1st", () => {
  it("charges full seats plus last month's additions by the day, once", async () => {
    const owner = await payingOrg();
    await startedLastMonth(owner);
    const rep = await addMember(db, owner.orgId, "rep", "Ray Rep");
    const left = await addMember(db, owner.orgId, "rep", "Lee Left");
    const ended = await addMember(db, owner.orgId, "rep", "Eve Ended");
    const leaving = await addMember(db, owner.orgId, "rep", "Lou Leaving");
    const newcomer = await addMember(db, owner.orgId, "rep", "Nia New");
    const seat = (who: Ctx, values: Partial<typeof s.memberships.$inferInsert>) =>
      db.update(s.memberships).set(values).where(eq(s.memberships.userId, who.userId));
    await seat(rep, { seatStartedOn: lastMonthDay(20) }); // joined on the 20th of last month
    await seat(left, { seatStartedOn: lastMonthDay(5), status: "removed" }); // added and removed last month
    await seat(ended, {
      seatStartedOn: "2020-01-01",
      status: "ending",
      endsOn: lastDayOf(lastFirst),
    }); // gone at month end
    await seat(leaving, {
      seatStartedOn: "2020-01-01",
      status: "ending",
      endsOn: lastDayOf(thisFirst),
    }); // still here this month
    await seat(newcomer, { seatStartedOn: thisFirst }); // joined this month: billed next 1st

    const lines = await linesFor(db, owner.orgId, thisFirst);
    // The month ahead for the owner, Lou and Ray; plus Ray's days of last month, from the 20th.
    expect(lines[0]).toMatchObject({ amountCents: 3 * SEAT_CENTS, seats: 3 });
    expect(lines.slice(1)).toEqual([
      expect.objectContaining({ amountCents: proratedCents(lastMonthDay(20), lastFirst) }),
    ]);
    expect(lines[1].description).toContain("Ray Rep");

    await runBillingCycle(db, gateway);
    await runBillingCycle(db, gateway); // a second run the same month changes nothing
    const bills = await invoicesOf(owner.orgId);
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({
      period: thisFirst.slice(0, 7),
      status: "paid",
      amountCents: 3 * SEAT_CENTS + proratedCents(lastMonthDay(20), lastFirst),
    });
    expect(gateway.invoices.get(bills[0].stripeInvoiceId!)?.amountCents).toBe(bills[0].amountCents);
    // Eve's seat ended on the way.
    const [eve] = await db
      .select()
      .from(s.memberships)
      .where(eq(s.memberships.userId, ended.userId));
    expect(eve.status).toBe("removed");
  });

  it("leaves organizations alone in their first month", async () => {
    const owner = await payingOrg();
    await runBillingCycle(db, gateway);
    expect(await invoicesOf(owner.orgId)).toHaveLength(0);
  });
});

describe("a declined card", () => {
  it("locks the account at once, keeps Billing and the export open, and unlocks on payment", async () => {
    const owner = await payingOrg();
    await startedLastMonth(owner);
    const rep = await addMember(db, owner.orgId, "rep", "Ray Rep");
    gateway.decline = true;
    try {
      await runBillingCycle(db, gateway);
    } finally {
      gateway.decline = false;
    }
    const [bill] = await invoicesOf(owner.orgId);
    expect(bill).toMatchObject({ status: "failed", failureMessage: "Your card was declined." });
    expect((await as(rep).get("/api/leads")).body).toEqual({
      error: "account_locked",
      status: "locked",
    });
    expect((await as(owner).get("/api/billing")).body.status).toBe("locked");
    expect((await as(owner).get("/api/export")).status).toBe(200);

    // A new card pays what's owed and unlocks the account.
    const start = await as(owner).post("/api/billing/card");
    const sessionId = new URL(start.body.url).searchParams.get("session_id");
    const done = await as(owner).post("/api/billing/card/confirm", { sessionId });
    expect(done.body.unlocked).toBe(true);
    expect((await invoicesOf(owner.orgId))[0].status).toBe("paid");
    expect((await as(rep).get("/api/leads")).status).toBe(200);
  });

  it("follows Stripe's own updates, and only signed ones", async () => {
    const owner = await payingOrg();
    await startedLastMonth(owner);
    await runBillingCycle(db, gateway);
    const [bill] = await invoicesOf(owner.orgId);
    const send = (type: string, signature = "fake-signature") =>
      request(app)
        .post("/api/webhooks/stripe")
        .set("content-type", "application/json")
        .set("stripe-signature", signature)
        .send(JSON.stringify({ type, id: bill.stripeInvoiceId }));

    expect((await send("invoice.payment_failed", "forged")).status).toBe(400);
    // A late failure notice can't undo a payment.
    expect((await send("invoice.payment_failed")).body).toEqual({ received: true, applied: false });
    await db.update(s.invoices).set({ status: "failed" }).where(eq(s.invoices.id, bill.id));
    await db
      .update(s.organizations)
      .set({ billingStatus: "locked" })
      .where(eq(s.organizations.id, owner.orgId));
    expect((await send("invoice.paid")).body.applied).toBe(true);
    expect((await as(owner).get("/api/me")).body.billingStatus).toBe("active");
    expect((await send("customer.created")).body).toEqual({ received: true, applied: false });
  });
});

describe("cancelling", () => {
  it("lasts to the end of the month, can be undone, then stops the bills; reactivating starts again", async () => {
    const owner = await payingOrg();
    const res = await as(owner).post("/api/billing/cancel");
    expect(res.body.cancelsOn).toBe(lastDayOf(thisFirst));
    expect((await as(owner).get("/api/billing")).body).toMatchObject({
      cancelsOn: lastDayOf(thisFirst),
      nextInvoice: null,
    });
    expect((await as(owner).post("/api/billing/undo-cancel")).status).toBe(204);
    expect((await as(owner).get("/api/billing")).body.cancelsOn).toBeNull();

    await as(owner).post("/api/billing/cancel");
    await startedLastMonth(owner);
    await db
      .update(s.organizations)
      .set({ cancelsOn: "2020-01-31" })
      .where(eq(s.organizations.id, owner.orgId));
    await runBillingCycle(db, gateway);
    expect(await invoicesOf(owner.orgId)).toHaveLength(0);
    expect((await as(owner).get("/api/me")).body.billingStatus).toBe("cancelled");
    expect((await as(owner).get("/api/leads")).status).toBe(402);

    expect((await as(owner).post("/api/billing/reactivate")).status).toBe(204);
    expect((await as(owner).get("/api/me")).body.billingStatus).toBe("active");
    const [seat] = await db
      .select()
      .from(s.memberships)
      .where(eq(s.memberships.userId, owner.userId));
    expect(seat.seatStartedOn).toBe(today);
  });
});
