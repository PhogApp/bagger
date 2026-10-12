import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  accounts,
  ACTIVITY_STATUSES,
  ACTIVITY_TYPES,
  activities,
  contacts,
  leads,
  opportunities,
  orgSettings,
  users,
} from "../../shared/schema";
import { diffFields, recordLifecycle, recordUpdate } from "../audit/history";
import { isMember, type Actor } from "../auth/actor";
import {
  canCreate,
  PermissionError,
  requireRecord,
  requireTool,
  scopeFor,
} from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";

/**
 * Activities: calls, emails, LinkedIn touches, meetings and notes, each about
 * a lead, contact, account or opportunity.
 *
 * An activity is either open (still to do, with a due date and an owner) or
 * completed (done, with the time it happened). Reps log completed ones by
 * hand or plan open ones and check them off later; the sequence engine writes
 * a completed one for every completed step. An activity about a contact or an
 * opportunity is also filed under its account, so the account's timeline
 * shows everything that happened with everyone there.
 */

type Row = typeof activities.$inferSelect;

const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();
const ref = z.uuid().optional();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31");

export const activityInput = z
  .object({
    type: z.enum(ACTIVITY_TYPES),
    status: z.enum(ACTIVITY_STATUSES).optional(),
    subject: optionalText,
    body: optionalText,
    /** Completed: when it happened. Defaults to now; cannot be in the future. */
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    /** Open: the day it is due. Defaults to the owner's today. */
    dueOn: day.optional(),
    /** Who does it. Defaults to the person logging it. */
    ownerId: z.uuid().optional(),
    leadId: ref,
    contactId: ref,
    accountId: ref,
    opportunityId: ref,
  })
  .refine((v) => v.leadId || v.contactId || v.accountId || v.opportunityId, {
    message: "Say who or what the activity is about",
  })
  .refine((v) => v.subject || v.body, {
    message: "Add a subject or some notes",
  });

const activityPatch = z.object({
  type: z.enum(ACTIVITY_TYPES).optional(),
  status: z.enum(ACTIVITY_STATUSES).optional(),
  subject: optionalText,
  body: optionalText,
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  dueOn: day.optional(),
  ownerId: z.uuid().optional(),
});

/** A list of activities: by record, owner, status, type and text, sorted and paged. */
export const activityListQuery = z.object({
  leadId: ref,
  contactId: ref,
  accountId: ref,
  opportunityId: ref,
  q: z.string().optional(),
  /** Comma-separated user ids, or "me". */
  owner: z.string().optional(),
  /** open, overdue or completed; repeat for several. */
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
  type: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
  sort: z.string().optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const bulkInput = z.object({
  ids: z.array(z.uuid()).min(1).max(1000),
  action: z.enum(["update", "delete"]),
  patch: z
    .object({ ownerId: z.uuid().optional(), status: z.enum(ACTIVITY_STATUSES).optional() })
    .optional(),
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

/** Today's date for a user: their own time zone, or the organization's. */
export async function todayFor(db: Db, orgId: string, userId: string): Promise<string> {
  const [row] = await db
    .select({
      today: sql<string>`to_char((now() at time zone coalesce(${users.timezone}, ${orgSettings.timezone}, 'America/Chicago'))::date, 'YYYY-MM-DD')`,
    })
    .from(users)
    .leftJoin(orgSettings, eq(orgSettings.orgId, orgId))
    .where(eq(users.id, userId));
  return row?.today ?? new Date().toISOString().slice(0, 10);
}

function checkWhen(occurredAt: Date) {
  if (occurredAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ValidationError("A completed activity can't be in the future");
  }
}

async function checkOwner(tx: Db, actor: Actor, ownerId: string | undefined) {
  if (ownerId && !(await isMember(tx, actor.orgId, ownerId))) {
    throw new ValidationError("Owner is not a user in this organization");
  }
}

export async function logActivity(db: Db, actor: Actor, raw: unknown) {
  if (!canCreate(actor.permissions, "activities")) throw new PermissionError("activities.create");
  const input = activityInput.parse(raw);
  const status = input.status ?? "completed";
  if (status === "open" && input.occurredAt) {
    throw new ValidationError("An open activity has a due date, not a time it happened");
  }
  const occurredAt =
    status === "completed" ? (input.occurredAt ? new Date(input.occurredAt) : new Date()) : null;
  if (occurredAt) checkWhen(occurredAt);
  const ownerId = input.ownerId ?? actor.userId;
  return db.transaction(async (tx) => {
    await checkOwner(tx, actor, input.ownerId);
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
        ownerId,
        type: input.type,
        status,
        subject: input.subject ?? null,
        body: input.body ?? null,
        occurredAt,
        dueOn:
          status === "open"
            ? (input.dueOn ?? (await todayFor(tx, actor.orgId, ownerId)))
            : (input.dueOn ?? null),
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

async function lockActivity(tx: Db, actor: Actor, id: string): Promise<Row> {
  const [row] = await tx
    .select()
    .from(activities)
    .where(
      and(eq(activities.id, id), eq(activities.orgId, actor.orgId), isNull(activities.deletedAt)),
    )
    .for("update");
  if (!row) throw new NotFoundError("activity");
  return row;
}

/**
 * Change an activity: its text, owner, due date, or status. Completing an open
 * activity stamps the time it happened (now, unless given); reopening a
 * completed one clears that time and gives it a due date again.
 */
export async function updateActivity(db: Db, actor: Actor, id: string, raw: unknown) {
  const patch = activityPatch.parse(raw);
  return db.transaction(async (tx) => {
    const before = await lockActivity(tx, actor, id);
    requireRecord(actor.permissions, "activities", "edit", before, actor.userId);
    if (before.stepTaskId) {
      throw new ValidationError(
        "This activity was written by a sequence step and can't be changed",
      );
    }
    await checkOwner(tx, actor, patch.ownerId);
    const status = patch.status ?? before.status;
    const next: Partial<Row> = {
      type: patch.type,
      subject: patch.subject,
      body: patch.body,
      ownerId: patch.ownerId,
      status: patch.status,
      dueOn: patch.dueOn,
    };
    if (status === "completed") {
      if (patch.occurredAt) next.occurredAt = new Date(patch.occurredAt);
      else if (before.status === "open") next.occurredAt = new Date();
      if (next.occurredAt) checkWhen(next.occurredAt);
    } else {
      if (patch.occurredAt) {
        throw new ValidationError("An open activity has a due date, not a time it happened");
      }
      next.occurredAt = null;
      if (!patch.dueOn && !before.dueOn) {
        next.dueOn = await todayFor(tx, actor.orgId, patch.ownerId ?? before.ownerId);
      }
    }
    // Clearing both would leave nothing to say what it was.
    const subject = next.subject !== undefined ? next.subject : before.subject;
    const body = next.body !== undefined ? next.body : before.body;
    if (subject === null && body === null) throw new ValidationError("Add a subject or some notes");
    const changes = diffFields(
      before as unknown as Record<string, unknown>,
      next as Record<string, unknown>,
    );
    if (changes.length === 0) return before;
    const [after] = await tx
      .update(activities)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(activities.id, id))
      .returning();
    await recordUpdate(tx, actor, "activity", id, changes);
    return after;
  });
}

export async function deleteActivity(db: Db, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockActivity(tx, actor, id);
    requireRecord(actor.permissions, "activities", "delete", row, actor.userId);
    await tx.update(activities).set({ deletedAt: new Date() }).where(eq(activities.id, id));
    await recordLifecycle(tx, actor, "activity", id, "delete");
  });
}

/** Change the owner or status of many activities, or delete them, each on its own. */
export async function bulkActivities(
  db: Db,
  actor: Actor,
  raw: unknown,
): Promise<{ done: number; skipped: { id: string; reason: string }[] }> {
  const input = bulkInput.parse(raw);
  if (input.action === "delete") requireTool(actor.permissions, "data.bulk_delete");
  else {
    requireTool(actor.permissions, "data.bulk_edit");
    if (input.patch?.ownerId) requireTool(actor.permissions, "data.bulk_reassign");
    if (!input.patch || Object.keys(input.patch).length === 0) {
      throw new ValidationError("Choose what to change");
    }
  }
  let done = 0;
  const skipped: { id: string; reason: string }[] = [];
  for (const id of new Set(input.ids)) {
    try {
      if (input.action === "delete") await deleteActivity(db, actor, id);
      else await updateActivity(db, actor, id, input.patch);
      done += 1;
    } catch (e) {
      if (e instanceof PermissionError)
        skipped.push({ id, reason: "Your role can't change this activity" });
      else if (e instanceof NotFoundError) skipped.push({ id, reason: "No longer exists" });
      else if (e instanceof ValidationError) skipped.push({ id, reason: e.message });
      else throw e;
    }
  }
  return { done, skipped };
}

/** The person's name, whether a lead or a contact. */
const personName = sql<string | null>`coalesce(
  ${contacts.firstName} || ' ' || ${contacts.lastName},
  ${leads.firstName} || ' ' || ${leads.lastName})`;

/** Open and due before the owner's today. */
const overdue = sql<boolean>`(${activities.status} = 'open' and ${activities.dueOn} < (now() at time zone coalesce(${users.timezone}, (select s.timezone from org_settings s where s.org_id = ${activities.orgId}), 'America/Chicago'))::date)`;

/** The columns every list of activities shows, with who it was about. */
export function activityColumns() {
  return {
    id: activities.id,
    type: activities.type,
    status: activities.status,
    subject: activities.subject,
    body: activities.body,
    occurredAt: activities.occurredAt,
    dueOn: activities.dueOn,
    overdue,
    ownerId: activities.ownerId,
    ownerName: users.name,
    leadId: activities.leadId,
    contactId: activities.contactId,
    accountId: activities.accountId,
    opportunityId: activities.opportunityId,
    fromSequence: sql<boolean>`${activities.stepTaskId} is not null`,
    personName,
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

const SORTABLE: Record<string, AnyPgColumn | SQL> = {
  type: activities.type,
  subject: sql`lower(${activities.subject})`,
  status: activities.status,
  dueOn: activities.dueOn,
  occurredAt: activities.occurredAt,
  owner: users.name,
  person: sql`lower(${personName})`,
  account: sql`lower(${accounts.name})`,
  opportunity: sql`lower(${opportunities.name})`,
};

/** Open first, soonest due; then completed, newest first. */
const USUAL_ORDER = [
  sql`(${activities.status} = 'open') desc`,
  sql`${activities.dueOn} asc nulls last`,
  sql`${activities.occurredAt} desc nulls last`,
  desc(activities.createdAt),
];

function listWhere(actor: Actor, q: z.infer<typeof activityListQuery>): SQL {
  const scope = scopeFor(actor.permissions, "activities", "view");
  if (scope === "none") throw new PermissionError("activities.view");
  const where: SQL[] = [eq(activities.orgId, actor.orgId), isNull(activities.deletedAt)];
  if (scope === "own") where.push(eq(activities.ownerId, actor.userId));
  for (const [value, column] of [
    [q.leadId, activities.leadId],
    [q.contactId, activities.contactId],
    [q.accountId, activities.accountId],
    [q.opportunityId, activities.opportunityId],
  ] as const) {
    if (value) where.push(eq(column, value));
  }
  if (q.owner) {
    const ids = q.owner
      .split(",")
      .map((o) => (o === "me" ? actor.userId : o.trim()))
      .filter(Boolean);
    if (ids.some((o) => !z.uuid().safeParse(o).success)) throw new ValidationError("Unknown owner");
    where.push(inArray(activities.ownerId, ids));
  }
  if (q.status.length) {
    const parts: SQL[] = [];
    for (const st of q.status) {
      if (st === "open") parts.push(eq(activities.status, "open"));
      else if (st === "completed") parts.push(eq(activities.status, "completed"));
      else if (st === "overdue") parts.push(overdue);
      else throw new ValidationError(`Unknown status "${st}"`);
    }
    where.push(or(...parts)!);
  }
  if (q.type.length) {
    for (const t of q.type) {
      if (!(ACTIVITY_TYPES as readonly string[]).includes(t))
        throw new ValidationError(`Unknown activity type "${t}"`);
    }
    where.push(inArray(activities.type, q.type as (typeof ACTIVITY_TYPES)[number][]));
  }
  const text = q.q?.trim();
  if (text) {
    const pattern = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
    where.push(
      or(
        ilike(activities.subject, pattern),
        ilike(activities.body, pattern),
        ilike(personName, pattern),
        ilike(accounts.name, pattern),
        ilike(opportunities.name, pattern),
      )!,
    );
  }
  return and(...where)!;
}

/** Activities by record, owner, status, type and text, with how many match in all. */
export async function listActivities(db: Db, actor: Actor, raw: unknown) {
  const q = activityListQuery.parse(raw);
  const where = listWhere(actor, q);
  let order: SQL[] = USUAL_ORDER;
  if (q.sort) {
    const expr = SORTABLE[q.sort];
    if (!expr) throw new ValidationError(`Activities can't be sorted by "${q.sort}"`);
    order = [sql`${expr} ${sql.raw(q.dir === "desc" ? "desc" : "asc")} nulls last`, ...USUAL_ORDER];
  }
  const rows = await activityQuery(db)
    .where(where)
    .orderBy(...order)
    .limit(q.limit ?? 100)
    .offset(q.offset ?? 0);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(activities)
    .leftJoin(users, eq(activities.ownerId, users.id))
    .leftJoin(leads, eq(activities.leadId, leads.id))
    .leftJoin(contacts, eq(activities.contactId, contacts.id))
    .leftJoin(accounts, eq(activities.accountId, accounts.id))
    .leftJoin(opportunities, eq(activities.opportunityId, opportunities.id))
    .where(where);
  return { rows, total: n };
}

/** One activity, as lists show it. */
export async function getActivity(db: Db, actor: Actor, id: string) {
  const [row] = await activityQuery(db).where(
    and(eq(activities.id, id), eq(activities.orgId, actor.orgId), isNull(activities.deletedAt)),
  );
  if (!row) throw new NotFoundError("activity");
  requireRecord(actor.permissions, "activities", "view", row, actor.userId);
  return row;
}

/** The timeline for one record: open activities first, then the history, newest first. */
export async function timeline(db: Db, actor: Actor, raw: unknown) {
  const q = activityListQuery.parse(raw);
  if (!q.leadId && !q.contactId && !q.accountId && !q.opportunityId) {
    throw new ValidationError("Say whose activity to show");
  }
  return activityQuery(db)
    .where(listWhere(actor, q))
    .orderBy(...USUAL_ORDER)
    .limit(q.limit ?? 200);
}
