import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  contacts,
  CUSTOM_FIELD_OBJECTS,
  CUSTOM_FIELD_TYPES,
  customFields,
  fieldHistory,
  fieldLayouts,
  leads,
  opportunities,
  type CustomFieldObject,
  type CustomFieldType,
  type LayoutEntry,
} from "../../shared/schema";
import { diffFields, recordLifecycle, recordUpdate, type FieldChange } from "../audit/history";
import { isMember, type Actor } from "../auth/actor";
import { requireTool } from "../auth/permissions";
import type { Ctx, Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";

/**
 * Custom fields and record layouts.
 *
 * An organization's admins add fields to leads, contacts, accounts and
 * opportunities, and arrange every field (Bagger's own and theirs) on the
 * record page. Values live on each record in `custom`, keyed by the field's
 * key, which never changes after the field is made.
 */

export const TABLES = { leads, contacts, accounts, opportunities } as const;
const RECORD_TYPE = {
  leads: "lead",
  contacts: "contact",
  accounts: "account",
  opportunities: "opportunity",
} as const;

/**
 * Bagger's own fields, in their standard order. `locked` ones can be moved
 * but not hidden: Bagger needs them to work.
 */
export const BUILT_IN: Record<CustomFieldObject, { name: string; locked?: boolean }[]> = {
  leads: [
    { name: "firstName", locked: true },
    { name: "lastName", locked: true },
    { name: "title" },
    { name: "email", locked: true },
    { name: "company" },
    { name: "cellPhone" },
    { name: "directPhone" },
    { name: "hqPhone" },
    { name: "linkedin" },
    { name: "status", locked: true },
    { name: "ownerId", locked: true },
    { name: "notes" },
  ],
  contacts: [
    { name: "firstName", locked: true },
    { name: "lastName", locked: true },
    { name: "title" },
    { name: "email", locked: true },
    { name: "accountId", locked: true },
    { name: "cellPhone" },
    { name: "directPhone" },
    { name: "hqPhone" },
    { name: "linkedin" },
    { name: "status", locked: true },
    { name: "ownerId", locked: true },
    { name: "notes" },
  ],
  accounts: [
    { name: "name", locked: true },
    { name: "website" },
    { name: "linkedin" },
    { name: "hqPhone" },
    { name: "status", locked: true },
    { name: "ownerId", locked: true },
    { name: "notes" },
  ],
  opportunities: [
    { name: "name", locked: true },
    { name: "accountId", locked: true },
    { name: "contactId" },
    { name: "amount" },
    { name: "closeDate" },
    { name: "status", locked: true },
    { name: "ownerId", locked: true },
    { name: "notes" },
  ],
};

export const MAX_FIELDS_PER_OBJECT = 100;
const PICKLISTS: CustomFieldType[] = ["picklist", "multipicklist"];

export type FieldDef = typeof customFields.$inferSelect;

export async function loadDefs(
  tx: Db,
  orgId: string,
  object: CustomFieldObject,
  includeArchived = false,
): Promise<FieldDef[]> {
  return tx
    .select()
    .from(customFields)
    .where(
      and(
        eq(customFields.orgId, orgId),
        eq(customFields.object, object),
        ...(includeArchived ? [] : [isNull(customFields.archivedAt)]),
      ),
    )
    .orderBy(asc(customFields.createdAt));
}

// ------------------------------------------------------------- values

/** How a stored value reads in History and in messages. */
export function showValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.join("; ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

const TRUE = new Set(["true", "yes", "y", "1", "x", "checked"]);
const FALSE = new Set(["false", "no", "n", "0", ""]);

/**
 * Turn what was typed, sent or read from a CSV cell into the stored value.
 * Returns null for "empty". Throws a message a person can read.
 */
export function coerce(def: FieldDef, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  if (Array.isArray(raw) && raw.length === 0) return null;
  const text = typeof raw === "string" ? raw.trim() : raw;
  const fail = (why: string): never => {
    throw new ValidationError(`${def.label}: ${why}`);
  };
  const asNumber = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || Math.abs(n) >= 1e13) fail("enter a number");
    return n;
  };
  const pick = (v: string) => {
    const match = def.options.find((o) => o.toLowerCase() === v.trim().toLowerCase());
    if (!match) fail(`"${v.trim()}" is not one of the choices`);
    return match!;
  };
  switch (def.type) {
    case "text":
    case "phone":
      if (typeof text !== "string" && typeof text !== "number") fail("enter text");
      if (String(text).length > 1000) fail("too long");
      return String(text);
    case "longtext":
      if (typeof text !== "string") fail("enter text");
      if ((text as string).length > 10000) fail("too long");
      return text;
    case "number":
      return asNumber(text);
    case "currency":
      return Math.round(asNumber(text) * 100) / 100;
    case "date": {
      const v = String(text);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) fail("use a date such as 2026-12-31");
      return v;
    }
    case "checkbox": {
      if (typeof text === "boolean") return text;
      const v = String(text).toLowerCase();
      if (TRUE.has(v)) return true;
      if (FALSE.has(v)) return false;
      return fail("use yes or no");
    }
    case "picklist":
      return pick(String(text));
    case "multipicklist": {
      const parts = Array.isArray(text) ? text.map(String) : String(text).split(/[;,]/);
      const chosen = [...new Set(parts.filter((p) => p.trim() !== "").map(pick))];
      return chosen.length > 0 ? def.options.filter((o) => chosen.includes(o)) : null;
    }
    case "url": {
      const v = String(text);
      return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
    }
    case "email": {
      const parsed = z.email().safeParse(String(text).toLowerCase());
      if (!parsed.success) fail("enter a valid email address");
      return parsed.data;
    }
    case "user": {
      const parsed = z.uuid().safeParse(text);
      if (!parsed.success) fail("choose a user");
      return parsed.data;
    }
  }
}

export const customInput = z.record(z.string(), z.unknown()).optional();

/**
 * Check the custom values in a create or update and merge them into what the
 * record already has. Keys not given are left alone; an empty value clears
 * one. Returns the merged values and one history change per field changed.
 *
 * `requireAll` (creating from a form) needs every required field filled in.
 * On an update only the fields being changed are checked, so an old record
 * missing a value can still be edited elsewhere. Imports check nothing
 * required and report the gaps instead.
 */
export async function settleCustom(
  tx: Db,
  ctx: Ctx,
  object: CustomFieldObject,
  raw: Record<string, unknown> | undefined,
  options: { before?: Record<string, unknown>; requireAll?: boolean; requireChanged?: boolean; defs?: FieldDef[] },
): Promise<{ custom: Record<string, unknown>; changes: FieldChange[]; missing: string[] }> {
  const defs = options.defs ?? (await loadDefs(tx, ctx.orgId, object));
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const before = options.before ?? {};
  const custom: Record<string, unknown> = { ...before };
  const changes: FieldChange[] = [];

  for (const [key, value] of Object.entries(raw ?? {})) {
    const def = byKey.get(key);
    if (!def) throw new ValidationError(`There is no field called "${key}"`);
    const next = coerce(def, value);
    if (next === null && def.required && options.requireChanged) {
      throw new ValidationError(`${def.label} is required`);
    }
    if (def.type === "user" && next !== null && !(await isMember(tx, ctx.orgId, next as string))) {
      throw new ValidationError(`${def.label}: that user is not in this organization`);
    }
    const oldShown = showValue(before[key]);
    const newShown = showValue(next);
    if (next === null) delete custom[key];
    else custom[key] = next;
    if (oldShown !== newShown) changes.push({ field: `custom.${key}`, oldValue: oldShown, newValue: newShown });
  }

  const missing = defs.filter((d) => d.required && custom[d.key] === undefined).map((d) => d.label);
  if (options.requireAll && missing.length > 0) {
    throw new ValidationError(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required`);
  }
  return { custom, changes, missing };
}

// --------------------------------------------------------- admin screen

/** Everything Admin → Fields shows, and what the record pages need to lay themselves out. */
export async function fieldSetup(db: Db, actor: Actor) {
  const defs = await db
    .select()
    .from(customFields)
    .where(eq(customFields.orgId, actor.orgId))
    .orderBy(asc(customFields.createdAt));
  const layouts = await db.select().from(fieldLayouts).where(eq(fieldLayouts.orgId, actor.orgId));
  return {
    fields: defs.map((d) => ({
      id: d.id,
      object: d.object,
      key: d.key,
      label: d.label,
      type: d.type,
      required: d.required,
      options: d.options,
      archived: d.archivedAt !== null,
    })),
    layouts: Object.fromEntries(layouts.map((l) => [l.object, l.entries])) as Partial<
      Record<CustomFieldObject, LayoutEntry[]>
    >,
    builtIn: BUILT_IN,
  };
}

/** "Current ERP system" -> "currentErpSystem", made unique among the record type's fields. */
function makeKey(label: string, taken: Set<string>): string {
  const words = label
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let base =
    words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("") ||
    "field";
  if (/^\d/.test(base)) base = `f${base}`;
  base = base.slice(0, 40);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`;
  return key;
}

const label = z.string().trim().min(1).max(60);
const optionList = z
  .array(z.string().trim().min(1).max(80))
  .max(200)
  .refine((list) => new Set(list.map((o) => o.toLowerCase())).size === list.length, {
    message: "Each choice can appear only once",
  });

export const createFieldInput = z.object({
  object: z.enum(CUSTOM_FIELD_OBJECTS),
  label,
  type: z.enum(CUSTOM_FIELD_TYPES),
  required: z.boolean().optional(),
  options: optionList.optional(),
});

export async function createField(db: Db, actor: Actor, raw: unknown) {
  requireTool(actor.permissions, "setup.org_settings");
  const input = createFieldInput.parse(raw);
  const options = PICKLISTS.includes(input.type) ? (input.options ?? []) : [];
  if (PICKLISTS.includes(input.type) && options.length === 0) {
    throw new ValidationError("Add at least one choice");
  }
  await db.transaction(async (tx) => {
    const existing = await loadDefs(tx, actor.orgId, input.object, true);
    if (existing.filter((d) => !d.archivedAt).length >= MAX_FIELDS_PER_OBJECT) {
      throw new ValidationError(`A record type can have up to ${MAX_FIELDS_PER_OBJECT} custom fields`);
    }
    const clash = existing.find((d) => !d.archivedAt && d.label.toLowerCase() === input.label.toLowerCase());
    if (clash) throw new ValidationError(`There is already a field called "${clash.label}"`);
    const taken = new Set([...existing.map((d) => d.key), ...BUILT_IN[input.object].map((b) => b.name)]);
    const [row] = await tx
      .insert(customFields)
      .values({
        orgId: actor.orgId,
        object: input.object,
        key: makeKey(input.label, taken),
        label: input.label,
        type: input.type,
        required: input.required ?? false,
        options,
      })
      .returning();
    await recordLifecycle(tx, actor, "custom_field", row.id, "create");
  });
  return fieldSetup(db, actor);
}

export const updateFieldInput = z.object({
  label: label.optional(),
  required: z.boolean().optional(),
  archived: z.boolean().optional(),
  /** The full new list of choices, in order. */
  options: optionList.optional(),
  /** Choices that were renamed: { old: new }. Records follow the new name. */
  renamed: z.record(z.string(), z.string()).optional(),
  /** Choices removed while in use: { removed: replacement }, or null to clear them. */
  replace: z.record(z.string(), z.string().nullable()).optional(),
});

async function loadField(tx: Db, actor: Ctx, id: string): Promise<FieldDef> {
  const [row] = await tx
    .select()
    .from(customFields)
    .where(and(eq(customFields.id, id), eq(customFields.orgId, actor.orgId)))
    .for("update");
  if (!row) throw new NotFoundError("field");
  return row;
}

/** Records that have a value for this field: id and the value. */
async function recordsWith(tx: Db, ctx: Ctx, def: FieldDef) {
  const table = TABLES[def.object];
  return tx
    .select({ id: table.id, custom: table.custom })
    .from(table)
    .where(and(eq(table.orgId, ctx.orgId), sql`${table.custom} ? ${def.key}`));
}

/** How many records use each choice of a picklist, and how many have any value at all. */
export async function fieldUsage(db: Db, actor: Actor, id: string) {
  requireTool(actor.permissions, "setup.org_settings");
  const def = await loadField(db, actor, id);
  const rows = await recordsWith(db, actor, def);
  const byOption: Record<string, number> = {};
  for (const r of rows) {
    const v = r.custom[def.key];
    for (const o of Array.isArray(v) ? v : [v]) byOption[String(o)] = (byOption[String(o)] ?? 0) + 1;
  }
  return { filled: rows.length, byOption };
}

export async function updateField(db: Db, actor: Actor, id: string, raw: unknown) {
  requireTool(actor.permissions, "setup.org_settings");
  const input = updateFieldInput.parse(raw);
  await db.transaction(async (tx) => {
    const before = await loadField(tx, actor, id);
    const patch: Partial<FieldDef> = {};
    if (input.label !== undefined && input.label !== before.label) {
      const clash = (await loadDefs(tx, actor.orgId, before.object)).find(
        (d) => d.id !== id && d.label.toLowerCase() === input.label!.toLowerCase(),
      );
      if (clash) throw new ValidationError(`There is already a field called "${clash.label}"`);
      patch.label = input.label;
    }
    if (input.required !== undefined) patch.required = input.required;
    if (input.archived !== undefined) patch.archivedAt = input.archived ? (before.archivedAt ?? new Date()) : null;

    // Picklist choices: rename and replace values on the records that have them.
    const valueMoves = new Map<string, string | null>();
    if (input.options !== undefined) {
      if (!PICKLISTS.includes(before.type)) throw new ValidationError("Only picklists have choices");
      if (input.options.length === 0) throw new ValidationError("Keep at least one choice");
      const renamed = input.renamed ?? {};
      for (const [from, to] of Object.entries(renamed)) {
        if (!before.options.includes(from) || !input.options.includes(to)) {
          throw new ValidationError(`Can't rename "${from}" to "${to}"`);
        }
        if (from !== to) valueMoves.set(from, to);
      }
      const removed = before.options.filter((o) => !input.options!.includes(o) && !(o in renamed));
      const usage = removed.length > 0 ? (await fieldUsage(tx, actor, id)).byOption : {};
      const stuck = removed.filter((o) => (usage[o] ?? 0) > 0 && !(o in (input.replace ?? {})));
      if (stuck.length > 0) {
        const n = stuck.reduce((sum, o) => sum + usage[o], 0);
        throw new ValidationError(
          `${n} ${n === 1 ? "record uses" : "records use"} ${stuck.map((o) => `"${o}"`).join(", ")}. Choose what to change ${n === 1 ? "it" : "them"} to.`,
        );
      }
      for (const o of removed) {
        const to = input.replace?.[o] ?? null;
        if (to !== null && !input.options.includes(to)) throw new ValidationError(`"${to}" is not one of the choices`);
        valueMoves.set(o, to);
      }
      patch.options = input.options;
    }

    const changes = diffFields(before, patch);
    if (changes.length === 0 && valueMoves.size === 0) return;
    await tx
      .update(customFields)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(customFields.id, id));
    await recordUpdate(tx, actor, "custom_field", id, changes);

    if (valueMoves.size > 0) {
      const table = TABLES[before.object];
      for (const r of await recordsWith(tx, actor, before)) {
        const old = r.custom[before.key];
        let next: unknown = old;
        if (Array.isArray(old)) {
          const moved = old.map((o) => (valueMoves.has(o) ? valueMoves.get(o) : o)).filter((o) => o !== null);
          next = [...new Set(moved)];
          next = (patch.options ?? before.options).filter((o) => (next as unknown[]).includes(o));
          if ((next as unknown[]).length === 0) next = null;
        } else if (valueMoves.has(String(old))) {
          next = valueMoves.get(String(old));
        }
        if (showValue(next) === showValue(old)) continue;
        const custom = { ...r.custom };
        if (next === null) delete custom[before.key];
        else custom[before.key] = next;
        await tx.update(table).set({ custom, updatedAt: new Date() }).where(eq(table.id, r.id));
        await tx.insert(fieldHistory).values({
          orgId: actor.orgId,
          recordType: RECORD_TYPE[before.object],
          recordId: r.id,
          action: "update",
          field: `custom.${before.key}`,
          oldValue: showValue(old),
          newValue: showValue(next),
          source: "system",
          userId: actor.userId,
        });
      }
    }
  });
  return fieldSetup(db, actor);
}

const layoutInput = z.object({
  object: z.enum(CUSTOM_FIELD_OBJECTS),
  entries: z
    .array(
      z.object({
        field: z.string().min(1),
        width: z.enum(["third", "half", "full"]),
        hidden: z.boolean().optional(),
      }),
    )
    .max(200),
});

/**
 * Save the order, widths and hidden fields of one record type's page. Fields
 * left out of the list keep their place at the end, so a new field always
 * shows up somewhere.
 */
export async function saveLayout(db: Db, actor: Actor, raw: unknown) {
  requireTool(actor.permissions, "setup.org_settings");
  const { object, entries } = layoutInput.parse(raw);
  await db.transaction(async (tx) => {
    const defs = await loadDefs(tx, actor.orgId, object, true);
    const known = new Map<string, { locked?: boolean }>([
      ...BUILT_IN[object].map((b) => [b.name, b] as const),
      ...defs.map((d) => [`custom.${d.key}`, {}] as const),
    ]);
    const seen = new Set<string>();
    for (const e of entries) {
      const field = known.get(e.field);
      if (!field) throw new ValidationError(`There is no field called "${e.field}"`);
      if (seen.has(e.field)) throw new ValidationError(`"${e.field}" is listed twice`);
      if (e.hidden && field.locked) throw new ValidationError("Bagger needs that field, so it can't be hidden");
      seen.add(e.field);
    }
    const clean: LayoutEntry[] = entries.map((e) => ({
      field: e.field,
      width: e.width,
      ...(e.hidden ? { hidden: true } : {}),
    }));
    await tx
      .insert(fieldLayouts)
      .values({ orgId: actor.orgId, object, entries: clean })
      .onConflictDoUpdate({
        target: [fieldLayouts.orgId, fieldLayouts.object],
        set: { entries: clean, updatedAt: new Date() },
      });
    await recordUpdate(tx, actor, "field_layout", actor.orgId, [
      { field: object, oldValue: null, newValue: clean.map((e) => e.field).join(", ") },
    ]);
  });
  return fieldSetup(db, actor);
}
