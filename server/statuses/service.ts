import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  contacts,
  leads,
  opportunities,
  opportunityStageHistory,
  STATUS_COLORS,
  STATUS_EFFECTS,
  STATUS_OBJECTS,
  statusOptions,
  type StatusEffect,
  type StatusObject,
} from "../../shared/schema";
import { diffFields, recordLifecycle, recordUpdate } from "../audit/history";
import type { Actor } from "../auth/actor";
import { requireTool } from "../auth/permissions";
import type { Ctx, Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";
import { stopForPerson } from "../sequences/engine";
import { DEFAULT_STATUSES } from "./defaults";

/**
 * Status options: the list of statuses each organization offers for leads,
 * contacts, accounts and opportunities (where they are the pipeline stages).
 *
 * Records store the status by name. Renaming an option renames it on every
 * record that has it; deleting one that is in use moves those records to a
 * replacement. Both write a history entry per record, in the same transaction.
 */

/** The table that carries each kind of status. */
const TABLES = { leads, contacts, accounts, opportunities } as const;
const RECORD_TYPE = {
  leads: "lead",
  contacts: "contact",
  accounts: "account",
  opportunities: "opportunity",
} as const;

/** Which effects make sense for which kind of record. */
const EFFECTS: Record<StatusObject, StatusEffect[]> = {
  leads: ["none", "ends_sequence", "do_not_contact"],
  contacts: ["none", "ends_sequence", "do_not_contact"],
  accounts: ["none"],
  opportunities: ["none", "won", "lost"],
};

type Option = typeof statusOptions.$inferSelect;

// ------------------------------------------------- used by other services

/** Create the starting statuses for a new organization. */
export async function seedStatusOptions(tx: Db, orgId: string): Promise<void> {
  const rows = STATUS_OBJECTS.flatMap((object) =>
    DEFAULT_STATUSES[object].map((status, i) => ({
      orgId,
      object,
      name: status.name,
      position: i + 1,
      isDefault: i === 0,
      effect: status.effect ?? ("none" as const),
      color: status.color,
      probability: status.probability ?? null,
    })),
  );
  await tx.insert(statusOptions).values(rows);
}

async function optionsFor(tx: Db, orgId: string, object: StatusObject): Promise<Option[]> {
  return tx
    .select()
    .from(statusOptions)
    .where(and(eq(statusOptions.orgId, orgId), eq(statusOptions.object, object)))
    .orderBy(asc(statusOptions.position));
}

export async function listStatusNames(tx: Db, orgId: string, object: StatusObject): Promise<string[]> {
  return (await optionsFor(tx, orgId, object)).map((o) => o.name);
}

/** The status a new record gets when none is chosen. */
export async function defaultStatus(tx: Db, orgId: string, object: StatusObject): Promise<string> {
  const options = await optionsFor(tx, orgId, object);
  const chosen = options.find((o) => o.isDefault) ?? options[0];
  if (!chosen) throw new ValidationError(`No statuses are set up for ${object}`);
  return chosen.name;
}

/**
 * Check a status against the organization's list and return it spelled the
 * way the list spells it.
 */
export async function resolveStatus(
  tx: Db,
  orgId: string,
  object: StatusObject,
  name: string,
): Promise<string> {
  const wanted = name.trim().toLowerCase();
  const match = (await optionsFor(tx, orgId, object)).find((o) => o.name.toLowerCase() === wanted);
  if (!match) throw new ValidationError(`"${name}" is not one of your ${object} statuses`);
  return match.name;
}

/** What a status does, or "none" when the name is no longer on the list. */
export async function statusEffect(
  tx: Db,
  orgId: string,
  object: StatusObject,
  name: string,
): Promise<StatusEffect> {
  const [row] = await tx
    .select({ effect: statusOptions.effect })
    .from(statusOptions)
    .where(
      and(
        eq(statusOptions.orgId, orgId),
        eq(statusOptions.object, object),
        eq(statusOptions.name, name),
      ),
    );
  return row?.effect ?? "none";
}

// ------------------------------------------------------- the Admin screen

/** Every member can read the lists: the forms and badges need them. */
export async function listStatuses(db: Db, actor: Actor) {
  const rows = await db
    .select()
    .from(statusOptions)
    .where(eq(statusOptions.orgId, actor.orgId))
    .orderBy(asc(statusOptions.object), asc(statusOptions.position));
  const inUse = new Map<string, number>();
  for (const object of STATUS_OBJECTS) {
    const table = TABLES[object];
    const counts = await db
      .select({ status: table.status, n: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.orgId, actor.orgId))
      .groupBy(table.status);
    for (const c of counts) inUse.set(`${object}:${c.status}`, c.n);
  }
  return rows.map((r) => ({
    id: r.id,
    object: r.object,
    name: r.name,
    position: r.position,
    isDefault: r.isDefault,
    effect: r.effect,
    color: r.color,
    probability: r.probability,
    /** Records with this status, including deleted ones, which keep it. */
    inUse: inUse.get(`${r.object}:${r.name}`) ?? 0,
  }));
}

const name = z.string().trim().min(1).max(40);
export const createStatusInput = z.object({
  object: z.enum(STATUS_OBJECTS),
  name,
  effect: z.enum(STATUS_EFFECTS).optional(),
  color: z.enum(STATUS_COLORS).optional(),
});
export const updateStatusInput = z
  .object({
    name,
    effect: z.enum(STATUS_EFFECTS),
    color: z.enum(STATUS_COLORS),
    /** Opportunity stages only: the chance of winning, 0 to 100. */
    probability: z.number().int().min(0).max(100).nullable(),
    /** Only `true` is accepted: the default moves when another status takes it. */
    isDefault: z.literal(true),
  })
  .partial();

function checkEffect(object: StatusObject, effect: StatusEffect | undefined) {
  if (effect && !EFFECTS[object].includes(effect)) {
    throw new ValidationError(`That behavior does not apply to ${object}`);
  }
}

async function checkNameFree(tx: Db, orgId: string, object: StatusObject, wanted: string, except?: string) {
  const clash = (await optionsFor(tx, orgId, object)).find(
    (o) => o.id !== except && o.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (clash) throw new ValidationError(`There is already a status called "${clash.name}"`);
}

async function loadOption(tx: Db, actor: Ctx, id: string): Promise<Option> {
  const [row] = await tx
    .select()
    .from(statusOptions)
    .where(and(eq(statusOptions.id, id), eq(statusOptions.orgId, actor.orgId)))
    .for("update");
  if (!row) throw new NotFoundError("status");
  return row;
}

/**
 * Change the status of every record that has `from` to `to`, with a history
 * entry for each. Returns the ids changed.
 */
async function moveRecords(
  tx: Db,
  actor: Ctx,
  object: StatusObject,
  from: string,
  to: string,
): Promise<string[]> {
  if (from === to) return [];
  const table = TABLES[object];
  await tx.execute(sql`
    insert into field_history (org_id, record_type, record_id, action, field, old_value, new_value, source, user_id)
    select org_id, ${RECORD_TYPE[object]}, id, 'update', 'status', status, ${to}, 'system', ${actor.userId}
    from ${table} where org_id = ${actor.orgId} and status = ${from}
  `);
  const moved = await tx
    .update(table)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(table.orgId, actor.orgId), eq(table.status, from)))
    .returning({ id: table.id });
  return moved.map((m) => m.id);
}

export async function createStatus(db: Db, actor: Actor, raw: unknown) {
  requireTool(actor.permissions, "setup.org_settings");
  const input = createStatusInput.parse(raw);
  checkEffect(input.object, input.effect);
  await db.transaction(async (tx) => {
    await checkNameFree(tx, actor.orgId, input.object, input.name);
    const existing = await optionsFor(tx, actor.orgId, input.object);
    const [row] = await tx
      .insert(statusOptions)
      .values({
        orgId: actor.orgId,
        object: input.object,
        name: input.name,
        position: Math.max(0, ...existing.map((o) => o.position)) + 1,
        isDefault: existing.length === 0,
        effect: input.effect ?? "none",
        color: input.color ?? "neutral",
      })
      .returning();
    await recordLifecycle(tx, actor, "status_option", row.id, "create");
  });
  return listStatuses(db, actor);
}

export async function updateStatus(db: Db, actor: Actor, id: string, raw: unknown) {
  requireTool(actor.permissions, "setup.org_settings");
  const patch = updateStatusInput.parse(raw);
  await db.transaction(async (tx) => {
    const before = await loadOption(tx, actor, id);
    checkEffect(before.object, patch.effect);
    if (patch.probability != null && before.object !== "opportunities") {
      throw new ValidationError("Only opportunity stages have a probability");
    }
    if (patch.name !== undefined) await checkNameFree(tx, actor.orgId, before.object, patch.name, id);
    const changes = diffFields(before, patch);
    if (changes.length === 0) return;
    if (patch.isDefault) {
      await tx
        .update(statusOptions)
        .set({ isDefault: false })
        .where(and(eq(statusOptions.orgId, actor.orgId), eq(statusOptions.object, before.object)));
    }
    await tx
      .update(statusOptions)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(statusOptions.id, id));
    await recordUpdate(tx, actor, "status_option", id, changes);
    if (patch.name !== undefined) {
      await moveRecords(tx, actor, before.object, before.name, patch.name);
      if (before.object === "opportunities") {
        // The stage is the same stage under a new name, so past moves follow it.
        const mine = eq(opportunityStageHistory.orgId, actor.orgId);
        await tx
          .update(opportunityStageHistory)
          .set({ toStage: patch.name })
          .where(and(mine, eq(opportunityStageHistory.toStage, before.name)));
        await tx
          .update(opportunityStageHistory)
          .set({ fromStage: patch.name })
          .where(and(mine, eq(opportunityStageHistory.fromStage, before.name)));
      }
    }
    if (patch.effect !== undefined && before.object === "opportunities") {
      // A stage that becomes (or stops being) a closed one closes or reopens its deals.
      const closed = patch.effect === "won" || patch.effect === "lost";
      await tx
        .update(opportunities)
        .set({ closedAt: closed ? sql`coalesce(${opportunities.closedAt}, now())` : null })
        .where(
          and(
            eq(opportunities.orgId, actor.orgId),
            eq(opportunities.status, patch.name ?? before.name),
          ),
        );
    }
  });
  return listStatuses(db, actor);
}

export const reorderStatusInput = z.object({
  object: z.enum(STATUS_OBJECTS),
  ids: z.array(z.uuid()).min(1),
});

export async function reorderStatuses(db: Db, actor: Actor, raw: unknown) {
  requireTool(actor.permissions, "setup.org_settings");
  const { object, ids } = reorderStatusInput.parse(raw);
  await db.transaction(async (tx) => {
    const current = await optionsFor(tx, actor.orgId, object);
    const same =
      current.length === ids.length && current.every((o) => ids.includes(o.id)) && new Set(ids).size === ids.length;
    if (!same) throw new ValidationError("The order must list every status exactly once");
    for (const [i, optionId] of ids.entries()) {
      await tx
        .update(statusOptions)
        .set({ position: i + 1 })
        .where(eq(statusOptions.id, optionId));
    }
  });
  return listStatuses(db, actor);
}

export const deleteStatusInput = z.object({ replaceWith: z.uuid().optional() });

/**
 * Delete a status. When records still have it they must be moved to
 * `replaceWith`. If the replacement ends sequences, the people moved onto it
 * have theirs ended, exactly as if each had been changed by hand.
 */
export async function deleteStatus(db: Db, actor: Actor, id: string, raw: unknown) {
  requireTool(actor.permissions, "setup.org_settings");
  const { replaceWith } = deleteStatusInput.parse(raw ?? {});
  await db.transaction(async (tx) => {
    const option = await loadOption(tx, actor, id);
    if (option.isDefault) {
      throw new ValidationError("Make another status the default before deleting this one");
    }
    const table = TABLES[option.object];
    const [{ n: inUse }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(and(eq(table.orgId, actor.orgId), eq(table.status, option.name)));
    if (inUse > 0) {
      if (!replaceWith || replaceWith === id) {
        throw new ValidationError(
          `${inUse} ${inUse === 1 ? "record has" : "records have"} this status. Choose a status to move ${
            inUse === 1 ? "it" : "them"
          } to.`,
        );
      }
      const target = await loadOption(tx, actor, replaceWith);
      if (target.object !== option.object) throw new ValidationError("Choose a status from the same list");
      const moved = await moveRecords(tx, actor, option.object, option.name, target.name);
      if (option.object === "opportunities" && moved.length > 0) {
        // Each deal moved stage: log it, and close or reopen it to match.
        const rows = await tx
          .select({ id: opportunities.id, amount: opportunities.amount })
          .from(opportunities)
          .where(inArray(opportunities.id, moved));
        await tx.insert(opportunityStageHistory).values(
          rows.map((r) => ({
            orgId: actor.orgId,
            opportunityId: r.id,
            fromStage: option.name,
            toStage: target.name,
            amount: r.amount,
            changedBy: actor.userId,
          })),
        );
        const closed = target.effect === "won" || target.effect === "lost";
        await tx
          .update(opportunities)
          .set({ closedAt: closed ? sql`coalesce(${opportunities.closedAt}, now())` : null })
          .where(inArray(opportunities.id, moved));
      } else if (target.effect === "ends_sequence" || target.effect === "do_not_contact") {
        for (const personId of moved) {
          const ref = option.object === "leads" ? { leadId: personId } : { contactId: personId };
          await stopForPerson(tx, actor, ref, "status_change");
        }
      }
    }
    await tx.delete(statusOptions).where(eq(statusOptions.id, id));
    await recordLifecycle(tx, actor, "status_option", id, "delete");
  });
  return listStatuses(db, actor);
}
