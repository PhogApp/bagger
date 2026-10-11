import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { fieldHistory, leads } from "../../shared/schema";
import { isMember, type Actor } from "../auth/actor";
import { canCreate, PermissionError, requireTool } from "../auth/permissions";
import type { Db } from "../db/types";
import { ValidationError } from "../errors";
import { leadInput } from "./index";

/**
 * Bulk import of leads, as rows already read from a CSV file by the browser.
 *
 * - A row that fails validation is reported and skipped; the rest still import.
 * - A row whose email already belongs to a lead in this organization, or
 *   appeared earlier in the same file, is skipped as a duplicate.
 * - Everything that does import is saved in one transaction, each with a
 *   "created by import" history entry.
 */

export const MAX_IMPORT_ROWS = 5000;

export const importInput = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_IMPORT_ROWS),
  ownerId: z.uuid().optional(),
});

export interface ImportResult {
  created: number;
  /** `row` is the row's position in the file's data, starting at 1. */
  duplicates: { row: number; email: string }[];
  errors: { row: number; message: string }[];
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** "firstName" -> "First name", for messages a person reads. */
function humanize(field: string): string {
  const words = field.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function importLeads(db: Db, actor: Actor, raw: unknown): Promise<ImportResult> {
  requireTool(actor.permissions, "data.import");
  if (!canCreate(actor.permissions, "leads")) throw new PermissionError("leads.create");
  const { rows, ownerId } = importInput.parse(raw);
  if (ownerId && !(await isMember(db, actor.orgId, ownerId))) {
    throw new ValidationError("Owner is not a user in this organization");
  }

  const result: ImportResult = { created: 0, duplicates: [], errors: [] };
  const valid: { row: number; values: z.infer<typeof leadInput> }[] = [];
  const seen = new Set<string>();

  rows.forEach((source, index) => {
    const row = index + 1;
    // Blank cells mean "not provided", and the file never chooses the owner.
    const cleaned = Object.fromEntries(
      Object.entries(source).filter(
        ([key, value]) => key !== "ownerId" && !(typeof value === "string" && value.trim() === ""),
      ),
    );
    const parsed = leadInput.safeParse(cleaned);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const key = String(issue.path[0] ?? "");
      const field = humanize(key);
      const message = !key
        ? issue.message
        : cleaned[key] === undefined
          ? `${field} is missing`
          : `${field}: ${issue.message}`;
      result.errors.push({ row, message });
      return;
    }
    const email = parsed.data.email;
    if (seen.has(email)) {
      result.duplicates.push({ row, email });
      return;
    }
    seen.add(email);
    valid.push({ row, values: parsed.data });
  });

  if (valid.length === 0) return result;

  await db.transaction(async (tx) => {
    const existing = new Set<string>();
    for (const batch of chunks([...seen], 1000)) {
      const found = await tx
        .select({ email: leads.email })
        .from(leads)
        .where(
          and(eq(leads.orgId, actor.orgId), isNull(leads.deletedAt), inArray(leads.email, batch)),
        );
      for (const f of found) existing.add(f.email);
    }

    const fresh = valid.filter(({ row, values }) => {
      if (!existing.has(values.email)) return true;
      result.duplicates.push({ row, email: values.email });
      return false;
    });

    for (const batch of chunks(fresh, 500)) {
      const inserted = await tx
        .insert(leads)
        .values(
          batch.map(({ values }) => ({
            ...values,
            orgId: actor.orgId,
            ownerId: ownerId ?? actor.userId,
          })),
        )
        .returning({ id: leads.id });
      await tx.insert(fieldHistory).values(
        inserted.map((lead) => ({
          orgId: actor.orgId,
          recordType: "lead",
          recordId: lead.id,
          action: "create" as const,
          source: "import" as const,
          userId: actor.userId,
        })),
      );
      result.created += inserted.length;
    }
  });

  result.duplicates.sort((a, b) => a.row - b.row);
  return result;
}
