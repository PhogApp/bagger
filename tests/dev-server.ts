/**
 * Local preview server for looking at the screens without Clerk.
 *
 *   npm run build && npx tsx tests/dev-server.ts
 *
 * It uses an in-memory database with sample data and trusts two request
 * headers to say who the user is. That is only safe on your own machine,
 * which is why this file lives under tests/ and is never part of the build
 * that Render runs. The production server ignores those headers.
 */
import { eq, sql } from "drizzle-orm";
import path from "node:path";
import { resolveActor } from "../server/auth/actor";
import { createApp } from "../server/http/app";
import {
  accountService,
  contactService,
  leadService,
  opportunityService,
  sequenceService,
  templateService,
} from "../server/records";
import { localDate } from "../server/sequences/dates";
import * as seq from "../server/sequences/service";
import { addMember, createOrg, createTestDb } from "./helpers";
import { FakeGateway } from "../server/billing/gateway";
import { invoices, memberships, organizations, users } from "../shared/schema";
import { runBillingCycle } from "../server/billing/service";

const db = await createTestDb();
// Calendar days, so the sample queue has steps in it on weekends too.
const adminCtx = await createOrg(db, { waitDayMode: "calendar" });
const repCtx = await addMember(db, adminCtx.orgId, "rep", "Ray Rep");
const admin = (await resolveActor(db, adminCtx))!;
const rep = (await resolveActor(db, repCtx))!;

const phog = await accountService.create(db, admin, {
  name: "Phog, Inc.",
  website: "https://phog.example",
});
const testCo = await accountService.create(db, admin, { name: "Test Company", status: "Customer" });
const dan = await contactService.create(db, admin, {
  firstName: "Dan",
  lastName: "Smith",
  title: "CEO",
  email: "dan@phog.example",
  accountId: phog.id,
  status: "Prospecting",
});
const deals: [string, string, string | null, string, string][] = [
  ["NetSuite implementation", phog.id, "48000", "Proposal", "2026-11-20"],
  ["Support renewal", testCo.id, "9600", "Negotiation", "2026-10-30"],
  ["Warehouse module", testCo.id, "22500", "Prospecting", "2026-12-15"],
  ["Reporting add-on", phog.id, null, "Qualified", "2027-01-10"],
  ["Year-one licences", phog.id, "31000", "Closed Won", "2026-10-02"],
];
for (const [i, [name, accountId, amount, status, closeDate]] of deals.entries()) {
  await opportunityService.create(db, i % 2 ? rep : admin, {
    name,
    accountId,
    amount,
    status,
    closeDate,
    contactId: accountId === phog.id ? dan.id : undefined,
  });
}
const people = [
  ["Jeremy", "Gonnon", "Director, Service Delivery", "Secured Retail Networks", ""],
  ["Preston", "Strait", "VP IT", "Secured Retail Networks", "9493906714"],
  ["Mikey", "Nichols", "Manager, Operations", "TerraMai", "5304929482"],
  ["Misty", "Russell", "Head of Accounting", "TerraMai", ""],
  ["MJ", "Rushford", "Manager, Accounting", "Connectronics", "5155093183"],
  ["Jill", "Rude", "CFO", "Redfield Energy", ""],
];
for (const [i, [firstName, lastName, title, company, cellPhone]] of people.entries()) {
  const lead = await leadService.create(db, i % 2 ? rep : admin, {
    firstName,
    lastName,
    title,
    company,
    cellPhone,
    email: `${firstName}.${lastName}@example.com`,
  });
  if (lastName === "Rude") {
    await leadService.update(db, rep, lead.id, { title: "Chief Financial Officer" });
    await leadService.update(db, admin, lead.id, { status: "Prospecting", ownerId: rep.userId });
  }
}

const intro = await templateService.create(db, admin, {
  name: "Improve your business with NetSuite",
  type: "email",
  subject: "Improve your business, {firstName}",
  body: "Hi {firstName},\n\nI work with finance teams like the one at {company} that have outgrown their accounting system.\n\nWould a 15-minute call next week be worth it?\n\nBest,\nPeter",
});
const connect = await templateService.create(db, admin, {
  name: "LinkedIn Connection",
  type: "linkedin",
  body: "Hi {firstName}, I work with teams like {company} on NetSuite. Would be glad to connect.",
});
const outbound = await sequenceService.create(db, admin, {
  name: "NetSuite Outbound Sequence V1",
  description: "Connect, email, call",
});
await seq.addStep(db, admin, outbound.id, {
  type: "linkedin_connect",
  title: "LinkedIn Connect",
  templateId: connect.id,
});
await seq.addStep(db, admin, outbound.id, {
  type: "email",
  title: "Intro email",
  waitDays: 1,
  templateId: intro.id,
});
await seq.addStep(db, admin, outbound.id, {
  type: "phone_call",
  title: "Phone Call",
  waitDays: 2,
  callObjectives: "Confirm they own the ERP decision",
  callScript: "Ask how month-end close went last quarter.",
});
// Give both preview users something in their Roll the Calls queue.
const enrolled = await leadService.list(db, admin, {});
for (const lead of enrolled.slice(0, 4)) {
  const owner = lead.ownerId === rep.userId ? rep : admin;
  const { task } = await seq.enrollPerson(db, owner, outbound.id, { leadId: lead.id });
  if (lead.lastName === "Nichols" || lead.lastName === "Russell") {
    // Move on to the email step and make it due today, so the queue has an email in it.
    const { nextTask } = await seq.complete(db, owner, task.id, {});
    if (nextTask) {
      await seq.snooze(db, owner, nextTask.id, {
        dueOn: localDate(new Date(), "America/Chicago"),
      });
    }
  }
  if (lead.lastName === "Rushford") {
    // And a phone call due today, to try dialing and logging how it went.
    const { nextTask: email } = await seq.complete(db, owner, task.id, {});
    const { nextTask: call } = await seq.complete(db, owner, email!.id, {});
    await seq.snooze(db, owner, call!.id, { dueOn: localDate(new Date(), "America/Chicago") });
  }
}

// Other customers, for the staff console: one in each state.
const staffDay = localDate(new Date(), "America/Chicago");
const shiftDay = (by: number) => {
  const d = new Date(`${staffDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};
const samples: [string, number, Partial<typeof organizations.$inferInsert>, number | null][] = [
  ["Northwind Traders", 4, { trialEndsOn: shiftDay(5) }, null],
  ["Tidewater Supply", 7, { trialEndsOn: "2026-08-20", firstBilledOn: "2026-08-20" }, 5593],
  [
    "Halvorsen Freight",
    2,
    { trialEndsOn: "2026-09-02", firstBilledOn: "2026-09-02", billingStatus: "locked" },
    -1598,
  ],
  [
    "Redfield Energy",
    3,
    { trialEndsOn: "2026-07-10", firstBilledOn: "2026-07-10", cancelsOn: shiftDay(17) },
    2397,
  ],
  [
    "Connectronics",
    1,
    {
      trialEndsOn: "2026-06-01",
      firstBilledOn: "2026-06-01",
      billingStatus: "cancelled",
      cancelledAt: new Date("2026-09-01T05:00:00Z"),
    },
    799,
  ],
  ["Abandoned Signup LLC", 1, { cardLast4: null }, null],
];
for (const [name, people, state, billCents] of samples) {
  const owner = await createOrg(db, { name });
  for (let i = 1; i < people; i++) await addMember(db, owner.orgId, "rep", `Rep ${i} of ${name}`);
  await db
    .update(organizations)
    .set({
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpires: "12/2030",
      stripeCustomerId: `cus_preview_${people}`,
      ...state,
    })
    .where(eq(organizations.id, owner.orgId));
  if (billCents !== null) {
    await db.insert(invoices).values({
      orgId: owner.orgId,
      period: "2026-10",
      amountCents: Math.abs(billCents),
      lines: [{ description: "Seats", amountCents: Math.abs(billCents) }],
      status: billCents < 0 ? "failed" : "paid",
      failureMessage: billCents < 0 ? "Your card was declined." : null,
    });
  }
}
const [viewerUser] = await db.select().from(users).where(eq(users.id, adminCtx.userId));

// PREVIEW_AS=rep shows the screens as a Rep instead of an Admin.
const viewer = process.env.PREVIEW_AS === "rep" ? repCtx : adminCtx;
const previewBilling = new FakeGateway();
const app = createApp(
  db,
  async (req) => {
    const userId = req.header("x-user");
    const orgId = req.header("x-org");
    return userId && orgId ? resolveActor(db, { userId, orgId }) : null;
  },
  {
    publicConfig: {
      devUser: viewer.userId,
      devOrg: viewer.orgId,
      devOrgName: "Sample Org",
      devUserName: viewer === repCtx ? "Ray Rep" : "Admin",
    },
    staticDir: path.resolve("dist/public"),
    // PREVIEW_BILLING=1 tries billing with a stand-in for Stripe.
    billing: process.env.PREVIEW_BILLING === "1" ? previewBilling : null,
    // The preview admin is staff, so the staff console can be tried.
    staffEmails: [viewerUser.email],
  },
);
// End the free week now (the first bill), or bill as on the 1st (?month=1).
if (process.env.PREVIEW_BILLING === "1") {
  app.post("/preview/bill-now", async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    if (req.query.month === "1") {
      await db
        .update(organizations)
        .set({ trialEndsOn: "2019-12-25", firstBilledOn: "2019-12-25" });
      await db.update(memberships).set({ seatStartedOn: "2020-01-01" });
    } else {
      await db
        .update(organizations)
        .set({ trialEndsOn: today })
        .where(sql`${organizations.cardLast4} is not null`);
    }
    res.json(await runBillingCycle(db, previewBilling));
  });
  app.post("/preview/decline", (req, res) => {
    previewBilling.decline = req.query.on === "1";
    res.json({ decline: previewBilling.decline });
  });
}
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Preview at http://localhost:${port}`));
