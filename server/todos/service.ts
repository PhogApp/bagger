import { and, asc, eq, isNull, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  activities,
  contacts,
  leads,
  opportunities,
  orgSettings,
  TODO_TYPES,
  todos,
  users,
} from "../../shared/schema";
import { diffFields, recordLifecycle, recordUpdate } from "../audit/history";
import { isMember, type Actor } from "../auth/actor";
import { canCreate, canUse, PermissionError, requireRecord, scopeFor } from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";
import { localDate } from "../sequences/dates";

/**
 * To-dos: one-off tasks with a due date. They use the activity permissions
 * (anyone who can log an activity can make a to-do; editing and deleting
 * follow the activity edit and delete rights, judged by who the to-do is
 * for). A to-do about a contact or opportunity is also filed under its
 * account.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date");
const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();
const ref = z.uuid().nullable().optional();

export const todoInput = z.object({
  title: z.string().trim().min(1, "Say what needs doing").max(200),
  notes: optionalText,
  type: z.enum(TODO_TYPES).optional(),
  dueOn: day,
  ownerId: z.uuid().optional(),
  leadId: ref,
  contactId: ref,
  accountId: ref,
  opportunityId: ref,
});

type Row = typeof todos.$inferSelect;

/** Today's date for a user: their own time zone, or the organization's. */
async function todayFor(db: Db, orgId: string, userId: string): Promise<string> {
  const [org] = await db
    .select({ tz: orgSettings.timezone })
    .from(orgSettings)
    .where(eq(orgSettings.orgId, orgId));
  const [user] = await db.select({ tz: users.timezone }).from(users).where(eq(users.id, userId));
  return localDate(new Date(), user?.tz ?? org?.tz ?? "America/Chicago");
}

/** Check the records a to-do is about, and file a contact's or opportunity's under its account. */
async function settleLinks(
  tx: Db,
  orgId: string,
  links: {
    leadId?: string | null;
    contactId?: string | null;
    accountId?: string | null;
    opportunityId?: string | null;
  },
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const live = (table: any, id: string): Promise<Record<string, unknown>[]> =>
    tx
      .select()
      .from(table)
      .where(and(eq(table.id, id), eq(table.orgId, orgId), isNull(table.deletedAt)));
  let accountId = links.accountId ?? null;
  if (links.leadId) {
    const [lead] = await live(leads, links.leadId);
    if (!lead) throw new ValidationError("Lead not found");
    if (lead.convertedAt) {
      throw new ValidationError("This lead was converted. Add the to-do on the contact.");
    }
  }
  for (const [id, table, what] of [
    [links.contactId, contacts, "Contact"],
    [links.opportunityId, opportunities, "Opportunity"],
  ] as const) {
    if (!id) continue;
    const [row] = (await live(table, id)) as { accountId: string }[];
    if (!row) throw new ValidationError(`${what} not found`);
    if (accountId && links.accountId && row.accountId !== accountId) {
      throw new ValidationError(`That ${what.toLowerCase()} belongs to a different account`);
    }
    accountId = row.accountId;
  }
  if (accountId) {
    const [account] = await live(accounts, accountId);
    if (!account) throw new ValidationError("Account not found");
  }
  return {
    leadId: links.leadId ?? null,
    contactId: links.contactId ?? null,
    accountId,
    opportunityId: links.opportunityId ?? null,
  };
}

async function loadTodo(tx: Db, actor: Actor, id: string, lock = false): Promise<Row> {
  const q = tx
    .select()
    .from(todos)
    .where(and(eq(todos.id, id), eq(todos.orgId, actor.orgId), isNull(todos.deletedAt)));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw new NotFoundError("to-do");
  requireRecord(actor.permissions, "activities", "view", row, actor.userId);
  return row;
}

export async function createTodo(db: Db, actor: Actor, raw: unknown) {
  if (!canCreate(actor.permissions, "activities")) throw new PermissionError("activities.create");
  const input = todoInput.parse(raw);
  const ownerId = input.ownerId ?? actor.userId;
  return db.transaction(async (tx) => {
    if (ownerId !== actor.userId && !(await isMember(tx, actor.orgId, ownerId))) {
      throw new ValidationError("That person is not in this organization");
    }
    const links = await settleLinks(tx, actor.orgId, input);
    const [row] = await tx
      .insert(todos)
      .values({
        orgId: actor.orgId,
        ownerId,
        createdBy: actor.userId,
        type: input.type ?? "todo",
        title: input.title,
        notes: input.notes ?? null,
        dueOn: input.dueOn,
        ...links,
      })
      .returning();
    await recordLifecycle(tx, actor, "todo", row.id, "create");
    return row;
  });
}

export async function updateTodo(db: Db, actor: Actor, id: string, raw: unknown) {
  const patch = todoInput
    .pick({ title: true, notes: true, type: true, dueOn: true, ownerId: true })
    .partial()
    .parse(raw);
  return db.transaction(async (tx) => {
    const before = await loadTodo(tx, actor, id, true);
    requireRecord(actor.permissions, "activities", "edit", before, actor.userId);
    if (patch.ownerId && !(await isMember(tx, actor.orgId, patch.ownerId))) {
      throw new ValidationError("That person is not in this organization");
    }
    const changes = diffFields(before, patch);
    if (changes.length === 0) return before;
    const [after] = await tx
      .update(todos)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(todos.id, id))
      .returning();
    await recordUpdate(tx, actor, "todo", id, changes);
    return after;
  });
}

const ACTIVITY_FOR: Partial<Record<Row["type"], "call" | "email" | "linkedin" | "meeting">> = {
  call: "call",
  email: "email",
  linkedin: "linkedin",
  meeting: "meeting",
};

/**
 * Mark a to-do done. A call, email, LinkedIn or meeting to-do about a person
 * or record also goes on their activity timeline, with any note.
 */
export async function completeTodo(db: Db, actor: Actor, id: string, raw: unknown) {
  const { note } = z.object({ note: optionalText }).parse(raw ?? {});
  return db.transaction(async (tx) => {
    const before = await loadTodo(tx, actor, id, true);
    requireRecord(actor.permissions, "activities", "edit", before, actor.userId);
    if (before.state === "done") throw new ValidationError("This to-do is already done");
    const at = new Date();
    const [after] = await tx
      .update(todos)
      .set({ state: "done", doneAt: at, doneBy: actor.userId, updatedAt: at })
      .where(eq(todos.id, id))
      .returning();
    await recordUpdate(tx, actor, "todo", id, [
      { field: "state", oldValue: "open", newValue: "done" },
    ]);
    const kind = ACTIVITY_FOR[before.type];
    const about = before.leadId || before.contactId || before.accountId || before.opportunityId;
    if (kind && about) {
      const body = [before.notes, note].filter(Boolean).join("\n\n");
      await tx.insert(activities).values({
        orgId: actor.orgId,
        ownerId: actor.userId,
        type: kind,
        subject: before.title,
        body: body || null,
        occurredAt: at,
        leadId: before.leadId,
        contactId: before.contactId,
        accountId: before.accountId,
        opportunityId: before.opportunityId,
      });
    }
    return after;
  });
}

export async function reopenTodo(db: Db, actor: Actor, id: string) {
  return db.transaction(async (tx) => {
    const before = await loadTodo(tx, actor, id, true);
    requireRecord(actor.permissions, "activities", "edit", before, actor.userId);
    if (before.state === "open") return before;
    const [after] = await tx
      .update(todos)
      .set({ state: "open", doneAt: null, doneBy: null, updatedAt: new Date() })
      .where(eq(todos.id, id))
      .returning();
    await recordUpdate(tx, actor, "todo", id, [
      { field: "state", oldValue: "done", newValue: "open" },
    ]);
    return after;
  });
}

export async function deleteTodo(db: Db, actor: Actor, id: string) {
  await db.transaction(async (tx) => {
    const row = await loadTodo(tx, actor, id, true);
    // Whoever made a to-do, or whoever it is for, may remove it; otherwise the delete right decides.
    if (row.createdBy !== actor.userId && row.ownerId !== actor.userId) {
      requireRecord(actor.permissions, "activities", "delete", row, actor.userId);
    }
    await tx.update(todos).set({ deletedAt: new Date() }).where(eq(todos.id, id));
    await recordLifecycle(tx, actor, "todo", id, "delete");
  });
}

export const todoQuery = z.object({
  /** "me" (the default), "all", or a user's id. */
  owner: z.union([z.literal("me"), z.literal("all"), z.uuid()]).optional(),
  /** "due": open and due today or earlier; "open": all open; "done": finished; "any". */
  show: z.enum(["due", "open", "done", "any"]).optional(),
  leadId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  opportunityId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** To-dos, soonest first, with the names of who and what they are about. */
export async function listTodos(db: Db, actor: Actor, raw: unknown) {
  const scope = scopeFor(actor.permissions, "activities", "view");
  if (scope === "none") throw new PermissionError("activities.view");
  const q = todoQuery.parse(raw);
  const owner =
    q.owner ?? (q.leadId || q.contactId || q.accountId || q.opportunityId ? "all" : "me");
  const ownerId = owner === "me" ? actor.userId : owner === "all" ? null : owner;
  if (
    ownerId &&
    ownerId !== actor.userId &&
    !canUse(actor.permissions, "sequences.manage_others") &&
    !(q.leadId || q.contactId || q.accountId || q.opportunityId)
  ) {
    throw new PermissionError("sequences.manage_others");
  }
  const show = q.show ?? "open";
  const where: SQL[] = [eq(todos.orgId, actor.orgId), isNull(todos.deletedAt)];
  if (scope === "own") where.push(eq(todos.ownerId, actor.userId));
  if (ownerId) where.push(eq(todos.ownerId, ownerId));
  if (show === "due" || show === "open") where.push(eq(todos.state, "open"));
  if (show === "done") where.push(eq(todos.state, "done"));
  if (show === "due")
    where.push(lte(todos.dueOn, await todayFor(db, actor.orgId, ownerId ?? actor.userId)));
  for (const [value, column] of [
    [q.leadId, todos.leadId],
    [q.contactId, todos.contactId],
    [q.accountId, todos.accountId],
    [q.opportunityId, todos.opportunityId],
  ] as const) {
    if (value) where.push(eq(column, value));
  }
  return db
    .select({
      id: todos.id,
      type: todos.type,
      title: todos.title,
      notes: todos.notes,
      dueOn: todos.dueOn,
      state: todos.state,
      doneAt: todos.doneAt,
      ownerId: todos.ownerId,
      ownerName: users.name,
      createdBy: todos.createdBy,
      leadId: todos.leadId,
      contactId: todos.contactId,
      accountId: todos.accountId,
      opportunityId: todos.opportunityId,
      personName: sql<string | null>`coalesce(
        ${contacts.firstName} || ' ' || ${contacts.lastName},
        ${leads.firstName} || ' ' || ${leads.lastName})`,
      accountName: accounts.name,
      opportunityName: opportunities.name,
    })
    .from(todos)
    .leftJoin(users, eq(todos.ownerId, users.id))
    .leftJoin(leads, eq(todos.leadId, leads.id))
    .leftJoin(contacts, eq(todos.contactId, contacts.id))
    .leftJoin(accounts, eq(todos.accountId, accounts.id))
    .leftJoin(opportunities, eq(todos.opportunityId, opportunities.id))
    .where(and(...where))
    .orderBy(asc(todos.dueOn), asc(todos.createdAt))
    .limit(q.limit ?? 200);
}
