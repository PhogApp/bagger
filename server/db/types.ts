import type { PgDatabase } from "drizzle-orm/pg-core";
import type * as schema from "../../shared/schema";

/**
 * Any Drizzle Postgres handle over the Bagger schema: the production
 * node-postgres pool, the in-process database used by tests, or an open
 * transaction.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema, any>;

/** Who is acting, and in which organization. Passed to every service call. */
export interface Ctx {
  orgId: string;
  userId: string;
}
