import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { accounts, contacts, fieldHistory, leads } from "../../shared/schema";
import { diffFields, recordUpdate } from "../audit/history";
import { isMember, type Actor } from "../auth/actor";
import {
  canAccessRecord,
  canCreate,
  PermissionError,
  requireTool,
  type ObjectName,
} from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";
import { accountInput, contactInput, leadInput, optionalUrl } from "./index";

/**
 * Bulk import of leads, contacts or accounts, as rows already read from a
 * CSV file by the browser.
 *
 * What counts as "already in Bagger":
 *   - a lead or contact with the same email address,
 *   - an account with the same name, or the same website (compared by
 *     domain, so "https://www.acme.com/about" matches "acme.com").
 *
 * The caller picks a mode:
 *   - "check"  saves nothing and reports what an import would do,
 *   - "skip"   creates the new records and leaves existing ones alone,
 *   - "update" creates the new records and overwrites existing ones with
 *              the values in the file. Blank cells never erase anything,
 *              and the owner, status and (for contacts) account are kept.
 *
 * In every mode a row that fails validation, or repeats an earlier row of
 * the same file, is reported and left out. All saving happens in one
 * transaction together with its audit history (source "import").
 */

export const MAX_IMPORT_ROWS = 5000;
export const IMPORT_KINDS = ["leads", "contacts", "accounts"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const importInput = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_IMPORT_ROWS),
  mode: z.enum(["check", "skip", "update"]).default("skip"),
  ownerId: z.uuid().optional(),
});

/** `row` is the row's position in the submitted rows, starting at 1. */
export interface RowNote {
  row: number;
  /** The email or account name, to show the person. */
  label: string;
}

export interface ImportResult {
  mode: "check" | "skip" | "update";
  total: number;
  /** Records created; in "check" mode, records that would be created. */
  created: number;
  /** Existing records changed by the file ("update" mode only). */
  updated: number;
  /** Rows that match a record already in Bagger. */
  duplicates: RowNote[];
  /** Rows that repeat an earlier row of the same file. */
  repeats: RowNote[];
  errors: { row: number; message: string }[];
  /** Contacts only: accounts created (or that would be) for new contacts. */
  newAccounts: number;
}

const leadRow = leadInput.omit({ status: true, ownerId: true });
const accountRow = accountInput.omit({ status: true, ownerId: true });
const contactRow = contactInput.omit({ accountId: true, status: true, ownerId: true }).extend({
  accountName: z.string().trim().min(1),
  accountWebsite: optionalUrl,
});

const SCHEMAS = { leads: leadRow, contacts: contactRow, accounts: accountRow } as const;
const RECORD_TYPE = { leads: "lead", contacts: "contact", accounts: "account" } as const;

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

/** "https://www.Acme.com/about" -> "acme.com". Null when there is nothing usable. */
export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const host = url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "");
  return host === "" ? null : host;
}

const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

interface AccountRef {
  id: string;
  ownerId: string;
}

/** Every live account in the organization, findable by name or by website domain. */
class AccountIndex {
  private byName = new Map<string, AccountRef>();
  private byDomain = new Map<string, AccountRef>();

  static async load(tx: Db, orgId: string): Promise<AccountIndex> {
    const index = new AccountIndex();
    const rows = await tx
      .select({
        id: accounts.id,
        ownerId: accounts.ownerId,
        name: accounts.name,
        website: accounts.website,
      })
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), isNull(accounts.deletedAt)));
    for (const row of rows) index.add(row, row.name, row.website);
    return index;
  }

  add(ref: AccountRef, name: string, website: string | null | undefined) {
    const key = nameKey(name);
    if (!this.byName.has(key)) this.byName.set(key, ref);
    const domain = domainOf(website);
    if (domain && !this.byDomain.has(domain)) this.byDomain.set(domain, ref);
  }

  find(name: string, website: string | null | undefined): AccountRef | undefined {
    const domain = domainOf(website);
    return this.byName.get(nameKey(name)) ?? (domain ? this.byDomain.get(domain) : undefined);
  }
}

type Values = Record<string, unknown>;
interface ValidRow {
  row: number;
  values: Values;
  label: string;
}

export async function importRecords(
  db: Db,
  actor: Actor,
  kind: ImportKind,
  raw: unknown,
): Promise<ImportResult> {
  requireTool(actor.permissions, "data.import");
  if (!canCreate(actor.permissions, kind)) throw new PermissionError(`${kind}.create`);
  const { rows, mode, ownerId } = importInput.parse(raw);
  if (ownerId && !(await isMember(db, actor.orgId, ownerId))) {
    throw new ValidationError("Owner is not a user in this organization");
  }
  const newOwnerId = ownerId ?? actor.userId;
  const schema = SCHEMAS[kind];
  const recordType = RECORD_TYPE[kind];
  const table = kind === "leads" ? leads : kind === "contacts" ? contacts : accounts;

  const result: ImportResult = {
    mode,
    total: rows.length,
    created: 0,
    updated: 0,
    duplicates: [],
    repeats: [],
    errors: [],
    newAccounts: 0,
  };

  // ---- 1. validate each row, and drop rows that repeat an earlier one
  const valid: ValidRow[] = [];
  const seen = new Set<string>();
  rows.forEach((source, index) => {
    const row = index + 1;
    // Blank cells mean "not provided".
    const cleaned = Object.fromEntries(
      Object.entries(source).filter(
        ([, value]) => !(typeof value === "string" && value.trim() === ""),
      ),
    );
    const parsed = schema.safeParse(cleaned);
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
    // Only cells that held something are kept, so nothing is ever blanked.
    const values = Object.fromEntries(
      Object.entries(parsed.data as Values).filter(([, v]) => v !== null && v !== undefined),
    );
    let label: string;
    let keys: string[];
    if (kind === "accounts") {
      label = String(values.name);
      const domain = domainOf(values.website as string | undefined);
      keys = [`name:${nameKey(label)}`, ...(domain ? [`domain:${domain}`] : [])];
    } else {
      label = String(values.email);
      keys = [label];
    }
    if (keys.some((k) => seen.has(k))) {
      result.repeats.push({ row, label });
      return;
    }
    for (const k of keys) seen.add(k);
    valid.push({ row, values, label });
  });

  if (valid.length === 0) return result;

  await db.transaction(async (tx) => {
    // ---- 2. split into new rows and rows that match an existing record
    const accountIndex =
      kind === "leads" ? new AccountIndex() : await AccountIndex.load(tx, actor.orgId);
    const existingPeople = new Map<string, string>();
    if (kind !== "accounts") {
      const people = kind === "leads" ? leads : contacts;
      for (const batch of chunks(valid.map((v) => v.label), 1000)) {
        const found = await tx
          .select({ id: people.id, email: people.email })
          .from(people)
          .where(
            and(
              eq(people.orgId, actor.orgId),
              isNull(people.deletedAt),
              inArray(people.email, batch),
            ),
          );
        for (const f of found) existingPeople.set(f.email, f.id);
      }
    }

    const fresh: ValidRow[] = [];
    const matched: { item: ValidRow; id: string }[] = [];
    for (const item of valid) {
      const id =
        kind === "accounts"
          ? accountIndex.find(item.label, item.values.website as string | undefined)?.id
          : existingPeople.get(item.label);
      if (id) {
        matched.push({ item, id });
        result.duplicates.push({ row: item.row, label: item.label });
      } else {
        fresh.push(item);
      }
    }

    // ---- 3. contacts: find each new contact's account, creating it if needed
    const inserts: Values[] = [];
    if (kind === "contacts") {
      const mayCreateAccounts = canCreate(actor.permissions, "accounts");
      for (const item of fresh) {
        const { accountName, accountWebsite, ...person } = item.values as Values & {
          accountName: string;
          accountWebsite?: string;
        };
        let account = accountIndex.find(accountName, accountWebsite);
        if (!account) {
          if (!mayCreateAccounts) {
            result.errors.push({
              row: item.row,
              message: `No account named "${accountName}", and your role cannot create accounts`,
            });
            continue;
          }
          result.newAccounts += 1;
          if (mode === "check") {
            account = { id: "", ownerId: newOwnerId };
          } else {
            const [created] = await tx
              .insert(accounts)
              .values({
                orgId: actor.orgId,
                ownerId: newOwnerId,
                name: accountName,
                website: accountWebsite ?? null,
              })
              .returning({ id: accounts.id, ownerId: accounts.ownerId });
            await tx.insert(fieldHistory).values({
              orgId: actor.orgId,
              recordType: "account",
              recordId: created.id,
              action: "create",
              source: "import",
              userId: actor.userId,
            });
            account = created;
          }
          accountIndex.add(account, accountName, accountWebsite);
        }
        inserts.push({ ...person, accountId: account.id });
      }
    } else {
      for (const item of fresh) inserts.push(item.values);
    }

    result.created = inserts.length;
    if (mode === "check") return;

    // ---- 4. create the new records
    for (const batch of chunks(inserts, 500)) {
      const inserted = await tx
        .insert(table)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .values(batch.map((v) => ({ ...v, orgId: actor.orgId, ownerId: newOwnerId })) as any)
        .returning({ id: table.id });
      await tx.insert(fieldHistory).values(
        inserted.map((record) => ({
          orgId: actor.orgId,
          recordType,
          recordId: record.id,
          action: "create" as const,
          source: "import" as const,
          userId: actor.userId,
        })),
      );
    }

    // ---- 5. overwrite the existing records, if asked to
    if (mode !== "update") return;
    for (const { item, id } of matched) {
      const [before] = await tx
        .select()
        .from(table)
        .where(and(eq(table.orgId, actor.orgId), isNull(table.deletedAt), eq(table.id, id)))
        .for("update");
      if (!before) throw new NotFoundError(recordType);
      if (!canAccessRecord(actor.permissions, kind as ObjectName, "edit", before, actor.userId)) {
        result.errors.push({ row: item.row, message: "Your role cannot edit this record" });
        continue;
      }
      // A contact stays on its account; the file's account columns only place new contacts.
      const { accountName: _n, accountWebsite: _w, ...patch } = item.values;
      const changes = diffFields(before as Values, patch);
      if (changes.length === 0) continue;
      await tx
        .update(table)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set({ ...patch, updatedAt: new Date() } as any)
        .where(eq(table.id, id));
      await recordUpdate(tx, actor, recordType, id, changes, "import");
      result.updated += 1;
    }
  });

  result.errors.sort((a, b) => a.row - b.row);
  return result;
}
