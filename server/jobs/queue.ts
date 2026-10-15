import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { jobs } from "../../shared/schema";
import type { Db } from "../db/types";

/**
 * A small job queue in Postgres. Work that shouldn't happen while someone
 * waits (syncing with HubSpot, later sending webhooks) is queued here and run
 * by `runDueJobs`, which the server calls every few seconds.
 *
 * - A failed job is tried again with growing waits (30s, 2m, 8m, …) up to
 *   its max attempts, then left as failed with its last error.
 * - A job can carry a dedupe key: while one with that key is queued or
 *   running, adding another does nothing ("sync this connection" twice is one sync).
 * - Workers claim jobs with FOR UPDATE SKIP LOCKED, so more than one server
 *   can share the queue without running a job twice.
 * - A job whose worker died is picked up again after 15 minutes.
 */

export type Job = typeof jobs.$inferSelect;
export type JobHandler = (db: Db, job: Job) => Promise<void>;

/** A job that shouldn't be retried (the problem won't fix itself). */
export class PermanentJobError extends Error {}

/** Try again later, at a time the outside service asked for. */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    public readonly afterSeconds: number,
  ) {
    super(message);
  }
}

export async function enqueue(
  db: Db,
  job: {
    kind: string;
    orgId?: string | null;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    runAt?: Date;
    maxAttempts?: number;
  },
): Promise<{ queued: boolean; id: string | null }> {
  const [row] = await db
    .insert(jobs)
    .values({
      kind: job.kind,
      orgId: job.orgId ?? null,
      payload: job.payload ?? {},
      dedupeKey: job.dedupeKey ?? null,
      runAt: job.runAt ?? new Date(),
      maxAttempts: job.maxAttempts ?? 5,
    })
    .onConflictDoNothing({
      target: jobs.dedupeKey,
      where: sql`${jobs.status} in ('queued', 'running')`,
    })
    .returning({ id: jobs.id });
  return { queued: Boolean(row), id: row?.id ?? null };
}

const STALE_MINUTES = 15;
const backoffSeconds = (attempt: number) => Math.min(30 * 4 ** (attempt - 1), 6 * 3600);

/** Claim up to `limit` due jobs. */
async function claim(db: Db, limit: number): Promise<Job[]> {
  // Jobs whose worker vanished go back in the queue.
  await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null })
    .where(
      and(
        eq(jobs.status, "running"),
        lt(jobs.lockedAt, sql`now() - make_interval(mins => ${STALE_MINUTES})`),
      ),
    );
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.status, "queued"), sql`${jobs.runAt} <= now()`))
      .orderBy(jobs.runAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(jobs)
      .set({ status: "running", lockedAt: sql`now()`, attempts: sql`${jobs.attempts} + 1` })
      .where(
        inArray(
          jobs.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
  });
}

/** Run what's due. Returns how many jobs ran and how many failed this time. */
export async function runDueJobs(
  db: Db,
  handlers: Record<string, JobHandler>,
  limit = 5,
): Promise<{ ran: number; failed: number }> {
  const claimed = await claim(db, limit);
  let failed = 0;
  for (const job of claimed) {
    const handler = handlers[job.kind];
    try {
      if (!handler) throw new PermanentJobError(`No handler for job kind "${job.kind}"`);
      await handler(db, job);
      await db
        .update(jobs)
        .set({ status: "done", finishedAt: sql`now()`, lockedAt: null, lastError: null })
        .where(eq(jobs.id, job.id));
    } catch (e) {
      failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      const giveUp = e instanceof PermanentJobError || job.attempts >= job.maxAttempts;
      const wait = e instanceof RetryLaterError ? e.afterSeconds : backoffSeconds(job.attempts);
      await db
        .update(jobs)
        .set(
          giveUp
            ? { status: "failed", finishedAt: sql`now()`, lockedAt: null, lastError: message }
            : {
                status: "queued",
                lockedAt: null,
                lastError: message,
                runAt: sql`now() + make_interval(secs => ${wait})`,
              },
        )
        .where(eq(jobs.id, job.id));
    }
  }
  return { ran: claimed.length, failed };
}

/** Forget finished jobs after a week. */
export async function pruneJobs(db: Db): Promise<void> {
  await db
    .delete(jobs)
    .where(
      and(
        inArray(jobs.status, ["done", "failed"]),
        lt(jobs.finishedAt, sql`now() - interval '7 days'`),
      ),
    );
}
