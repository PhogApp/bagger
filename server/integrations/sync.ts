import { and, asc, eq, gt, isNull, notExists, sql } from "drizzle-orm";
import { ZodError } from "zod";
import {
  accounts,
  contacts,
  externalLinks,
  integrationConnections,
  organizations,
  syncRuns,
} from "../../shared/schema";
import { asIntegration } from "../audit/origin";
import { resolveActor, type Actor } from "../auth/actor";
import type { Db } from "../db/types";
import { DuplicateError } from "../errors";
import { PermanentJobError, RetryLaterError } from "../jobs/queue";
import { accountInput, accountService, contactInput, contactService } from "../records";
import { accountMatches, personMatches } from "../records/duplicates";
import type { IntegrationKey } from "./crypto";
import { feedHead, readFeed, type FeedPosition } from "./feed";
import {
  RateLimited,
  ReconnectNeeded,
  type Credentials,
  type ExternalRecord,
  type ObjectMapping,
  type Provider,
  type SyncRecordType,
} from "./providers";

/**
 * One sync of one connection, the same for every service:
 *
 * 1. Pull, for each kind of record in the service's order (companies before
 *    contacts): everything changed there since last time. A record already
 *    linked is updated; otherwise it's matched to an existing Bagger record
 *    (email for contacts, name or website for accounts) and linked; otherwise
 *    it's created. Contacts land in the account linked to their company.
 * 2. Push: every Bagger change since last time (from the change feed), except
 *    changes this connection made itself. Linked records are updated there,
 *    others created and linked. The first sync sends every record not yet
 *    linked.
 *
 * When a record changed on both sides since the last sync, the more recent
 * change wins. Deleting is never synced either way: a record deleted on one
 * side is left alone on the other.
 *
 * Changes Bagger makes are written as the admin who connected the service,
 * shown in History as "via <service>".
 */

export interface IntegrationsConfig {
  key: IntegrationKey | null;
  providers: Record<string, Provider>;
}

type Direction = "both" | "pull" | "push" | "off";
type Connection = typeof integrationConnections.$inferSelect;
interface SyncState {
  pulled?: Record<string, string>;
  feed?: FeedPosition;
  initialPushDone?: boolean;
}

const RECORDS = {
  account: { table: accounts, service: accountService, input: accountInput },
  contact: { table: contacts, service: contactService, input: contactInput },
} as const;

type Row = Record<string, unknown> & { id: string; updatedAt: Date; deletedAt: Date | null };

const directionOf = (conn: Connection, m: ObjectMapping): Direction =>
  conn.settings.objects?.[m.recordType] ?? "both";

class Tally {
  counts: Record<string, Record<string, Record<string, number>>> = { pulled: {}, pushed: {} };
  errors: { object: string; id?: string; message: string }[] = [];
  add(way: "pulled" | "pushed", object: string, what: string) {
    const o = (this.counts[way][object] ??= {});
    o[what] = (o[what] ?? 0) + 1;
  }
  fail(object: string, id: string | undefined, e: unknown) {
    if (this.errors.length < 100) this.errors.push({ object, id, message: explain(e) });
  }
}

function explain(e: unknown): string {
  if (e instanceof ZodError) {
    return e.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`).join("; ");
  }
  return e instanceof Error ? e.message : String(e);
}

/** Problems that stop the whole sync rather than one record. */
const fatal = (e: unknown) => e instanceof ReconnectNeeded || e instanceof RateLimited;

const same = (a: unknown, b: unknown) =>
  (a === null || a === undefined || a === "" ? null : String(a)) ===
  (b === null || b === undefined || b === "" ? null : String(b));

async function saveState(db: Db, conn: Connection, state: SyncState) {
  conn.state = state as Record<string, unknown>;
  await db
    .update(integrationConnections)
    .set({ state: conn.state })
    .where(eq(integrationConnections.id, conn.id));
}

/** Credentials that work now, refreshed (and saved) if they're about to expire. */
async function credentialsFor(
  db: Db,
  key: IntegrationKey,
  provider: Provider,
  conn: Connection,
): Promise<Credentials> {
  const creds = key.open<Credentials>(conn.credentials);
  if (!provider.refresh || (creds.expiresAt && creds.expiresAt > Date.now() + 60_000)) return creds;
  const fresh = await provider.refresh(creds);
  await db
    .update(integrationConnections)
    .set({ credentials: key.seal(fresh) })
    .where(eq(integrationConnections.id, conn.id));
  return fresh;
}

/** The connecting admin, or the owner if they've left. */
async function actorFor(db: Db, conn: Connection): Promise<Actor> {
  if (conn.connectedBy) {
    const actor = await resolveActor(db, { orgId: conn.orgId, userId: conn.connectedBy });
    if (actor) return actor;
  }
  const [org] = await db
    .select({ owner: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, conn.orgId));
  const owner = org?.owner
    ? await resolveActor(db, { orgId: conn.orgId, userId: org.owner })
    : null;
  if (!owner) throw new PermanentJobError("Nobody left in the organization to sync as");
  return owner;
}

async function linkOf(
  db: Db,
  conn: Connection,
  type: SyncRecordType,
  by: { externalId?: string; recordId?: string },
) {
  const [link] = await db
    .select()
    .from(externalLinks)
    .where(
      and(
        eq(externalLinks.connectionId, conn.id),
        eq(externalLinks.recordType, type),
        by.externalId
          ? eq(externalLinks.externalId, by.externalId)
          : eq(externalLinks.recordId, by.recordId!),
      ),
    );
  return link;
}

async function saveLink(
  db: Db,
  conn: Connection,
  type: SyncRecordType,
  recordId: string,
  rec: ExternalRecord,
) {
  await db
    .insert(externalLinks)
    .values({
      orgId: conn.orgId,
      connectionId: conn.id,
      recordType: type,
      recordId,
      externalId: rec.id,
      externalUpdatedAt: new Date(rec.updatedAt),
    })
    .onConflictDoUpdate({
      target: [externalLinks.connectionId, externalLinks.recordType, externalLinks.recordId],
      set: {
        externalId: rec.id,
        externalUpdatedAt: new Date(rec.updatedAt),
        lastSyncedAt: new Date(),
      },
    });
}

async function loadRow(
  db: Db,
  orgId: string,
  type: SyncRecordType,
  id: string,
): Promise<Row | undefined> {
  const { table } = RECORDS[type];
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.orgId, orgId), eq(table.id, id)));
  return row as Row | undefined;
}

// ------------------------------------------------------------------ pull

/** How the sync log names a record from the service: its name or email, else its id there. */
function nameOf(m: ObjectMapping, rec: ExternalRecord): string {
  const get = (field: string) => (m.fields[field] ? rec.fields[m.fields[field]] : null);
  const person = [get("firstName"), get("lastName")].filter(Boolean).join(" ");
  return get("name") || person || get("email") || rec.id;
}

async function pullOne(
  db: Db,
  ctx: { conn: Connection; actor: Actor; provider: Provider; tally: Tally },
  m: ObjectMapping,
  rec: ExternalRecord,
) {
  const { conn, actor, tally } = ctx;
  const type = m.recordType;
  const values: Record<string, unknown> = {};
  for (const [field, theirs] of Object.entries(m.fields)) {
    if (theirs in rec.fields) values[field] = rec.fields[theirs];
  }
  if (m.accountField) {
    const company = rec.fields[m.accountField];
    const accountLink = company ? await linkOf(db, conn, "account", { externalId: company }) : null;
    if (accountLink) values.accountId = accountLink.recordId;
  }
  const { service, input } = RECORDS[type];

  const link = await linkOf(db, conn, type, { externalId: rec.id });
  let row = link ? await loadRow(db, conn.orgId, type, link.recordId) : undefined;
  if (link && (!row || row.deletedAt)) {
    tally.add("pulled", type, "skipped");
    return; // deleted in Bagger: left alone
  }
  if (!link) {
    // Someone already in Bagger, not yet linked to this service?
    const matches =
      type === "contact"
        ? typeof values.email === "string"
          ? await personMatches(db, conn.orgId, values.email, ["contact"])
          : []
        : await accountMatches(db, conn.orgId, values.name as string, values.website as string);
    for (const match of matches) {
      if (!(await linkOf(db, conn, type, { recordId: match.id }))) {
        row = await loadRow(db, conn.orgId, type, match.id);
        break;
      }
    }
  }

  if (row) {
    // Changed on both sides since the last sync: the more recent change wins.
    if (
      link &&
      row.updatedAt > link.lastSyncedAt &&
      row.updatedAt.getTime() > Date.parse(rec.updatedAt)
    ) {
      tally.add("pulled", type, "kept Bagger's newer");
      return;
    }
    const clean = input.partial().parse(values) as Record<string, unknown>;
    const patch = Object.fromEntries(
      Object.entries(clean).filter(([k, v]) => v !== undefined && !same(row![k], v)),
    );
    if (Object.keys(patch).length > 0) {
      await service.update(db, actor, row.id, patch);
      tally.add("pulled", type, "updated");
    } else {
      tally.add("pulled", type, link ? "unchanged" : "matched");
    }
    await saveLink(db, conn, type, row.id, rec);
    return;
  }

  if (type === "contact" && !values.accountId) {
    throw new Error(
      `Has no company in ${ctx.provider.name}; every Bagger contact needs an account`,
    );
  }
  let created: { id: string };
  try {
    created = await service.create(db, actor, values, { source: "integration" });
  } catch (e) {
    // Bagger's own duplicate check found someone: link to them instead.
    if (!(e instanceof DuplicateError) || e.matches.length === 0) throw e;
    created = { id: e.matches[0].id };
  }
  await saveLink(db, conn, type, created.id, rec);
  tally.add("pulled", type, "created");
}

async function pull(
  db: Db,
  ctx: { conn: Connection; actor: Actor; provider: Provider; tally: Tally; creds: Credentials },
  m: ObjectMapping,
) {
  const state = ctx.conn.state as SyncState;
  const since = state.pulled?.[m.external] ?? null;
  let newest = since;
  let cursor: string | null = null;
  do {
    const page = await ctx.provider.list(ctx.creds, m.external, { since, cursor });
    for (const rec of page.records) {
      try {
        await pullOne(db, ctx, m, rec);
      } catch (e) {
        if (fatal(e)) throw e;
        ctx.tally.fail(m.recordType, nameOf(m, rec), e);
      }
      if (!newest || rec.updatedAt > newest) newest = rec.updatedAt;
    }
    cursor = page.next;
  } while (cursor);
  if (newest)
    await saveState(db, ctx.conn, { ...state, pulled: { ...state.pulled, [m.external]: newest } });
}

// ------------------------------------------------------------------ push

async function pushOne(
  db: Db,
  ctx: {
    conn: Connection;
    provider: Provider;
    tally: Tally;
    creds: Credentials;
    pushing: Set<SyncRecordType>;
  },
  type: SyncRecordType,
  id: string,
): Promise<string | null> {
  const m = ctx.provider.objects.find((o) => o.recordType === type);
  if (!m) return null;
  const row = await loadRow(db, ctx.conn.orgId, type, id);
  if (!row || row.deletedAt) return null;
  const fields: Record<string, string | null> = {};
  for (const [field, theirs] of Object.entries(m.fields)) {
    const v = row[field];
    fields[theirs] = v === null || v === undefined ? null : String(v);
  }
  if (m.accountField && typeof row.accountId === "string") {
    let company: string | null =
      (await linkOf(db, ctx.conn, "account", { recordId: row.accountId }))?.externalId ?? null;
    if (!company && ctx.pushing.has("account"))
      company = await pushOne(db, ctx, "account", row.accountId);
    fields[m.accountField] = company;
  }
  const link = await linkOf(db, ctx.conn, type, { recordId: id });
  const rec = link
    ? await ctx.provider.update(ctx.creds, m.external, link.externalId, fields)
    : await ctx.provider.create(ctx.creds, m.external, fields);
  await saveLink(db, ctx.conn, type, id, rec);
  ctx.tally.add("pushed", type, link ? "updated" : "created");
  return rec.id;
}

async function push(
  db: Db,
  ctx: { conn: Connection; provider: Provider; tally: Tally; creds: Credentials },
) {
  const pushing = new Set(
    ctx.provider.objects
      .filter((m) => ["both", "push"].includes(directionOf(ctx.conn, m)))
      .map((m) => m.recordType),
  );
  if (pushing.size === 0) return;
  const pctx = { ...ctx, pushing };
  const state = ctx.conn.state as SyncState;
  const attempt = async (type: SyncRecordType, id: string) => {
    try {
      await pushOne(db, pctx, type, id);
    } catch (e) {
      if (fatal(e)) throw e;
      ctx.tally.fail(type, id, e);
    }
  };

  if (!state.initialPushDone) {
    // Where the feed is now, so changes made during this first send aren't missed.
    const head = await feedHead(db);
    for (const m of ctx.provider.objects) {
      if (!pushing.has(m.recordType)) continue;
      const { table } = RECORDS[m.recordType];
      let after = "00000000-0000-0000-0000-000000000000";
      for (;;) {
        const batch = await db
          .select({ id: table.id })
          .from(table)
          .where(
            and(
              eq(table.orgId, ctx.conn.orgId),
              isNull(table.deletedAt),
              gt(table.id, after),
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(externalLinks)
                  .where(
                    and(
                      eq(externalLinks.connectionId, ctx.conn.id),
                      eq(externalLinks.recordType, m.recordType),
                      eq(externalLinks.recordId, table.id),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(table.id))
          .limit(200);
        for (const r of batch) await attempt(m.recordType, r.id);
        if (batch.length < 200) break;
        after = batch[batch.length - 1].id;
      }
    }
    await saveState(db, ctx.conn, {
      ...(ctx.conn.state as SyncState),
      initialPushDone: true,
      feed: head,
    });
    return;
  }

  let position = state.feed ?? (await feedHead(db));
  for (;;) {
    const { rows, position: next } = await readFeed(db, ctx.conn.orgId, position, 500);
    const seen = new Set<string>();
    for (const r of rows) {
      const type = r.recordType as SyncRecordType;
      // Not this connection's own changes, so nothing bounces back.
      if (!pushing.has(type) || r.connectionId === ctx.conn.id || r.action === "delete") continue;
      if (seen.has(`${type}:${r.recordId}`)) continue;
      seen.add(`${type}:${r.recordId}`);
      await attempt(type, r.recordId);
    }
    position = next;
    await saveState(db, ctx.conn, { ...(ctx.conn.state as SyncState), feed: position });
    if (rows.length < 500) break;
  }
}

// ------------------------------------------------------------------ run

export async function syncConnection(db: Db, config: IntegrationsConfig, connectionId: string) {
  const [conn] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));
  if (!conn || conn.status !== "connected") return null; // disconnected or waiting for an admin
  const provider = config.providers[conn.provider];
  if (!provider || !config.key)
    throw new PermanentJobError(`${conn.provider} isn't available on this server`);

  const [run] = await db
    .insert(syncRuns)
    .values({ orgId: conn.orgId, connectionId: conn.id })
    .returning();
  const tally = new Tally();
  let outcome: "done" | "failed" = "done";
  let problem: unknown = null;
  try {
    const creds = await credentialsFor(db, config.key, provider, conn);
    const actor = await actorFor(db, conn);
    await asIntegration({ via: provider.name, connectionId: conn.id }, async () => {
      for (const m of provider.objects) {
        if (["both", "pull"].includes(directionOf(conn, m))) {
          await pull(db, { conn, actor, provider, tally, creds }, m);
        }
      }
      await push(db, { conn, provider, tally, creds });
    });
  } catch (e) {
    outcome = "failed";
    problem = e;
    tally.fail("sync", undefined, e);
  }

  const message = problem ? explain(problem) : null;
  await db
    .update(syncRuns)
    .set({ status: outcome, counts: tally.counts, errors: tally.errors, finishedAt: new Date() })
    .where(eq(syncRuns.id, run.id));
  await db
    .update(integrationConnections)
    .set({
      lastSyncAt: new Date(),
      lastError: message,
      // A service that no longer accepts us waits for an admin to connect again.
      ...(problem instanceof ReconnectNeeded ? { status: "error" as const } : {}),
    })
    .where(eq(integrationConnections.id, conn.id));

  if (problem instanceof RateLimited)
    throw new RetryLaterError(message!, problem.retryAfterSeconds);
  if (problem && !(problem instanceof ReconnectNeeded) && !(problem instanceof PermanentJobError)) {
    throw problem; // the queue tries again later
  }
  return run.id;
}

/** Queue a sync for every working connection that hasn't synced in `minutes`. */
export function dueConnections(db: Db, minutes: number) {
  return db
    .select({ id: integrationConnections.id, orgId: integrationConnections.orgId })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.status, "connected"),
        sql`(${integrationConnections.lastSyncAt} is null or ${integrationConnections.lastSyncAt} < now() - make_interval(mins => ${minutes}))`,
      ),
    );
}
