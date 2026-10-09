import { fieldHistory } from "../../shared/schema";
import type { Ctx, Db } from "../db/types";

export type HistorySource = "user" | "import" | "system";

/** Columns that change on every write and would only add noise. */
const IGNORED = new Set(["id", "orgId", "createdAt", "updatedAt"]);

function show(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/** Which fields in `patch` actually differ from `before`. */
export function diffFields(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, next] of Object.entries(patch)) {
    if (IGNORED.has(field) || next === undefined) continue;
    const oldValue = show(before[field]);
    const newValue = show(next);
    if (oldValue !== newValue) changes.push({ field, oldValue, newValue });
  }
  return changes;
}

/**
 * Write audit rows. Call with the same transaction as the change itself so a
 * change can never be saved without its history.
 */
export async function recordUpdate(
  tx: Db,
  ctx: Ctx,
  recordType: string,
  recordId: string,
  changes: FieldChange[],
  source: HistorySource = "user",
): Promise<void> {
  if (changes.length === 0) return;
  await tx.insert(fieldHistory).values(
    changes.map((c) => ({
      orgId: ctx.orgId,
      recordType,
      recordId,
      action: "update" as const,
      field: c.field,
      oldValue: c.oldValue,
      newValue: c.newValue,
      source,
      userId: ctx.userId,
    })),
  );
}

export async function recordLifecycle(
  tx: Db,
  ctx: Ctx,
  recordType: string,
  recordId: string,
  action: "create" | "delete",
  source: HistorySource = "user",
): Promise<void> {
  await tx.insert(fieldHistory).values({
    orgId: ctx.orgId,
    recordType,
    recordId,
    action,
    source,
    userId: ctx.userId,
  });
}
