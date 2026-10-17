import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn, PgTableWithColumns } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  diffFields,
  recordLifecycle,
  recordUpdate,
  type FieldChange,
  type HistorySource,
} from "../audit/history";
import { isMember, type Actor } from "../auth/actor";
import {
  canCreate,
  PermissionError,
  requireRecord,
  requireTool,
  scopeFor,
  type ObjectName,
} from "../auth/permissions";
import type { Db } from "../db/types";
import type { CustomFieldObject, StatusObject } from "../../shared/schema";
import { loadDefs, settleCustom } from "../fields/service";
import { defaultStatus, resolveStatus } from "../statuses/service";
import { DuplicateError, NotFoundError, ValidationError, type DuplicateMatch } from "../errors";
import {
  sequenceSorts,
  sequenceWhere,
  summarize,
  type SequenceFilter,
  type SequenceKind,
} from "../sequences/summary";

/**
 * The single write path for ordinary records (leads, contacts, accounts,
 * templates, sequences). Each call:
 *   1. scopes to the actor's organization,
 *   2. checks the actor's role,
 *   3. makes the change and writes audit history in one transaction.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = PgTableWithColumns<any>;

interface BaseRow {
  id: string;
  orgId: string;
  ownerId: string;
}

export interface RecordConfig<TRow extends BaseRow, TSchema extends z.ZodObject> {
  table: AnyTable;
  object: ObjectName;
  /** Name used in audit history, e.g. "lead". */
  recordType: string;
  /** Validates create input. Updates accept any subset of it. */
  input: TSchema;
  /** Columns a list can be narrowed by with an exact value, e.g. `accountId`. */
  filters?: Record<string, AnyPgColumn>;
  /** What a list can be sorted by, by the name the screens use. */
  sortable?: Record<string, AnyPgColumn | SQL>;
  /** Text columns (or expressions) matched by the `q` search parameter. */
  search: (AnyPgColumn | SQL)[];
  orderBy: AnyPgColumn[];
  /**
   * Adjust values before they are checked and saved, e.g. clean a template's
   * message for its type. `before` is set on update.
   */
  prepare?: (values: Record<string, unknown>, before?: TRow) => void;
  /** Check references (for example, that an account is in this org). */
  validate?: (tx: Db, actor: Actor, values: Partial<z.infer<TSchema>>) => Promise<void>;
  /** Set when the record type can have custom fields. */
  customObject?: CustomFieldObject;
  /** Set when the record has a status drawn from the organization's own list. */
  statusObject?: StatusObject;
  /** Records that look like the one about to be created. Any match stops the create. */
  duplicates?: (tx: Db, actor: Actor, values: z.infer<TSchema>) => Promise<DuplicateMatch[]>;
  /** Rows the list leaves out, e.g. leads that became contacts. */
  hidden?: SQL;
  /**
   * Set for records that go through sequences (or, for accounts, whose people
   * do): lists can be filtered and sorted by sequence, and show a summary.
   */
  sequenceKind?: SequenceKind;
  /** A reason this row can no longer be changed or deleted, or null. */
  frozen?: (row: TRow) => string | null;
  afterCreate?: (tx: Db, actor: Actor, row: TRow) => Promise<void>;
  afterUpdate?: (tx: Db, actor: Actor, before: TRow, after: TRow) => Promise<void>;
  afterDelete?: (tx: Db, actor: Actor, row: TRow) => Promise<void>;
}

const bulkInput = z.object({
  ids: z.array(z.uuid()).min(1).max(1000),
  action: z.enum(["update", "delete"]),
  patch: z
    .object({ ownerId: z.uuid().optional(), status: z.string().min(1).optional() })
    .optional(),
});

export interface CreateOptions {
  source?: HistorySource;
  /** The user has seen the possible duplicates and wants the record anyway. */
  allowDuplicate?: boolean;
}

export interface ListOptions {
  q?: string;
  /** A name from the config's `sortable`, or "custom.<key>". */
  sort?: string;
  dir?: "asc" | "desc";
  /** Only records owned by these users. */
  owners?: string[];
  /** Only records with one of these statuses. */
  statuses?: string[];
  /** Exact matches on the columns named in the config's `filters`, e.g. { accountId }. */
  where?: Record<string, string | undefined>;
  /** Only records in, out of, or past a sequence in a given way. */
  sequence?: SequenceFilter;
  /** Add a `sequences` summary to each row (for the list screens). */
  withSequences?: boolean;
  limit?: number;
  offset?: number;
}

export function recordService<TRow extends BaseRow, TSchema extends z.ZodObject>(
  cfg: RecordConfig<TRow, TSchema>,
) {
  const t = cfg.table;
  type Input = z.infer<TSchema> & {
    ownerId?: string;
    status?: string;
    custom?: Record<string, unknown>;
  };

  /** Check a chosen status against the organization's list; fill in the default on create. */
  async function settleStatus(tx: Db, actor: Actor, input: Partial<Input>, creating: boolean) {
    if (!cfg.statusObject) return;
    const values = input as { status?: string };
    if (values.status !== undefined) {
      values.status = await resolveStatus(tx, actor.orgId, cfg.statusObject, values.status);
    } else if (creating) {
      values.status = await defaultStatus(tx, actor.orgId, cfg.statusObject);
    }
  }

  const inOrg = (actor: Actor): SQL => and(eq(t.orgId, actor.orgId), isNull(t.deletedAt))!;

  async function load(db: Db, actor: Actor, id: string): Promise<TRow> {
    const [row] = await db
      .select()
      .from(t)
      .where(and(inOrg(actor), eq(t.id, id)));
    if (!row) throw new NotFoundError(cfg.recordType);
    return row as TRow;
  }

  async function checkOwner(tx: Db, actor: Actor, ownerId: string | undefined) {
    if (ownerId && !(await isMember(tx, actor.orgId, ownerId))) {
      throw new ValidationError("Owner is not a user in this organization");
    }
  }

  /** ORDER BY for a list: the chosen column (custom fields included), then the usual order. */
  async function sortOrder(db: Db, actor: Actor, options: ListOptions): Promise<SQL[]> {
    const usual = cfg.orderBy.map((c) => asc(c));
    if (!options.sort) return usual;
    const by = options.dir === "desc" ? desc : asc;
    let expr: AnyPgColumn | SQL | undefined = cfg.sortable?.[options.sort];
    if (!expr && cfg.sequenceKind) expr = sequenceSorts(cfg.sequenceKind, t.id)[options.sort];
    // Any of the record's own fields (lists can show every field as a column);
    // text sorts without regard to case. Not ids, the custom bag or system columns.
    if (!expr && !/Id$|^custom$|^orgId$|^deletedAt$/.test(options.sort)) {
      const column = getTableColumns(t)[options.sort] as AnyPgColumn | undefined;
      if (column) {
        const text = column.dataType === "string" && column.columnType !== "PgEnumColumn";
        expr = text ? sql`lower(${column})` : column;
      }
    }
    if (!expr && options.sort.startsWith("custom.") && cfg.customObject) {
      const key = options.sort.slice(7);
      const def = (await loadDefs(db, actor.orgId, cfg.customObject)).find((d) => d.key === key);
      if (def) {
        const text = sql`(${t.custom} ->> ${key}::text)`;
        expr =
          def.type === "number" || def.type === "currency"
            ? sql`(${text})::numeric`
            : def.type === "date"
              ? sql`(${text})::date`
              : sql`lower(${text})`;
      }
    }
    if (!expr) throw new ValidationError(`${cfg.object} can't be sorted by "${options.sort}"`);
    return [sql`${by(expr as AnyPgColumn)} nulls last`, ...usual];
  }

  return {
    /** The conditions a list or a count applies, shared so the two always agree. */
    listWhere(actor: Actor, options: ListOptions): SQL {
      const scope = scopeFor(actor.permissions, cfg.object, "view");
      if (scope === "none") throw new PermissionError(`${cfg.object}.view`);
      const where = [inOrg(actor)];
      if (cfg.hidden) where.push(cfg.hidden);
      if (scope === "own") where.push(eq(t.ownerId, actor.userId));
      for (const [name, value] of Object.entries(options.where ?? {})) {
        if (value === undefined) continue;
        const column = cfg.filters?.[name];
        if (!column) throw new ValidationError(`${cfg.object} cannot be listed by ${name}`);
        where.push(eq(column, value));
      }
      if (options.owners?.length) where.push(inArray(t.ownerId, options.owners));
      if (options.sequence) {
        if (!cfg.sequenceKind) throw new ValidationError(`${cfg.object} aren't in sequences`);
        where.push(...sequenceWhere(cfg.sequenceKind, actor, t.id, options.sequence));
      }
      if (options.statuses?.length) {
        if (!cfg.statusObject) throw new ValidationError(`${cfg.object} have no status`);
        where.push(inArray(t.status, options.statuses));
      }
      // Every word must appear in one of the searched columns, so "jill rude" finds Jill Rude.
      const words = (options.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 6);
      if (cfg.search.length > 0) {
        for (const word of words) {
          const pattern = `%${word.replace(/[\\%_]/g, "\\$&")}%`;
          where.push(or(...cfg.search.map((col) => ilike(col, pattern)))!);
        }
      }
      return and(...where)!;
    },

    async list(db: Db, actor: Actor, options: ListOptions = {}): Promise<TRow[]> {
      const where = this.listWhere(actor, options);
      const order = await sortOrder(db, actor, options);
      const rows = await db
        .select()
        .from(t)
        .where(where)
        .orderBy(...order)
        .limit(Math.min(options.limit ?? 100, 500))
        .offset(options.offset ?? 0);
      if (options.withSequences && cfg.sequenceKind) {
        const ids = rows.map((r) => r.id as string);
        const summaries = await summarize(db, actor, cfg.sequenceKind, ids);
        return rows.map((r) => ({
          ...r,
          sequences: summaries.get(r.id as string),
        })) as unknown as TRow[];
      }
      return rows as TRow[];
    },

    /**
     * Change or delete many records at once. Each record is checked and saved
     * on its own, with its own history, so one refusal doesn't stop the rest;
     * the refusals come back with their reasons.
     */
    async bulk(
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
          if (input.action === "delete") await this.remove(db, actor, id);
          else await this.update(db, actor, id, input.patch);
          done += 1;
        } catch (e) {
          if (e instanceof PermissionError)
            skipped.push({ id, reason: "Your role can't change this record" });
          else if (e instanceof NotFoundError) skipped.push({ id, reason: "No longer exists" });
          else if (e instanceof ValidationError) skipped.push({ id, reason: e.message });
          else throw e;
        }
      }
      return { done, skipped };
    },

    async count(db: Db, actor: Actor, options: ListOptions = {}): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(this.listWhere(actor, options));
      return row.n;
    },

    async get(db: Db, actor: Actor, id: string): Promise<TRow> {
      const row = await load(db, actor, id);
      requireRecord(actor.permissions, cfg.object, "view", row, actor.userId);
      return row;
    },

    async create(db: Db, actor: Actor, raw: unknown, options: CreateOptions = {}): Promise<TRow> {
      if (!canCreate(actor.permissions, cfg.object)) {
        throw new PermissionError(`${cfg.object}.create`);
      }
      const values = cfg.input.parse(raw) as Input;
      cfg.prepare?.(values as Record<string, unknown>);
      return db.transaction(async (tx) => {
        await checkOwner(tx, actor, values.ownerId);
        await cfg.validate?.(tx, actor, values);
        await settleStatus(tx, actor, values, true);
        if (cfg.customObject) {
          const { custom } = await settleCustom(tx, actor, cfg.customObject, values.custom, {
            requireAll: true,
          });
          (values as { custom?: unknown }).custom = custom;
        }
        if (cfg.duplicates && !options.allowDuplicate) {
          const matches = await cfg.duplicates(tx, actor, values);
          if (matches.length > 0) throw new DuplicateError(matches);
        }
        const [row] = await tx
          .insert(t)
          .values({ ...values, orgId: actor.orgId, ownerId: values.ownerId ?? actor.userId })
          .returning();
        await recordLifecycle(tx, actor, cfg.recordType, row.id, "create", options.source);
        await cfg.afterCreate?.(tx, actor, row as TRow);
        return row as TRow;
      });
    },

    async update(db: Db, actor: Actor, id: string, raw: unknown): Promise<TRow> {
      const patch = cfg.input.partial().parse(raw) as Partial<Input>;
      return db.transaction(async (tx) => {
        const [before] = (await tx
          .select()
          .from(t)
          .where(and(inOrg(actor), eq(t.id, id)))
          .for("update")) as TRow[];
        if (!before) throw new NotFoundError(cfg.recordType);
        requireRecord(actor.permissions, cfg.object, "edit", before, actor.userId);
        const frozen = cfg.frozen?.(before);
        if (frozen) throw new ValidationError(frozen);
        cfg.prepare?.(patch as Record<string, unknown>, before);

        await settleStatus(tx, actor, patch, false);
        // Custom values merge into what the record has, and get a history line each.
        let customChanges: FieldChange[] = [];
        if (patch.custom !== undefined) {
          if (!cfg.customObject) throw new ValidationError("This record has no custom fields");
          const settled = await settleCustom(tx, actor, cfg.customObject, patch.custom, {
            before: (before as unknown as { custom: Record<string, unknown> }).custom,
            requireChanged: true,
          });
          customChanges = settled.changes;
          delete patch.custom;
          if (customChanges.length > 0) (patch as { custom?: unknown }).custom = settled.custom;
        }
        const { custom: _merged, ...plain } = patch;
        const changes = [
          ...diffFields(before as unknown as Record<string, unknown>, plain),
          ...customChanges,
        ];
        if (changes.length === 0) return before;
        await checkOwner(tx, actor, patch.ownerId);
        await cfg.validate?.(tx, actor, patch);

        const [after] = await tx
          .update(t)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(t.id, id))
          .returning();
        await recordUpdate(tx, actor, cfg.recordType, id, changes);
        await cfg.afterUpdate?.(tx, actor, before, after as TRow);
        return after as TRow;
      });
    },

    /** Soft delete: the row is hidden but its history stays readable. */
    async remove(db: Db, actor: Actor, id: string): Promise<void> {
      await db.transaction(async (tx) => {
        const [row] = (await tx
          .select()
          .from(t)
          .where(and(inOrg(actor), eq(t.id, id)))
          .for("update")) as TRow[];
        if (!row) throw new NotFoundError(cfg.recordType);
        requireRecord(actor.permissions, cfg.object, "delete", row, actor.userId);
        const frozen = cfg.frozen?.(row);
        if (frozen) throw new ValidationError(frozen);
        await tx.update(t).set({ deletedAt: new Date() }).where(eq(t.id, id));
        await recordLifecycle(tx, actor, cfg.recordType, id, "delete");
        await cfg.afterDelete?.(tx, actor, row);
      });
    },
  };
}
