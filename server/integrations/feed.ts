import { and, asc, eq, lt, sql } from "drizzle-orm";
import { changeFeed } from "../../shared/schema";
import type { Db } from "../db/types";

/**
 * Reading the change feed from where a reader left off.
 *
 * Rows are read in transaction order and only from transactions older than
 * every transaction still running (the snapshot's xmin). A slow transaction
 * can't commit "behind" a reader's position, so no change is ever skipped,
 * whatever order transactions commit in.
 */

export interface FeedPosition {
  tx: number;
  id: number;
}

export type FeedRow = typeof changeFeed.$inferSelect;

const xmin = sql<number>`pg_snapshot_xmin(pg_current_snapshot())::text::bigint`;

/** The position "now": a reader starting here sees only later changes. */
export async function feedHead(db: Db): Promise<FeedPosition> {
  const result = await db.execute(
    sql`select pg_snapshot_xmin(pg_current_snapshot())::text as xmin`,
  );
  const [row] = result.rows as { xmin: string }[];
  return { tx: Number(row.xmin) - 1, id: Number.MAX_SAFE_INTEGER };
}

export async function readFeed(
  db: Db,
  orgId: string,
  after: FeedPosition,
  limit = 500,
): Promise<{ rows: FeedRow[]; position: FeedPosition }> {
  const rows = await db
    .select()
    .from(changeFeed)
    .where(
      and(
        eq(changeFeed.orgId, orgId),
        lt(changeFeed.txId, xmin),
        sql`(${changeFeed.txId}, ${changeFeed.id}) > (${after.tx}, ${after.id})`,
      ),
    )
    .orderBy(asc(changeFeed.txId), asc(changeFeed.id))
    .limit(limit);
  const last = rows[rows.length - 1];
  return { rows, position: last ? { tx: last.txId, id: last.id } : after };
}

/** Forget changes after 30 days. */
export async function pruneFeed(db: Db): Promise<void> {
  await db.delete(changeFeed).where(lt(changeFeed.createdAt, sql`now() - interval '30 days'`));
}
