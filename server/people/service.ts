import { and, asc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  memberships,
  organizations,
  orgSettings,
  roles,
  savedReports,
  users,
} from "../../shared/schema";
import type { Actor } from "../auth/actor";
import { requireTool } from "../auth/permissions";
import type { Ctx, Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";
import { reassignQueue } from "../sequences/engine";

/**
 * People leaving and coming back. Nobody is ever deleted: a removed person
 * becomes inactive, so everything they did keeps their name. Only active
 * people are paid seats.
 *
 * Removing someone:
 *  1. An admin chooses who takes over their records, and whether the seat
 *     ends now or on the last day of the month (the default, since the month
 *     is paid for). Until then the person keeps working and shows as
 *     "Ending on <date>"; the removal can be undone.
 *  2. When the seat ends, they become inactive and their leads, contacts,
 *     accounts, opportunities, templates, sequences, saved reports, open
 *     activities, running sequences and waiting steps move to that person.
 *     Each move is recorded in History as a system change.
 *  3. An inactive person can be reinstated with their old role. Their records
 *     don't move back.
 *
 * Removing someone in Clerk does the same, handing their records to the
 * owner; an admin can choose someone else before the seat ends.
 */

const STATUS_LABEL = { active: "Active", ending: "Ending", removed: "Inactive" } as const;

/** Today, and the last day of this month, in the organization's time zone. */
async function orgDates(tx: Db, orgId: string): Promise<{ today: string; monthEnd: string }> {
  const [row] = await tx
    .select({
      today: sql<string>`to_char((now() at time zone coalesce(${orgSettings.timezone}, 'America/Chicago'))::date, 'YYYY-MM-DD')`,
      monthEnd: sql<string>`to_char((date_trunc('month', (now() at time zone coalesce(${orgSettings.timezone}, 'America/Chicago'))) + interval '1 month - 1 day')::date, 'YYYY-MM-DD')`,
    })
    .from(orgSettings)
    .where(eq(orgSettings.orgId, orgId));
  const today = new Date().toISOString().slice(0, 10);
  return row ?? { today, monthEnd: today };
}

export async function listPeople(db: Db, actor: Actor) {
  await finalizeDue(db, actor.orgId);
  const handTo = sql<
    string | null
  >`(select u.name from users u where u.id = ${memberships.handToUserId})`;
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: roles.name,
      roleId: roles.id,
      status: memberships.status,
      endsOn: memberships.endsOn,
      endedAt: memberships.endedAt,
      handToUserId: memberships.handToUserId,
      handToName: handTo,
      isOwner: sql<boolean>`${organizations.ownerUserId} = ${users.id}`,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .innerJoin(roles, eq(memberships.roleId, roles.id))
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(eq(memberships.orgId, actor.orgId))
    .orderBy(asc(users.name));
  // Everyone sees who is here; only those who manage people see who has left.
  const manages = actor.permissions["account.users_and_roles"] === true;
  const people = rows
    .filter((r) => manages || r.status !== "removed")
    .map((r) => ({ ...r, statusLabel: STATUS_LABEL[r.status] }));
  return {
    people,
    seats: {
      active: rows.filter((r) => r.status === "active").length,
      ending: rows.filter((r) => r.status === "ending").length,
      inactive: rows.filter((r) => r.status === "removed").length,
    },
  };
}

async function lockMembers(tx: Db, orgId: string) {
  return tx
    .select({ membership: memberships, presetKey: roles.presetKey, name: users.name })
    .from(memberships)
    .innerJoin(roles, eq(memberships.roleId, roles.id))
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.orgId, orgId))
    .for("update", { of: memberships });
}

async function ownerOf(tx: Db, orgId: string): Promise<string | null> {
  const [org] = await tx
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return org?.ownerUserId ?? null;
}

const removeInput = z.object({
  /** Who takes over their records and sequences. */
  handTo: z.uuid(),
  /** "end_of_month" keeps access to the last day of the month, which is paid for. */
  when: z.enum(["end_of_month", "now"]).default("end_of_month"),
});

export async function removePerson(db: Db, actor: Actor, userId: string, raw: unknown) {
  requireTool(actor.permissions, "account.users_and_roles");
  const input = removeInput.parse(raw);
  await db.transaction(async (tx) => {
    const members = await lockMembers(tx, actor.orgId);
    const target = members.find((m) => m.membership.userId === userId);
    if (!target) throw new NotFoundError("user");
    if (target.membership.status !== "active") {
      throw new ValidationError(`${target.name} has already been removed`);
    }
    if (userId === actor.userId) throw new ValidationError("You can't remove yourself");
    if ((await ownerOf(tx, actor.orgId)) === userId) {
      throw new ValidationError(
        `${target.name} owns the organization. Transfer ownership before removing them.`,
      );
    }
    const otherAdmins = members.filter(
      (m) =>
        m.presetKey === "admin" &&
        m.membership.status === "active" &&
        m.membership.userId !== userId,
    );
    if (target.presetKey === "admin" && otherAdmins.length === 0) {
      throw new ValidationError(
        `${target.name} is the only Admin. Make someone else an Admin first.`,
      );
    }
    const heir = members.find((m) => m.membership.userId === input.handTo);
    if (!heir || heir.membership.status !== "active" || input.handTo === userId) {
      throw new ValidationError("Choose an active person to take over their records");
    }

    const { today, monthEnd } = await orgDates(tx, actor.orgId);
    const [updated] = await tx
      .update(memberships)
      .set({
        status: "ending",
        endsOn: input.when === "now" ? today : monthEnd,
        handToUserId: input.handTo,
        removedBy: actor.userId,
      })
      .where(eq(memberships.id, target.membership.id))
      .returning();
    if (input.when === "now") await finalize(tx, actor.orgId, updated);
  });
}

/** Changed their mind before the seat ended. */
export async function undoRemoval(db: Db, actor: Actor, userId: string) {
  requireTool(actor.permissions, "account.users_and_roles");
  await db.transaction(async (tx) => {
    const target = (await lockMembers(tx, actor.orgId)).find((m) => m.membership.userId === userId);
    if (!target) throw new NotFoundError("user");
    if (target.membership.status !== "ending") {
      throw new ValidationError(
        target.membership.status === "removed"
          ? `${target.name}'s seat has already ended. Reinstate them instead.`
          : `${target.name} isn't being removed`,
      );
    }
    await tx
      .update(memberships)
      .set({ status: "active", endsOn: null, handToUserId: null, removedBy: null })
      .where(eq(memberships.id, target.membership.id));
  });
}

/** Choose someone else to take over before the seat ends. */
export async function changeHandTo(db: Db, actor: Actor, userId: string, raw: unknown) {
  requireTool(actor.permissions, "account.users_and_roles");
  const { handTo } = z.object({ handTo: z.uuid() }).parse(raw);
  await db.transaction(async (tx) => {
    const members = await lockMembers(tx, actor.orgId);
    const target = members.find((m) => m.membership.userId === userId);
    if (!target) throw new NotFoundError("user");
    if (target.membership.status !== "ending") {
      throw new ValidationError(`${target.name} isn't being removed`);
    }
    const heir = members.find((m) => m.membership.userId === handTo);
    if (!heir || heir.membership.status !== "active" || handTo === userId) {
      throw new ValidationError("Choose an active person to take over their records");
    }
    await tx
      .update(memberships)
      .set({ handToUserId: handTo })
      .where(eq(memberships.id, target.membership.id));
  });
}

/**
 * Bring an inactive person back, with the role they had. They become a paid
 * seat again; their old records stay with whoever took them over.
 */
export async function reinstatePerson(db: Db, actor: Actor, userId: string) {
  requireTool(actor.permissions, "account.users_and_roles");
  await db.transaction(async (tx) => {
    const target = (await lockMembers(tx, actor.orgId)).find((m) => m.membership.userId === userId);
    if (!target) throw new NotFoundError("user");
    if (target.membership.status !== "removed") {
      throw new ValidationError(`${target.name} is already active`);
    }
    await tx
      .update(memberships)
      .set({ status: "active", endsOn: null, handToUserId: null, removedBy: null, endedAt: null })
      .where(eq(memberships.id, target.membership.id));
  });
}

/**
 * End every seat whose last day has passed. Runs before anyone is let in, so
 * nobody keeps access past their end date, and on a timer in production.
 */
export async function finalizeDue(db: Db, orgId: string): Promise<number> {
  const { today } = await orgDates(db, orgId);
  const due = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.status, "ending"),
        lt(memberships.endsOn, today),
      ),
    );
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [m] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.id, id), eq(memberships.status, "ending")))
        .for("update");
      if (m) await finalize(tx, orgId, m);
    });
  }
  return due.length;
}

/** Every organization with a seat due to end; for the production timer. */
export async function finalizeAllDue(db: Db): Promise<number> {
  const orgs = await db
    .selectDistinct({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.status, "ending"));
  let ended = 0;
  for (const { orgId } of orgs) ended += await finalizeDue(db, orgId);
  return ended;
}

const OWNED = [
  { table: "leads", type: "lead", extra: sql`and converted_at is null` },
  { table: "contacts", type: "contact", extra: sql`` },
  { table: "accounts", type: "account", extra: sql`` },
  { table: "opportunities", type: "opportunity", extra: sql`` },
  { table: "templates", type: "template", extra: sql`` },
  { table: "sequences", type: "sequence", extra: sql`` },
  // Completed activities are history and keep their name; open ones are work to do.
  { table: "activities", type: "activity", extra: sql`and status = 'open'` },
] as const;

/** The seat ends: inactive from now, and everything they owned moves on. */
async function finalize(tx: Db, orgId: string, m: typeof memberships.$inferSelect) {
  const from = m.userId;
  // Whoever was chosen, unless they have since left too; then the owner.
  const [heir] = m.handToUserId
    ? await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.orgId, orgId),
            eq(memberships.userId, m.handToUserId),
            eq(memberships.status, "active"),
          ),
        )
    : [];
  const to = heir?.userId ?? (await ownerOf(tx, orgId));
  const by = m.removedBy ?? to;

  if (to && to !== from) {
    for (const o of OWNED) {
      const table = sql.raw(`"${o.table}"`);
      await tx.execute(sql`
        insert into field_history (org_id, record_type, record_id, action, field, old_value, new_value, source, user_id)
        select org_id, ${o.type}, id, 'update', 'ownerId', ${from}::text, ${to}::text, 'system', ${by}::uuid
        from ${table}
        where org_id = ${orgId} and owner_id = ${from} and deleted_at is null ${o.extra}`);
      await tx.execute(sql`
        update ${table} set owner_id = ${to}, updated_at = now()
        where org_id = ${orgId} and owner_id = ${from} and deleted_at is null ${o.extra}`);
    }
    await tx
      .update(savedReports)
      .set({ ownerId: to })
      .where(and(eq(savedReports.orgId, orgId), eq(savedReports.ownerId, from)));
    const ctx: Ctx = { orgId, userId: by ?? to };
    await reassignQueue(tx, ctx, from, to);
  }
  await tx
    .update(memberships)
    .set({ status: "removed", endedAt: new Date(), handToUserId: to })
    .where(eq(memberships.id, m.id));
}

/**
 * Someone was removed from the organization in Clerk. Their seat ends at the
 * end of the month and their records go to the owner; an admin can choose
 * someone else before then. The owner can't be removed this way.
 */
export async function removedInClerk(
  db: Db,
  who: { clerkOrgId?: string; clerkUserId: string },
): Promise<number> {
  const rows = await db
    .select({ membership: memberships, ownerUserId: organizations.ownerUserId })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(
      and(
        eq(users.clerkUserId, who.clerkUserId),
        eq(memberships.status, "active"),
        ...(who.clerkOrgId ? [eq(organizations.clerkOrgId, who.clerkOrgId)] : []),
      ),
    );
  let marked = 0;
  for (const { membership, ownerUserId } of rows) {
    if (!ownerUserId || ownerUserId === membership.userId) continue;
    const { monthEnd } = await orgDates(db, membership.orgId);
    await db
      .update(memberships)
      .set({ status: "ending", endsOn: monthEnd, handToUserId: ownerUserId, removedBy: null })
      .where(and(eq(memberships.id, membership.id), eq(memberships.status, "active")));
    marked += 1;
  }
  return marked;
}
