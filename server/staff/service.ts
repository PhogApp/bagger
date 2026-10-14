import { and, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  activities,
  contacts,
  fieldHistory,
  invoices,
  leads,
  memberships,
  opportunities,
  organizations,
  orgSettings,
  roles,
  sequences,
  staffActions,
  templates,
  users,
} from "../../shared/schema";
import type { Actor } from "../auth/actor";
import { SEAT_CENTS } from "../billing/service";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";

/**
 * The staff console: Bagger's own view across every customer organization.
 * Who counts as staff is set outside the product, by email address
 * (STAFF_EMAILS), so no customer can make themselves staff. This is the one
 * place that reads across organizations; it never shows a customer's records,
 * only counts, people and bills.
 *
 * Staff can permanently delete an organization's data once it has cancelled
 * (or never got as far as a card). Each deletion is logged in staff_actions,
 * which outlives the organization.
 */

export type StaffStatus = "no_card" | "trial" | "paying" | "cancelling" | "locked" | "cancelled";

export interface Staff {
  email: string;
}

/** The signed-in person, if their email is on the staff list. */
export async function staffFor(db: Db, actor: Actor, staffEmails: string[]): Promise<Staff | null> {
  if (staffEmails.length === 0) return null;
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, actor.userId));
  const email = user?.email.trim().toLowerCase();
  return email && staffEmails.includes(email) ? { email } : null;
}

/** "a@x.com, B@y.com" → ["a@x.com", "b@y.com"] */
export function parseStaffEmails(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

type OrgRow = typeof organizations.$inferSelect;

function statusOf(org: OrgRow, today: string): StaffStatus {
  if (org.billingStatus === "cancelled") return "cancelled";
  if (org.billingStatus === "locked") return "locked";
  if (!org.cardLast4) return "no_card";
  if (org.cancelsOn) return "cancelling";
  if (!org.firstBilledOn && org.trialEndsOn && today < org.trialEndsOn) return "trial";
  return "paying";
}

/**
 * Data can go once the customer has left: a cancelled account, or a sign-up
 * that never saved a card and was never billed.
 */
function deletable(status: StaffStatus, bills: number): boolean {
  return status === "cancelled" || (status === "no_card" && bills === 0);
}

const today = sql<string>`to_char((now() at time zone coalesce(${orgSettings.timezone}, 'America/Chicago'))::date, 'YYYY-MM-DD')`;
const seatCount = (statuses: string[]) =>
  sql<number>`(select count(*)::int from ${memberships} where ${memberships.orgId} = ${organizations.id} and ${inArray(memberships.status, statuses as ("active" | "ending" | "removed")[])})`;
const lastActive = sql<
  string | null
>`(select max(${fieldHistory.createdAt}) from ${fieldHistory} where ${fieldHistory.orgId} = ${organizations.id})`;

async function rows(db: Db, orgId?: string) {
  return db
    .select({
      org: organizations,
      today,
      timezone: orgSettings.timezone,
      ownerName: users.name,
      ownerEmail: users.email,
      seats: seatCount(["active", "ending"]),
      removed: seatCount(["removed"]),
      lastActive,
    })
    .from(organizations)
    .leftJoin(orgSettings, eq(orgSettings.orgId, organizations.id))
    .leftJoin(users, eq(users.id, organizations.ownerUserId))
    .where(orgId ? eq(organizations.id, orgId) : undefined)
    .orderBy(desc(organizations.createdAt));
}

function summarize(
  r: Awaited<ReturnType<typeof rows>>[number],
  bills: (typeof invoices.$inferSelect)[],
) {
  const { org } = r;
  const status = statusOf(org, r.today);
  const paid = bills.filter((b) => b.status === "paid");
  const last = bills[0] ?? null;
  return {
    id: org.id,
    name: org.name,
    createdAt: org.createdAt,
    owner: r.ownerEmail ? { name: r.ownerName, email: r.ownerEmail } : null,
    status,
    seats: r.seats,
    removedSeats: r.removed,
    monthlyCents: status === "cancelled" ? 0 : r.seats * SEAT_CENTS,
    card: org.cardLast4 ? { brand: org.cardBrand, last4: org.cardLast4 } : null,
    trialEndsOn: org.trialEndsOn,
    firstBilledOn: org.firstBilledOn,
    cancelsOn: org.cancelsOn,
    cancelledAt: org.cancelledAt,
    lastBill: last
      ? { period: last.period, amountCents: last.amountCents, status: last.status }
      : null,
    owedCents: bills.filter((b) => b.status === "failed").reduce((s, b) => s + b.amountCents, 0),
    paidCents: paid.reduce((s, b) => s + b.amountCents, 0),
    lastActive: r.lastActive ? new Date(r.lastActive) : null,
    canDelete: deletable(status, bills.length),
  };
}

/** Every organization, newest first, with the figures that matter across them. */
export async function listOrganizations(db: Db) {
  const all = await rows(db);
  const bills = await db.select().from(invoices).orderBy(desc(invoices.period));
  const byOrg = new Map<string, (typeof invoices.$inferSelect)[]>();
  for (const b of bills) byOrg.set(b.orgId, [...(byOrg.get(b.orgId) ?? []), b]);
  const orgs = all.map((r) => summarize(r, byOrg.get(r.org.id) ?? []));
  const count = (s: StaffStatus) => orgs.filter((o) => o.status === s).length;
  const paying = orgs.filter((o) => o.status === "paying" || o.status === "cancelling");
  const recent = await db
    .select()
    .from(staffActions)
    .orderBy(desc(staffActions.createdAt))
    .limit(20);
  return {
    totals: {
      organizations: orgs.length,
      trial: count("trial"),
      paying: paying.length,
      locked: count("locked"),
      cancelled: count("cancelled"),
      noCard: count("no_card"),
      users: orgs.filter((o) => o.status !== "cancelled").reduce((s, o) => s + o.seats, 0),
      // What the paying organizations' seats come to each month at today's count.
      monthlyCents: paying.reduce((s, o) => s + o.monthlyCents, 0),
      trialMonthlyCents: orgs
        .filter((o) => o.status === "trial")
        .reduce((s, o) => s + o.monthlyCents, 0),
      owedCents: orgs.reduce((s, o) => s + o.owedCents, 0),
    },
    organizations: orgs,
    recentActions: recent,
  };
}

const orgIdParam = z.uuid();

/** One organization: its people, its bills, how much it holds, and what staff did to it. */
export async function getOrganization(db: Db, rawId: string) {
  const parsed = orgIdParam.safeParse(rawId);
  if (!parsed.success) throw new NotFoundError();
  const orgId = parsed.data;
  const [r] = await rows(db, orgId);
  if (!r) throw new NotFoundError();
  const bills = await db
    .select()
    .from(invoices)
    .where(eq(invoices.orgId, orgId))
    .orderBy(desc(invoices.period));
  const people = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: roles.name,
      status: memberships.status,
      seatStartedOn: memberships.seatStartedOn,
      endsOn: memberships.endsOn,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(roles, eq(roles.id, memberships.roleId))
    .where(eq(memberships.orgId, orgId))
    .orderBy(memberships.status, users.name);
  const live = <T extends typeof leads | typeof contacts | typeof accounts | typeof opportunities>(
    t: T,
  ) =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(t as typeof leads)
      .where(and(eq((t as typeof leads).orgId, orgId), isNull((t as typeof leads).deletedAt)))
      .then(([x]) => x.n);
  const [leadN, contactN, accountN, oppN] = await Promise.all([
    live(leads),
    live(contacts),
    live(accounts),
    live(opportunities),
  ]);
  const countOf = async (t: typeof activities | typeof sequences | typeof templates) => {
    const [x] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(t as typeof activities)
      .where(eq((t as typeof activities).orgId, orgId));
    return x.n;
  };
  const actions = await db
    .select()
    .from(staffActions)
    .where(eq(staffActions.orgId, orgId))
    .orderBy(desc(staffActions.createdAt));
  return {
    ...summarize(r, bills),
    timezone: r.timezone ?? "America/Chicago",
    billingEmail: r.org.billingEmail,
    stripeCustomerId: r.org.stripeCustomerId,
    clerkOrgId: r.org.clerkOrgId,
    cardExpires: r.org.cardExpires,
    counts: {
      leads: leadN,
      contacts: contactN,
      accounts: accountN,
      opportunities: oppN,
      activities: await countOf(activities),
      sequences: await countOf(sequences),
      templates: await countOf(templates),
    },
    people,
    invoices: bills.map((b) => ({
      id: b.id,
      period: b.period,
      status: b.status,
      amountCents: b.amountCents,
      hostedUrl: b.hostedUrl,
      failureMessage: b.failureMessage,
      paidAt: b.paidAt,
      createdAt: b.createdAt,
    })),
    staffActions: actions,
  };
}

const deleteBody = z.object({ confirmName: z.string().max(300) });

/**
 * Permanently delete an organization and everything in it: records, history,
 * people's memberships, bills. People who belonged to no other organization
 * are deleted too. Only once the customer has left (see `deletable`), and only
 * when the organization's exact name is typed to confirm.
 *
 * Returns the Clerk organization so the caller can remove it from sign-in too.
 */
export async function deleteOrganization(db: Db, staff: Staff, rawId: string, raw: unknown) {
  const parsed = orgIdParam.safeParse(rawId);
  if (!parsed.success) throw new NotFoundError();
  const orgId = parsed.data;
  const { confirmName } = deleteBody.parse(raw);
  const [r] = await rows(db, orgId);
  if (!r) throw new NotFoundError();
  const [{ n: bills }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(eq(invoices.orgId, orgId));
  const status = statusOf(r.org, r.today);
  if (!deletable(status, bills)) {
    throw new ValidationError(
      "Only a cancelled organization, or one that never added a card, can be deleted",
    );
  }
  if (confirmName.trim() !== r.org.name.trim()) {
    throw new ValidationError("Type the organization's name exactly to confirm");
  }

  return db.transaction(async (tx) => {
    const members = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.orgId, orgId));
    // Every table holding the organization's data goes with it (on delete cascade).
    await tx.delete(organizations).where(eq(organizations.id, orgId));
    // People left with no organization at all are deleted too.
    const ids = members.map((m) => m.userId);
    const gone = ids.length
      ? await tx
          .delete(users)
          .where(
            and(
              inArray(users.id, ids),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(memberships)
                  .where(eq(memberships.userId, users.id)),
              ),
            ),
          )
          .returning({ id: users.id })
      : [];
    await tx.insert(staffActions).values({
      staffEmail: staff.email,
      action: "organization.deleted",
      orgId,
      orgName: r.org.name,
      data: {
        status,
        people: ids.length,
        peopleDeleted: gone.length,
        bills,
        stripeCustomerId: r.org.stripeCustomerId,
        clerkOrgId: r.org.clerkOrgId,
      },
    });
    return { name: r.org.name, clerkOrgId: r.org.clerkOrgId, peopleDeleted: gone.length };
  });
}

/** Note that removing the Clerk organization failed, so it can be done by hand. */
export async function noteClerkFailure(db: Db, staff: Staff, orgId: string, message: string) {
  await db.insert(staffActions).values({
    staffEmail: staff.email,
    action: "clerk.delete_failed",
    orgId,
    data: { message },
  });
}

const ownerBody = z.object({ userId: z.uuid() });

/**
 * Make someone else the owner, for when the owner has left or can't be
 * reached. They must be an active member; if they aren't an Admin they're
 * made one (the owner is always an Admin). Shows in the organization's
 * History as a system change, and in the staff log.
 */
export async function changeOwner(
  db: Db,
  staff: Staff,
  rawId: string,
  raw: unknown,
): Promise<{ owner: string; madeAdmin: boolean; orgId: string; userId: string }> {
  const parsed = orgIdParam.safeParse(rawId);
  if (!parsed.success) throw new NotFoundError();
  const orgId = parsed.data;
  const { userId } = ownerBody.parse(raw);
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for("update");
    if (!org) throw new NotFoundError();
    if (org.ownerUserId === userId) throw new ValidationError("They already own it");
    const [target] = await tx
      .select({
        membershipId: memberships.id,
        name: users.name,
        status: memberships.status,
        presetKey: roles.presetKey,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
      .for("update", { of: memberships });
    if (!target || target.status !== "active") {
      throw new ValidationError("Choose someone who is active in the organization");
    }
    const [before] = org.ownerUserId
      ? await tx.select({ name: users.name }).from(users).where(eq(users.id, org.ownerUserId))
      : [];
    const madeAdmin = target.presetKey !== "admin";
    const history: (typeof fieldHistory.$inferInsert)[] = [
      {
        orgId,
        recordType: "organization",
        recordId: orgId,
        action: "update",
        field: "owner",
        oldValue: before?.name ?? null,
        newValue: target.name,
        source: "system",
        userId: null,
      },
    ];
    if (madeAdmin) {
      const [admin] = await tx
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), eq(roles.presetKey, "admin")));
      if (!admin) throw new ValidationError("This organization has no Admin role");
      await tx
        .update(memberships)
        .set({ roleId: admin.id })
        .where(eq(memberships.id, target.membershipId));
      history.push({
        orgId,
        recordType: "user",
        recordId: userId,
        action: "update",
        field: "role",
        oldValue: null,
        newValue: admin.name,
        source: "system",
        userId: null,
      });
    }
    await tx.update(organizations).set({ ownerUserId: userId }).where(eq(organizations.id, orgId));
    await tx.insert(fieldHistory).values(history);
    await tx.insert(staffActions).values({
      staffEmail: staff.email,
      action: "owner.changed",
      orgId,
      orgName: org.name,
      data: { from: before?.name ?? null, to: target.name, madeAdmin },
    });
    return { owner: target.name, madeAdmin, orgId, userId };
  });
}
