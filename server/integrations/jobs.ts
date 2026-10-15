import type { Db } from "../db/types";
import { enqueue, type JobHandler } from "../jobs/queue";
import { SYNC_JOB, syncJob } from "./service";
import { dueConnections, syncConnection, type IntegrationsConfig } from "./sync";

/** The background work integrations add to the job queue. */
export function integrationJobs(config: IntegrationsConfig): Record<string, JobHandler> {
  return {
    [SYNC_JOB]: async (db, job) => {
      await syncConnection(db, config, String(job.payload.connectionId));
    },
  };
}

/** Every connection syncs at least every `minutes`; "Sync now" and connecting don't wait. */
export async function scheduleSyncs(db: Db, minutes = 15): Promise<number> {
  let queued = 0;
  for (const conn of await dueConnections(db, minutes)) {
    if ((await enqueue(db, syncJob(conn))).queued) queued += 1;
  }
  return queued;
}
