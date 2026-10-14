import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { invoices, memberships, organizations, orgSettings, users } from "../../shared/schema";
import type { Actor } from "../auth/actor";
import { PermissionError } from "../auth/permissions";
import type { Db } from "../db/types";
import { ValidationError } from "../errors";
import { finalizeDue } from "../people/service";
import type { BillingGateway, ChargeResult } from "./gateway";

/**
 * Billing, as decided in bagger-pricing-and-billing.md: billed like rent.
 *
 * - $5 per user per month, charged on the 1st for the month ahead.
 * - A card is required before the organization can be used.
 * - A seat added during a month is prorated by day (days left, counting the
 *   day added, over days in the month) and charged on the next 1st with that
 *   month's seats. Nothing is charged on the day a seat is added, so a
 *   customer who cancels before their first 1st pays nothing.
 * - A seat removed during a month lasts to the end of it and isn't charged on
 *   the next 1st; a seat added and removed in the same month isn't charged.
 * - A failed charge locks the account at once. The owner can still update the
 *   card and pay; admins can still export. Paying unlocks it.
 * - Cancelling lasts to the end of the month, then no more bills.
 *
 * Dates are calendar days in the organization's time zone. Billing belongs to
 * the owner.
 */

export const SEAT_CENTS = 500;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** "2026-11-01" → "2026-10-01"; "2026-11-01" + 1 → "2026-12-01". */
function addMonths(first: string, by: number): string {
  const [y, m] = first.split("-").map(Number);
  return ymd(new Date(Date.UTC(y, m - 1 + by, 1)));
}
const monthName = (first: string) =>
  new Date(`${first}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** A seat that starts on `day` (inside the month starting `first`) costs this for that month. */
export function proratedCents(day: string, first: string): number {
  const [y, m] = first.split("-").map(Number);
  const total = daysIn(y, m);
  const left = total - Number(day.slice(8, 10)) + 1;
  return Math.round((SEAT_CENTS * left) / total);
}

async function today(db: Db, orgId: string): Promise<string> {
  const [row] = await db
    .select({
      today: sql<string>`to_char((now() at time zone coalesce(${orgSettings.timezone}, 'America/Chicago'))::date, 'YYYY-MM-DD')`,
    })
    .from(orgSettings)
    .where(eq(orgSettings.orgId, orgId));
  return row?.today ?? ymd(new Date());
}

export interface Line {
  description: string;
  amountCents: number;
  seats?: number;
}

/**
 * What the bill for the month starting `first` holds: every seat that started
 * before that month and is still there for it, plus the days of the month
 * before for seats that started during it.
 */
export async function linesFor(db: Db, orgId: string, first: string): Promise<Line[]> {
  const before = addMonths(first, -1);
  const seats = await db
    .select({
      name: users.name,
      status: memberships.status,
      endsOn: memberships.endsOn,
      startedOn: memberships.seatStartedOn,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.orgId, orgId), inArray(memberships.status, ["active", "ending"])));
  // A seat ending before this month starts isn't paid for it.
  const staying = seats.filter((s) => s.status === "active" || (s.endsOn ?? "") >= first);
  const full = staying.filter((s) => s.startedOn < first).length;
  const lines: Line[] = [];
  if (full > 0) {
    lines.push({
      description: `${full} user${full === 1 ? "" : "s"} × $5.00, ${monthName(first)}`,
      amountCents: full * SEAT_CENTS,
      seats: full,
    });
  }
  for (const s of staying.filter((x) => x.startedOn >= before && x.startedOn < first)) {
    const [y, m] = before.split("-").map(Number);
    const days = daysIn(y, m) - Number(s.startedOn.slice(8, 10)) + 1;
    lines.push({
      description: `${s.name}, ${days} day${days === 1 ? "" : "s"} of ${monthName(before)} (from ${s.startedOn})`,
      amountCents: proratedCents(s.startedOn, before),
    });
  }
  return lines;
}

function requireOwner(actor: Actor) {
  if (!actor.isOwner) throw new PermissionError("billing.owner");
}

function requireGateway(gateway: BillingGateway | null): BillingGateway {
  if (!gateway) throw new ValidationError("Payments aren't switched on for this server yet");
  return gateway;
}

async function loadOrg(db: Db, orgId: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  return org;
}

/** Everything the owner's Billing panel shows. */
export async function getBilling(db: Db, actor: Actor, gateway: BillingGateway | null) {
  requireOwner(actor);
  await finalizeDue(db, actor.orgId);
  const org = await loadOrg(db, actor.orgId);
  const day = await today(db, actor.orgId);
  const nextFirst = addMonths(`${day.slice(0, 7)}-01`, 1);
  const next = await linesFor(db, actor.orgId, nextFirst);
  const history = await db
    .select()
    .from(invoices)
    .where(eq(invoices.orgId, actor.orgId))
    .orderBy(desc(invoices.period));
  const [counts] = await db
    .select({
      active: sql<number>`count(*) filter (where ${memberships.status} = 'active')::int`,
      ending: sql<number>`count(*) filter (where ${memberships.status} = 'ending')::int`,
    })
    .from(memberships)
    .where(eq(memberships.orgId, actor.orgId));
  return {
    enabled: Boolean(gateway),
    status: org.billingStatus,
    card: org.cardLast4
      ? { brand: org.cardBrand, last4: org.cardLast4, expires: org.cardExpires }
      : null,
    cancelsOn: org.cancelsOn,
    seats: counts,
    nextInvoice:
      org.billingStatus === "cancelled" || (org.cancelsOn && org.cancelsOn < nextFirst)
        ? null
        : {
            date: nextFirst,
            lines: next,
            amountCents: next.reduce((sum, l) => sum + l.amountCents, 0),
          },
    invoices: history.map((i) => ({
      id: i.id,
      period: i.period,
      status: i.status,
      amountCents: i.amountCents,
      lines: i.lines,
      hostedUrl: i.hostedUrl,
      pdfUrl: i.pdfUrl,
      failureMessage: i.failureMessage,
      paidAt: i.paidAt,
      createdAt: i.createdAt,
    })),
  };
}

/** Where to send the owner to enter or change the card. */
export async function startCardSetup(
  db: Db,
  actor: Actor,
  gateway: BillingGateway | null,
  origin: string,
): Promise<{ url: string }> {
  requireOwner(actor);
  const g = requireGateway(gateway);
  const org = await loadOrg(db, actor.orgId);
  const [owner] = await db.select().from(users).where(eq(users.id, actor.userId));
  const customerId = await g.ensureCustomer({
    id: org.id,
    name: org.name,
    email: owner.email,
    customerId: org.stripeCustomerId,
  });
  if (customerId !== org.stripeCustomerId) {
    await db
      .update(organizations)
      .set({ stripeCustomerId: customerId })
      .where(eq(organizations.id, org.id));
  }
  const url = await g.cardSetupUrl(
    customerId,
    `${origin}/organization?billing=card`,
    `${origin}/organization`,
  );
  return { url };
}

/**
 * The owner is back from entering a card. Save it, and if the account is
 * locked, pay what's owed with it.
 */
export async function confirmCardSetup(
  db: Db,
  actor: Actor,
  gateway: BillingGateway | null,
  raw: unknown,
) {
  requireOwner(actor);
  const g = requireGateway(gateway);
  const { sessionId } = z.object({ sessionId: z.string().min(1).max(300) }).parse(raw);
  const org = await loadOrg(db, actor.orgId);
  if (!org.stripeCustomerId) throw new ValidationError("Start by adding a card");
  const card = await g.completeCardSetup(org.stripeCustomerId, sessionId);
  if (!card) throw new ValidationError("The card wasn't saved. Try adding it again.");
  await db
    .update(organizations)
    .set({ cardBrand: card.brand, cardLast4: card.last4, cardExpires: card.expires })
    .where(eq(organizations.id, org.id));
  const retried = org.billingStatus === "locked" ? await retryUnpaid(db, org.id, g) : null;
  return { card, unlocked: retried?.unlocked ?? false };
}

/** Pay unpaid bills again with the current card. Unlocks the account when nothing is left owing. */
async function retryUnpaid(db: Db, orgId: string, gateway: BillingGateway) {
  const unpaid = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), inArray(invoices.status, ["open", "failed"])));
  for (const inv of unpaid) {
    const result = inv.stripeInvoiceId
      ? await gateway.retry(inv.stripeInvoiceId)
      : await chargeInvoice(db, orgId, inv, gateway);
    await record(db, inv.id, result);
  }
  return { unlocked: await settleStatus(db, orgId) };
}

export async function payNow(db: Db, actor: Actor, gateway: BillingGateway | null) {
  requireOwner(actor);
  return retryUnpaid(db, actor.orgId, requireGateway(gateway));
}

async function record(db: Db, invoiceId: string, result: ChargeResult) {
  await db
    .update(invoices)
    .set({
      stripeInvoiceId: result.stripeInvoiceId,
      status: result.status,
      hostedUrl: result.hostedUrl,
      pdfUrl: result.pdfUrl,
      failureMessage: result.failureMessage,
      paidAt: result.status === "paid" ? new Date() : null,
    })
    .where(eq(invoices.id, invoiceId));
}

/** Locked while any bill is unpaid; unlocked once they're all paid. */
async function settleStatus(db: Db, orgId: string): Promise<boolean> {
  const org = await loadOrg(db, orgId);
  const [owing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), eq(invoices.status, "failed")));
  if (owing.n > 0 && org.billingStatus === "active") {
    await db
      .update(organizations)
      .set({ billingStatus: "locked" })
      .where(eq(organizations.id, orgId));
  }
  if (owing.n === 0 && org.billingStatus === "locked") {
    await db
      .update(organizations)
      .set({ billingStatus: "active" })
      .where(eq(organizations.id, orgId));
    return true;
  }
  return false;
}

async function chargeInvoice(
  db: Db,
  orgId: string,
  inv: typeof invoices.$inferSelect,
  gateway: BillingGateway,
): Promise<ChargeResult> {
  const org = await loadOrg(db, orgId);
  if (!org.stripeCustomerId) {
    return {
      stripeInvoiceId: "",
      status: "failed",
      hostedUrl: null,
      pdfUrl: null,
      failureMessage: "No card on file",
    };
  }
  return gateway.charge(org.stripeCustomerId, {
    key: `${orgId}-${inv.period}`,
    description: `Bagger, ${monthName(`${inv.period}-01`)}`,
    lines: inv.lines,
    metadata: { orgId, period: inv.period },
  });
}

/**
 * The monthly run. Safe to call as often as you like: each organization gets
 * one bill per month. Runs hourly on the server, so the 1st is never missed.
 */
export async function runBillingCycle(
  db: Db,
  gateway: BillingGateway,
): Promise<{ billed: number; failed: number; cancelled: number }> {
  let billed = 0;
  let failed = 0;
  let cancelled = 0;
  const orgs = await db.select().from(organizations);
  for (const org of orgs) {
    const day = await today(db, org.id);
    // Cancellations take effect the day after their last day.
    if (org.billingStatus !== "cancelled" && org.cancelsOn && org.cancelsOn < day) {
      await db
        .update(organizations)
        .set({ billingStatus: "cancelled", cancelledAt: new Date() })
        .where(eq(organizations.id, org.id));
      cancelled += 1;
      continue;
    }
    // Bills go to working accounts with a card, from the first month after they started.
    if (org.billingStatus !== "active" || !org.cardLast4 || !org.stripeCustomerId) continue;
    const first = `${day.slice(0, 7)}-01`;
    const [started] = await db
      .select({
        day: sql<string>`to_char((${organizations.createdAt} at time zone coalesce(${orgSettings.timezone}, 'America/Chicago'))::date, 'YYYY-MM-DD')`,
      })
      .from(organizations)
      .leftJoin(orgSettings, eq(orgSettings.orgId, organizations.id))
      .where(eq(organizations.id, org.id));
    if ((started?.day ?? first) >= first) continue;

    await finalizeDue(db, org.id);
    const lines = await linesFor(db, org.id, first);
    const amountCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
    const [inv] = await db
      .insert(invoices)
      .values({ orgId: org.id, period: first.slice(0, 7), amountCents, lines })
      .onConflictDoNothing()
      .returning();
    if (!inv) continue; // already billed this month
    if (amountCents === 0) {
      await db
        .update(invoices)
        .set({ status: "paid", paidAt: new Date() })
        .where(eq(invoices.id, inv.id));
      continue;
    }
    try {
      const result = await chargeInvoice(db, org.id, inv, gateway);
      await record(db, inv.id, result);
      if (result.status === "paid") billed += 1;
      else failed += 1;
    } catch (e) {
      // Stripe couldn't be reached; the bill stays open and is tried again next hour.
      await db
        .update(invoices)
        .set({ failureMessage: e instanceof Error ? e.message : "Payment service unavailable" })
        .where(eq(invoices.id, inv.id));
    }
    await settleStatus(db, org.id);
  }
  // Bills Stripe never received are tried again; the key stops a double charge.
  const stuck = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.status, "open"),
        isNull(invoices.stripeInvoiceId),
        isNotNull(invoices.failureMessage),
        lt(invoices.createdAt, new Date(Date.now() - 30 * 60 * 1000)),
      ),
    );
  for (const inv of stuck) {
    try {
      await record(db, inv.id, await chargeInvoice(db, inv.orgId, inv, gateway));
      await settleStatus(db, inv.orgId);
    } catch {
      // Next hour.
    }
  }
  return { billed, failed, cancelled };
}

/** Stripe told us a bill was paid or failed (for example, after a retry from its side). */
export async function applyEvent(
  db: Db,
  event: { stripeInvoiceId: string; status: "paid" | "failed"; message: string | null },
) {
  const [inv] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.stripeInvoiceId, event.stripeInvoiceId));
  if (!inv || inv.status === event.status || inv.status === "void") return false;
  if (inv.status === "paid" && event.status === "failed") return false; // late and stale
  await db
    .update(invoices)
    .set({
      status: event.status,
      failureMessage: event.message,
      paidAt: event.status === "paid" ? new Date() : null,
    })
    .where(eq(invoices.id, inv.id));
  await settleStatus(db, inv.orgId);
  return true;
}

// ------------------------------------------------------------ cancelling

export async function cancelAccount(db: Db, actor: Actor) {
  requireOwner(actor);
  const org = await loadOrg(db, actor.orgId);
  if (org.billingStatus !== "active")
    throw new ValidationError("Only a working account can be cancelled");
  const day = await today(db, actor.orgId);
  const [y, m] = day.split("-").map(Number);
  const lastDay = `${day.slice(0, 8)}${String(daysIn(y, m)).padStart(2, "0")}`;
  await db.update(organizations).set({ cancelsOn: lastDay }).where(eq(organizations.id, org.id));
  return { cancelsOn: lastDay };
}

export async function undoCancel(db: Db, actor: Actor) {
  requireOwner(actor);
  const org = await loadOrg(db, actor.orgId);
  if (org.billingStatus !== "active" || !org.cancelsOn)
    throw new ValidationError("The account isn't being cancelled");
  await db.update(organizations).set({ cancelsOn: null }).where(eq(organizations.id, org.id));
}

/**
 * Come back after cancelling. Billing starts again from today: the rest of
 * this month is prorated on the next 1st, like a new customer.
 */
export async function reactivate(db: Db, actor: Actor) {
  requireOwner(actor);
  const org = await loadOrg(db, actor.orgId);
  if (org.billingStatus !== "cancelled") throw new ValidationError("The account isn't cancelled");
  const day = await today(db, actor.orgId);
  await db.transaction(async (tx) => {
    await tx
      .update(organizations)
      .set({ billingStatus: "active", cancelsOn: null, cancelledAt: null })
      .where(eq(organizations.id, org.id));
    await tx
      .update(memberships)
      .set({ seatStartedOn: day })
      .where(and(eq(memberships.orgId, org.id), inArray(memberships.status, ["active", "ending"])));
  });
}
