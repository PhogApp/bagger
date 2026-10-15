import { eq } from "drizzle-orm";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { logActivity } from "../server/activities/service";
import { resolveActor } from "../server/auth/actor";
import { FakeGateway } from "../server/billing/gateway";
import { addDays, runBillingCycle, SEAT_CENTS } from "../server/billing/service";
import type { Ctx, Db } from "../server/db/types";
import { createApp } from "../server/http/app";
import { localDate } from "../server/sequences/dates";
import {
  accountService,
  contactService,
  leadService,
  opportunityService,
  sequenceService,
  templateService,
} from "../server/records";
import * as seq from "../server/sequences/service";
import { parseStaffEmails } from "../server/staff/service";
import * as s from "../shared/schema";
import { addMember, createLead, createOrg, createTestDb } from "./helpers";

let db: Db;
let app: ReturnType<typeof createApp>;
const gateway = new FakeGateway();
const deletedInClerk: (string | null)[] = [];
let staff: Ctx;
const today = localDate(new Date(), "America/Chicago");

const as = (who: Ctx) => ({
  get: (url: string) => request(app).get(url).set("x-user", who.userId).set("x-org", who.orgId),
  post: (url: string, body?: object) =>
    request(app).post(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
});

async function withCard(owner: Ctx) {
  const start = await as(owner).post("/api/billing/card");
  const sessionId = new URL(start.body.url).searchParams.get("session_id");
  await as(owner).post("/api/billing/card/confirm", { sessionId });
}
const orgRow = async (orgId: string) =>
  (await db.select().from(s.organizations).where(eq(s.organizations.id, orgId)))[0];

beforeAll(async () => {
  db = await createTestDb();
  app = createApp(
    db,
    async (req) => {
      const userId = req.header("x-user");
      const orgId = req.header("x-org");
      return userId && orgId ? resolveActor(db, { userId, orgId }) : null;
    },
    {
      billing: gateway,
      staffEmails: parseStaffEmails(" Staff@Bagger.test, other@bagger.test "),
      onOrgDeleted: async ({ clerkOrgId }) => {
        deletedInClerk.push(clerkOrgId);
      },
    },
  );
  staff = await createOrg(db, { name: "Bagger HQ" });
  await db.update(s.users).set({ email: "staff@bagger.test" }).where(eq(s.users.id, staff.userId));
  await withCard(staff);
});

describe("who can open the staff console", () => {
  it("is staff by email only; everyone else gets not found", async () => {
    expect((await as(staff).get("/api/me")).body.isStaff).toBe(true);
    expect((await as(staff).get("/api/staff/organizations")).status).toBe(200);

    const customer = await createOrg(db);
    await withCard(customer);
    expect((await as(customer).get("/api/me")).body.isStaff).toBe(false);
    expect((await as(customer).get("/api/staff/organizations")).status).toBe(404);
    const id = customer.orgId;
    expect((await as(customer).get(`/api/staff/organizations/${id}`)).status).toBe(404);
    expect(
      (await as(customer).post(`/api/staff/organizations/${id}/delete`, { confirmName: "x" }))
        .status,
    ).toBe(404);
  });

  it("works while the staff member's own organization is locked", async () => {
    await db
      .update(s.organizations)
      .set({ billingStatus: "locked" })
      .where(eq(s.organizations.id, staff.orgId));
    try {
      expect((await as(staff).get("/api/leads")).status).toBe(402);
      expect((await as(staff).get("/api/staff/organizations")).status).toBe(200);
    } finally {
      await db
        .update(s.organizations)
        .set({ billingStatus: "active" })
        .where(eq(s.organizations.id, staff.orgId));
    }
  });
});

describe("the list of organizations", () => {
  it("shows where each one stands and the totals", async () => {
    const trialing = await createOrg(db, { name: "Trial Co" });
    await withCard(trialing);
    await addMember(db, trialing.orgId, "rep", "Ray Rep");

    const paying = await createOrg(db, { name: "Paying Co" });
    await withCard(paying);
    await db
      .update(s.organizations)
      .set({ trialEndsOn: today })
      .where(eq(s.organizations.id, paying.orgId));
    await runBillingCycle(db, gateway);

    const noCard = await createOrg(db, { name: "No Card Co" });

    const res = await as(staff).get("/api/staff/organizations");
    const byName = (name: string) =>
      res.body.organizations.find((o: { name: string }) => o.name === name);
    expect(byName("Trial Co")).toMatchObject({
      status: "trial",
      seats: 2,
      trialEndsOn: addDays(today, 7),
      monthlyCents: 2 * SEAT_CENTS,
      owner: { name: "Admin" },
      canDelete: false,
    });
    expect(byName("Paying Co")).toMatchObject({
      status: "paying",
      lastBill: { status: "paid" },
      canDelete: false,
    });
    expect(byName("Paying Co").paidCents).toBeGreaterThan(0);
    expect(byName("No Card Co")).toMatchObject({ status: "no_card", canDelete: true });
    expect(res.body.totals.trial).toBeGreaterThanOrEqual(1);
    expect(res.body.totals.paying).toBeGreaterThanOrEqual(1);

    const detail = await as(staff).get(`/api/staff/organizations/${noCard.orgId}`);
    expect(detail.body).toMatchObject({
      name: "No Card Co",
      status: "no_card",
      counts: { leads: 0 },
      people: [expect.objectContaining({ name: "Admin", status: "active" })],
    });
    expect((await as(staff).get("/api/staff/organizations/not-an-id")).status).toBe(404);
  });
});

describe("deleting an organization's data", () => {
  it("only for one that has left, only with its name typed, and logs it", async () => {
    const leaving = await createOrg(db, { name: "Leaving, Inc." });
    await withCard(leaving);
    const rep = await addMember(db, leaving.orgId, "rep", "Rita Rep");
    await createLead(db, leaving, { lastName: "Prospect" });
    await db
      .update(s.organizations)
      .set({ clerkOrgId: "org_clerk_leaving" })
      .where(eq(s.organizations.id, leaving.orgId));
    // Someone who also belongs to another organization keeps their sign-in.
    const elsewhere = await createOrg(db, { name: "Elsewhere" });
    await db.insert(s.memberships).values({
      orgId: leaving.orgId,
      userId: elsewhere.userId,
      roleId: (await db.select().from(s.roles).where(eq(s.roles.orgId, leaving.orgId)))[0].id,
    });

    const url = `/api/staff/organizations/${leaving.orgId}/delete`;
    // Still in its trial: not yet.
    const early = await as(staff).post(url, { confirmName: "Leaving, Inc." });
    expect(early.status).toBe(400);
    expect(early.body.message ?? early.body.error).toBeTruthy();

    await db
      .update(s.organizations)
      .set({ billingStatus: "cancelled", cancelledAt: new Date() })
      .where(eq(s.organizations.id, leaving.orgId));
    expect((await as(staff).post(url, { confirmName: "Leaving" })).status).toBe(400);
    expect(await orgRow(leaving.orgId)).toBeDefined();

    const done = await as(staff).post(url, { confirmName: "Leaving, Inc." });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ name: "Leaving, Inc.", peopleDeleted: 2, signIn: "removed" });
    expect(deletedInClerk).toContain("org_clerk_leaving");

    expect(await orgRow(leaving.orgId)).toBeUndefined();
    expect(await db.select().from(s.leads).where(eq(s.leads.orgId, leaving.orgId))).toEqual([]);
    expect(
      await db.select().from(s.memberships).where(eq(s.memberships.orgId, leaving.orgId)),
    ).toEqual([]);
    expect(await db.select().from(s.users).where(eq(s.users.id, rep.userId))).toEqual([]);
    expect(await db.select().from(s.users).where(eq(s.users.id, elsewhere.userId))).toHaveLength(1);
    expect((await as(elsewhere).get("/api/me")).status).toBe(200);

    const log = (await as(staff).get("/api/staff/organizations")).body.recentActions;
    expect(log[0]).toMatchObject({
      staffEmail: "staff@bagger.test",
      action: "organization.deleted",
      orgName: "Leaving, Inc.",
    });
    expect((await as(staff).get(`/api/staff/organizations/${leaving.orgId}`)).status).toBe(404);
  });

  it("takes everything an organization holds", async () => {
    const full = await createOrg(db, { name: "Full Co", waitDayMode: "calendar" });
    const admin = (await resolveActor(db, full))!;
    const repCtx = await addMember(db, full.orgId, "rep", "Ray Rep");
    const rep = (await resolveActor(db, repCtx))!;
    const account = await accountService.create(db, admin, { name: "Acme" });
    const contact = await contactService.create(db, admin, {
      firstName: "Dan",
      lastName: "Smith",
      email: "dan@acme.example",
      accountId: account.id,
    });
    const opp = await opportunityService.create(db, rep, {
      name: "Big deal",
      accountId: account.id,
      contactId: contact.id,
      status: "Qualified",
    });
    await opportunityService.update(db, rep, opp.id, { status: "Proposal" });
    const lead = await leadService.create(db, rep, {
      firstName: "Lee",
      lastName: "Lead",
      email: "lee@lead.example",
    });
    await leadService.update(db, admin, lead.id, { title: "CFO" });
    const tpl = await templateService.create(db, admin, {
      name: "Intro",
      type: "email",
      subject: "Hi",
      body: "Hello {firstName}",
    });
    const sequence = await sequenceService.create(db, admin, { name: "Outbound" });
    await seq.addStep(db, admin, sequence.id, {
      type: "email",
      title: "Intro",
      templateId: tpl.id,
    });
    await seq.addStep(db, admin, sequence.id, { type: "phone_call", title: "Call", waitDays: 1 });
    const { task } = await seq.enrollPerson(db, rep, sequence.id, { leadId: lead.id });
    await seq.complete(db, rep, task.id, {});
    await logActivity(db, rep, { type: "note", body: "Spoke briefly", contactId: contact.id });
    await logActivity(db, rep, {
      type: "call",
      status: "open",
      subject: "Follow up",
      opportunityId: opp.id,
    });
    await db
      .update(s.organizations)
      .set({ billingStatus: "cancelled" })
      .where(eq(s.organizations.id, full.orgId));

    const res = await as(staff).post(`/api/staff/organizations/${full.orgId}/delete`, {
      confirmName: "Full Co",
    });
    expect(res.status).toBe(200);
    for (const table of [
      s.leads,
      s.contacts,
      s.accounts,
      s.opportunities,
      s.opportunityStageHistory,
      s.activities,
      s.templates,
      s.sequences,
      s.sequenceSteps,
      s.enrollments,
      s.stepTasks,
      s.fieldHistory,
      s.events,
      s.roles,
      s.statusOptions,
      s.orgSettings,
    ]) {
      expect(await db.select().from(table).where(eq(table.orgId, full.orgId))).toEqual([]);
    }
  });

  it("refuses a paying organization", async () => {
    const paying = await createOrg(db, { name: "Stays Co" });
    await withCard(paying);
    const res = await as(staff).post(`/api/staff/organizations/${paying.orgId}/delete`, {
      confirmName: "Stays Co",
    });
    expect(res.status).toBe(400);
    expect(await orgRow(paying.orgId)).toBeDefined();
  });
});

describe("changing the owner", () => {
  it("hands the organization to an active member, making them an Admin", async () => {
    const owner = await createOrg(db, { name: "Owner Gone Co" });
    await withCard(owner);
    const rep = await addMember(db, owner.orgId, "rep", "Rosa Rep");
    const gone = await addMember(db, owner.orgId, "rep", "Gus Gone");
    await db
      .update(s.memberships)
      .set({ status: "removed" })
      .where(eq(s.memberships.userId, gone.userId));
    const url = `/api/staff/organizations/${owner.orgId}/owner`;

    expect((await as(owner).post(url, { userId: rep.userId })).status).toBe(404);
    expect((await as(staff).post(url, { userId: gone.userId })).status).toBe(400);
    expect((await as(staff).post(url, { userId: owner.userId })).status).toBe(400);

    const res = await as(staff).post(url, { userId: rep.userId });
    expect(res.body).toEqual({ owner: "Rosa Rep", madeAdmin: true });
    const me = (await as(rep).get("/api/me")).body;
    expect(me).toMatchObject({ isOwner: true, role: "Admin" });
    expect((await as(owner).get("/api/me")).body.isOwner).toBe(false);
    expect((await as(rep).get("/api/billing")).status).toBe(200);

    const history = await db
      .select()
      .from(s.fieldHistory)
      .where(eq(s.fieldHistory.recordId, owner.orgId));
    expect(history).toEqual([
      expect.objectContaining({ field: "owner", newValue: "Rosa Rep", source: "system" }),
    ]);
    const detail = (await as(staff).get(`/api/staff/organizations/${owner.orgId}`)).body;
    expect(detail.owner.name).toBe("Rosa Rep");
    expect(detail.staffActions[0]).toMatchObject({
      action: "owner.changed",
      data: { from: "Admin", to: "Rosa Rep", madeAdmin: true },
    });
  });
});

describe("with payments switched off", () => {
  it("doesn't treat having no card as having left", async () => {
    const offApp = createApp(
      db,
      async (req) => {
        const userId = req.header("x-user");
        const orgId = req.header("x-org");
        return userId && orgId ? resolveActor(db, { userId, orgId }) : null;
      },
      { staffEmails: ["staff@bagger.test"] },
    );
    const org = await createOrg(db, { name: "Free Ride Co" });
    const get = (url: string) =>
      request(offApp).get(url).set("x-user", staff.userId).set("x-org", staff.orgId);
    const list = (await get("/api/staff/organizations")).body;
    expect(list.billingOn).toBe(false);
    expect((await get(`/api/staff/organizations/${org.orgId}`)).body).toMatchObject({
      status: "no_card",
      canDelete: false,
    });
    const res = await request(offApp)
      .post(`/api/staff/organizations/${org.orgId}/delete`)
      .set("x-user", staff.userId)
      .set("x-org", staff.orgId)
      .send({ confirmName: "Free Ride Co" });
    expect(res.status).toBe(400);
    expect(await orgRow(org.orgId)).toBeDefined();
  });
});
