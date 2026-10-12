import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  ACTIVITY_TYPES,
  activities,
  contacts,
  leads,
  opportunities,
  users,
} from "../../shared/schema";
import { recordLifecycle } from "../audit/history";
import type { Actor } from "../auth/actor";
import { canCreate, PermissionError, requireRecord, scopeFor } from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";

/**
 * Activities: calls, emails, LinkedIn touches, meetings and notes.
 *
 * Reps log them by hand from a record's Activity tab; the sequence engine
 * writes one for every completed step. An activity about a contact or an
 * opportunity is also filed under its account, so the account's timeline
 * shows everything that happened with everyone there.
 */

const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();
const ref = z.uuid().optional();

export const activityInput = z
  .object({
    type: z.enum(ACTIVITY_TYPES),
    subject: optionalText,
    body: optionalText,
    /** When it happened. Defaults to now; cannot be in the future. */
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    leadId: ref,
    contactId: ref,
    accountId: ref,
    opportunityId: ref,
  })
  .refine((v) => v.leadId || v.contactId || v.accountId || v.opportunityId, {
    message: "Say who or what the activity was about",
  })
  .refine((v) => v.subject || v.body, {
    message: "Add a subject or some notes",
  });

export const timelineQuery = z.object({
  leadId: ref,
  contactId: ref,
  accountId: ref,
  opportunityId: ref,
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

async function inOrg<T extends { id: string }>(
  tx: Db,
  table: typeof leads | typeof contacts | typeof accounts | typeof opportunities,
  orgId: string,
  id: string,
  what: string,
): Promise<T> {
  const [row] = await tx
    .select()
    .from(table)
    .where(and(eq(table.id, id), eq(table.orgId, orgId), isNull(table.deletedAt)));
  if (!row) throw new ValidationError(`${what} not found`);
  return row as unknown as T;
}

export async function logActivity(db: Db, actor: Actor, raw: unknown) {
  if (!canCreate(actor.permissions, "activities")) throw new PermissionError("activities.create");
  const input = activityInput.parse(raw);
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (occurredAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ValidationError("An activity can't be logged for the future");
  }
  return db.transaction(async (tx) => {
    let { accountId } = input;
    if (input.leadId) {
      const lead = await inOrg<typeof leads.$inferSelect>(
        tx,
        leads,
        actor.orgId,
        input.leadId,
        "Lead",
      );
      if (lead.convertedAt)
        throw new ValidationError("This lead was converted. Log it on the contact.");
    }
    // A contact's or an opportunity's account is filled in, and must agree with any given.
    for (const [id, table, what] of [
      [input.contactId, contacts, "Contact"],
      [input.opportunityId, opportunities, "Opportunity"],
    ] as const) {
      if (!id) continue;
      const row = await inOrg<{ id: string; accountId: string }>(tx, table, actor.orgId, id, what);
      if (accountId && accountId !== row.accountId) {
        throw new ValidationError(`That ${what.toLowerCase()} belongs to a different account`);
      }
      accountId = row.accountId;
    }
    if (accountId) await inOrg(tx, accounts, actor.orgId, accountId, "Account");

    const [row] = await tx
      .insert(activities)
      .values({
        orgId: actor.orgId,
        ownerId: actor.userId,
        type: input.type,
        subject: input.subject ?? null,
        body: input.body ?? null,
        occurredAt,
        leadId: input.leadId ?? null,
        contactId: input.contactId ?? null,
        accountId: accountId ?? null,
        opportunityId: input.opportunityId ?? null,
      })
      .returning();
    await recordLifecycle(tx, actor, "activity", row.id, "create");
    return row;
  });
}

export async function deleteActivity(db: Db, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(activities)
      .where(
        and(eq(activities.id, id), eq(activities.orgId, actor.orgId), isNull(activities.deletedAt)),
      )
      .for("update");
    if (!row) throw new NotFoundError("activity");
    requireRecord(actor.permissions, "activities", "delete", row, actor.userId);
    await tx.update(activities).set({ deletedAt: new Date() }).where(eq(activities.id, id));
    await recordLifecycle(tx, actor, "activity", id, "delete");
  });
}

/** The columns every list of activities shows, with who it was about. */
export function activityColumns() {
  return {
    id: activities.id,
    type: activities.type,
    subject: activities.subject,
    body: activities.body,
    occurredAt: activities.occurredAt,
    ownerId: activities.ownerId,
    ownerName: users.name,
    leadId: activities.leadId,
    contactId: activities.contactId,
    accountId: activities.accountId,
    opportunityId: activities.opportunityId,
    fromSequence: sql<boolean>`${activities.stepTaskId} is not null`,
    /** The person's name, whether a lead or a contact. */
    personName: sql<string | null>`coalesce(
      ${contacts.firstName} || ' ' || ${contacts.lastName},
      ${leads.firstName} || ' ' || ${leads.lastName})`,
    accountName: accounts.name,
    opportunityName: opportunities.name,
  };
}

export function activityQuery(db: Db) {
  return db
    .select(activityColumns())
    .from(activities)
    .leftJoin(users, eq(activities.ownerId, users.id))
    .leftJoin(leads, eq(activities.leadId, leads.id))
    .leftJoin(contacts, eq(activities.contactId, contacts.id))
    .leftJoin(accounts, eq(activities.accountId, accounts.id))
    .leftJoin(opportunities, eq(activities.opportunityId, opportunities.id));
}

/** The timeline for one record, newest first. */
export async function timeline(db: Db, actor: Actor, raw: unknown) {
  const scope = scopeFor(actor.permissions, "activities", "view");
  if (scope === "none") throw new PermissionError("activities.view");
  const q = timelineQuery.parse(raw);
  const where: SQL[] = [eq(activities.orgId, actor.orgId), isNull(activities.deletedAt)];
  if (scope === "own") where.push(eq(activities.ownerId, actor.userId));
  const filters = [
    [q.leadId, activities.leadId],
    [q.contactId, activities.contactId],
    [q.accountId, activities.accountId],
    [q.opportunityId, activities.opportunityId],
  ] as const;
  if (!filters.some(([value]) => value)) {
    throw new ValidationError("Say whose activity to show");
  }
  for (const [value, column] of filters) if (value) where.push(eq(column, value));
  return activityQuery(db)
    .where(and(...where))
    .orderBy(desc(activities.occurredAt))
    .limit(q.limit ?? 100);
}
