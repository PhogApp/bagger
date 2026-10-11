import { and, asc, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTableWithColumns } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { diffFields, recordLifecycle, recordUpdate, type HistorySource } from "../audit/history";
import { isMember, type Actor } from "../auth/actor";
import {
  canCreate,
  PermissionError,
  requireRecord,
  scopeFor,
  type ObjectName,
} from "../auth/permissions";
import type { Db } from "../db/types";
import type { StatusObject } from "../../shared/schema";
import { defaultStatus, resolveStatus } from "../statuses/service";
import { DuplicateError, NotFoundError, ValidationError, type DuplicateMatch } from "../errors";

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
  /** Text columns matched by the `q` search parameter. */
  search: AnyPgColumn[];
  orderBy: AnyPgColumn[];
  /** Check references (for example, that an account is in this org). */
  validate?: (tx: Db, actor: Actor, values: Partial<z.infer<TSchema>>) => Promise<void>;
  /** Set when the record has a status drawn from the organization's own list. */
  statusObject?: StatusObject;
  /** Records that look like the one about to be created. Any match stops the create. */
  duplicates?: (tx: Db, actor: Actor, values: z.infer<TSchema>) => Promise<DuplicateMatch[]>;
  /** Rows the list leaves out, e.g. leads that became contacts. */
  hidden?: SQL;
  /** A reason this row can no longer be changed or deleted, or null. */
  frozen?: (row: TRow) => string | null;
  afterUpdate?: (tx: Db, actor: Actor, before: TRow, after: TRow) => Promise<void>;
  afterDelete?: (tx: Db, actor: Actor, row: TRow) => Promise<void>;
}

export interface CreateOptions {
  source?: HistorySource;
  /** The user has seen the possible duplicates and wants the record anyway. */
  allowDuplicate?: boolean;
}

export interface ListOptions {
  q?: string;
  limit?: number;
  offset?: number;
}

export function recordService<TRow extends BaseRow, TSchema extends z.ZodObject>(
  cfg: RecordConfig<TRow, TSchema>,
) {
  const t = cfg.table;
  type Input = z.infer<TSchema> & { ownerId?: string; status?: string };

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

  return {
    async list(db: Db, actor: Actor, options: ListOptions = {}): Promise<TRow[]> {
      const scope = scopeFor(actor.permissions, cfg.object, "view");
      if (scope === "none") throw new PermissionError(`${cfg.object}.view`);
      const where = [inOrg(actor)];
      if (cfg.hidden) where.push(cfg.hidden);
      if (scope === "own") where.push(eq(t.ownerId, actor.userId));
      const q = options.q?.trim();
      if (q && cfg.search.length > 0) {
        const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
        where.push(or(...cfg.search.map((col) => ilike(col, pattern)))!);
      }
      const rows = await db
        .select()
        .from(t)
        .where(and(...where))
        .orderBy(...cfg.orderBy.map((c) => asc(c)))
        .limit(Math.min(options.limit ?? 100, 500))
        .offset(options.offset ?? 0);
      return rows as TRow[];
    },

    async get(db: Db, actor: Actor, id: string): Promise<TRow> {
      const row = await load(db, actor, id);
      requireRecord(actor.permissions, cfg.object, "view", row, actor.userId);
      return row;
    },

    async create(
      db: Db,
      actor: Actor,
      raw: unknown,
      options: CreateOptions = {},
    ): Promise<TRow> {
      if (!canCreate(actor.permissions, cfg.object)) {
        throw new PermissionError(`${cfg.object}.create`);
      }
      const values = cfg.input.parse(raw) as Input;
      return db.transaction(async (tx) => {
        await checkOwner(tx, actor, values.ownerId);
        await cfg.validate?.(tx, actor, values);
        await settleStatus(tx, actor, values, true);
        if (cfg.duplicates && !options.allowDuplicate) {
          const matches = await cfg.duplicates(tx, actor, values);
          if (matches.length > 0) throw new DuplicateError(matches);
        }
        const [row] = await tx
          .insert(t)
          .values({ ...values, orgId: actor.orgId, ownerId: values.ownerId ?? actor.userId })
          .returning();
        await recordLifecycle(tx, actor, cfg.recordType, row.id, "create", options.source);
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

        await settleStatus(tx, actor, patch, false);
        const changes = diffFields(before as unknown as Record<string, unknown>, patch);
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
