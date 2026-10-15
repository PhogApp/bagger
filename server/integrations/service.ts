import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { integrationConnections, syncRuns, users } from "../../shared/schema";
import type { Actor } from "../auth/actor";
import { requireTool } from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";
import { enqueue } from "../jobs/queue";
import { CATALOG } from "./providers";
import type { IntegrationsConfig } from "./sync";

/**
 * Admin › Integrations: connecting outside services, choosing what each
 * syncs, syncing now, the sync log, and disconnecting.
 */

export const SYNC_JOB = "integration.sync";
export const syncJob = (conn: { id: string; orgId: string }) => ({
  kind: SYNC_JOB,
  orgId: conn.orgId,
  payload: { connectionId: conn.id },
  dedupeKey: `sync:${conn.id}`,
});

const callbackPath = "/integrations/callback";
const STATE_MINUTES = 15;

function manage(actor: Actor) {
  requireTool(actor.permissions, "setup.integrations");
}

function keyOf(config: IntegrationsConfig) {
  if (!config.key) throw new ValidationError("Integrations aren't switched on for this server yet");
  return config.key;
}

function providerOf(config: IntegrationsConfig, id: string) {
  const provider = config.providers[id];
  if (!provider) throw new ValidationError("That service can't be connected yet");
  return provider;
}

async function connectionOf(db: Db, actor: Actor, rawId: string) {
  const parsed = z.uuid().safeParse(rawId);
  if (!parsed.success) throw new NotFoundError("integration");
  const [conn] = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.orgId, actor.orgId),
        eq(integrationConnections.id, parsed.data),
      ),
    );
  if (!conn) throw new NotFoundError("integration");
  return conn;
}

export async function listIntegrations(db: Db, actor: Actor, config: IntegrationsConfig) {
  manage(actor);
  const conns = await db
    .select({ conn: integrationConnections, connectedByName: users.name })
    .from(integrationConnections)
    .leftJoin(users, eq(users.id, integrationConnections.connectedBy))
    .where(eq(integrationConnections.orgId, actor.orgId));
  // The stand-in CRM appears only where it's registered (tests and the preview).
  const catalog = [
    ...CATALOG,
    ...Object.values(config.providers)
      .filter((p) => !CATALOG.some((c) => c.id === p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        category: "CRM" as const,
        description: "A stand-in CRM for trying the sync. Not a real service.",
      })),
  ];
  return {
    enabled: Boolean(config.key),
    services: catalog.map((c) => {
      const found = conns.find((x) => x.conn.provider === c.id);
      const provider = config.providers[c.id];
      return {
        ...c,
        available: Boolean(provider && config.key),
        objects: provider?.objects.map((o) => ({ recordType: o.recordType, label: o.label })) ?? [],
        connection: found
          ? {
              id: found.conn.id,
              status: found.conn.status,
              accountLabel: found.conn.accountLabel,
              connectedBy: found.connectedByName,
              connectedAt: found.conn.createdAt,
              lastSyncAt: found.conn.lastSyncAt,
              lastError: found.conn.lastError,
              objects: found.conn.settings.objects ?? {},
            }
          : null,
      };
    }),
  };
}

/** Where to send the admin to sign in to the service. */
export async function startConnect(
  _db: Db,
  actor: Actor,
  config: IntegrationsConfig,
  providerId: string,
  origin: string,
) {
  manage(actor);
  const key = keyOf(config);
  const provider = providerOf(config, providerId);
  const state = key.signState({
    o: actor.orgId,
    u: actor.userId,
    p: provider.id,
    e: Date.now() + STATE_MINUTES * 60_000,
  });
  return { url: provider.authorizeUrl(state, `${origin}${callbackPath}`) };
}

const callbackBody = z.object({
  code: z.string().min(1).max(4000),
  state: z.string().min(1).max(4000),
});

/** Back from the service's sign-in page: save the connection and start the first sync. */
export async function finishConnect(
  db: Db,
  actor: Actor,
  config: IntegrationsConfig,
  raw: unknown,
  origin: string,
) {
  manage(actor);
  const key = keyOf(config);
  const { code, state } = callbackBody.parse(raw);
  const note = key.readState<{ o: string; u: string; p: string; e: number }>(state);
  // Only the admin who started it, in the organization they started it in, in time.
  if (!note || note.o !== actor.orgId || note.u !== actor.userId || note.e < Date.now()) {
    throw new ValidationError("That sign-in link has expired or isn't yours. Start again.");
  }
  const provider = providerOf(config, note.p);
  const account = await provider.connect(code, `${origin}${callbackPath}`);
  const sealed = key.seal(account.credentials);
  const [existing] = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.orgId, actor.orgId),
        eq(integrationConnections.provider, provider.id),
      ),
    );
  if (
    existing &&
    existing.externalAccountId &&
    existing.externalAccountId !== account.externalAccountId
  ) {
    throw new ValidationError(
      `Bagger is connected to a different ${provider.name} account (${existing.accountLabel}). Disconnect it first.`,
    );
  }
  const [conn] = existing
    ? await db
        .update(integrationConnections)
        .set({
          credentials: sealed,
          status: "connected",
          lastError: null,
          accountLabel: account.label,
          externalAccountId: account.externalAccountId,
          updatedAt: new Date(),
        })
        .where(eq(integrationConnections.id, existing.id))
        .returning()
    : await db
        .insert(integrationConnections)
        .values({
          orgId: actor.orgId,
          provider: provider.id,
          credentials: sealed,
          accountLabel: account.label,
          externalAccountId: account.externalAccountId,
          connectedBy: actor.userId,
        })
        .returning();
  await enqueue(db, syncJob(conn));
  return {
    id: conn.id,
    name: provider.name,
    accountLabel: conn.accountLabel,
    reconnected: Boolean(existing),
  };
}

const direction = z.enum(["both", "pull", "push", "off"]);
const settingsBody = z.object({
  objects: z.record(z.enum(["account", "contact"]), direction),
});

export async function updateConnection(db: Db, actor: Actor, rawId: string, raw: unknown) {
  manage(actor);
  const conn = await connectionOf(db, actor, rawId);
  const { objects } = settingsBody.parse(raw);
  await db
    .update(integrationConnections)
    .set({
      settings: { ...conn.settings, objects: { ...conn.settings.objects, ...objects } },
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, conn.id));
}

export async function syncNow(db: Db, actor: Actor, rawId: string) {
  manage(actor);
  const conn = await connectionOf(db, actor, rawId);
  if (conn.status !== "connected") throw new ValidationError("Connect it again first");
  return enqueue(db, syncJob(conn));
}

/**
 * Stop syncing and forget the service: its credentials, its links and its
 * sync log. Records stay in Bagger, and History still shows what came "via" it.
 */
export async function disconnect(db: Db, actor: Actor, rawId: string) {
  manage(actor);
  const conn = await connectionOf(db, actor, rawId);
  await db.delete(integrationConnections).where(eq(integrationConnections.id, conn.id));
}

export async function listRuns(db: Db, actor: Actor, rawId: string) {
  manage(actor);
  const conn = await connectionOf(db, actor, rawId);
  return db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.connectionId, conn.id))
    .orderBy(desc(syncRuns.startedAt))
    .limit(30);
}
