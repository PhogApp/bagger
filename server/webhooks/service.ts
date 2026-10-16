import { createHmac, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  activities,
  contacts,
  leads,
  opportunities,
  users,
  webhookDeliveries,
  webhookEndpoints,
} from "../../shared/schema";
import { serialize, type ResourceName } from "../api/resources";
import type { Actor } from "../auth/actor";
import { requireTool } from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";
import { feedHead, readFeed } from "../integrations/feed";
import { enqueue, type Job, type JobHandler } from "../jobs/queue";
import { checkWebhookUrl, postJson, UnsafeUrlError } from "./send";

/**
 * Webhooks: Bagger tells another system's URL when records change.
 *
 * Every change in the change feed (so every change made anywhere: screens,
 * imports, the API, syncs) that matches an endpoint's events becomes a
 * delivery: a POST of JSON, signed with the endpoint's secret
 * (`Bagger-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`).
 * Deliveries go through the job queue: tried again with growing waits for
 * about a day if the receiver is down. An endpoint failing for three days
 * straight is switched off, and says why.
 *
 * Receivers should answer 2xx quickly, check the signature, and use the
 * event's `id` to ignore repeats; order isn't guaranteed.
 */

export interface WebhookOptions {
  /** Let webhooks reach private addresses (tests and the local preview only). */
  allowPrivateUrls?: boolean;
}

export const RECORD_EVENTS = ["lead", "contact", "account", "opportunity", "activity"] as const;
const ACTIONS = { create: "created", update: "updated", delete: "deleted" } as const;
export const EVENT_TYPES = RECORD_EVENTS.flatMap((r) =>
  Object.values(ACTIONS).map((a) => `${r}.${a}`),
);

const TABLES = {
  lead: leads,
  contact: contacts,
  account: accounts,
  opportunity: opportunities,
  activity: activities,
};
const RESOURCE: Record<string, ResourceName> = {
  lead: "leads",
  contact: "contacts",
  account: "accounts",
  opportunity: "opportunities",
  activity: "activities",
};

export const FANOUT_JOB = "webhooks.fanout";
export const DELIVER_JOB = "webhooks.deliver";
const DELIVERY_ATTEMPTS = 8; // 30s, 2m, 8m, 32m, ~2h, 6h, 6h: about a day in all
const GIVE_UP_DAYS = 3;

function manage(actor: Actor) {
  requireTool(actor.permissions, "setup.api");
}

const endpointBody = z.object({
  url: z.string().trim().min(1, "Enter the address to send to").max(2000),
  description: z
    .string()
    .trim()
    .max(200)
    .transform((v) => v || null)
    .nullable()
    .optional(),
  events: z
    .array(z.enum(EVENT_TYPES as [string, ...string[]]))
    .max(EVENT_TYPES.length)
    .optional(),
});

function safeUrl(raw: string, options: WebhookOptions): string {
  try {
    return checkWebhookUrl(raw, Boolean(options.allowPrivateUrls)).toString();
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw new ValidationError(e.message);
    throw e;
  }
}

async function endpointOf(db: Db, orgId: string, rawId: string) {
  const parsed = z.uuid().safeParse(rawId);
  if (!parsed.success) throw new NotFoundError("webhook");
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.id, parsed.data)));
  if (!row) throw new NotFoundError("webhook");
  return row;
}

const summary = (e: typeof webhookEndpoints.$inferSelect) => ({
  id: e.id,
  url: e.url,
  description: e.description,
  events: e.events,
  status: e.status,
  disabledReason: e.disabledReason,
  failingSince: e.failingSince,
  createdAt: e.createdAt,
  viaApi: Boolean(e.apiKeyId),
});

/** Add an endpoint. It hears about changes from now on. The secret is in the answer. */
export async function createEndpoint(
  db: Db,
  actor: Actor,
  raw: unknown,
  options: WebhookOptions,
  apiKeyId: string | null = null,
) {
  if (!apiKeyId) manage(actor);
  const input = endpointBody.parse(raw);
  const url = safeUrl(input.url, options);
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      orgId: actor.orgId,
      url,
      description: input.description ?? null,
      events: input.events ?? [],
      secret: `whsec_${randomBytes(24).toString("base64url")}`,
      position: await feedHead(db),
      createdBy: actor.userId,
      apiKeyId,
    })
    .returning();
  return { ...summary(row), secret: row.secret };
}

export async function listEndpoints(db: Db, actor: Actor, onlyApiKey?: string) {
  if (!onlyApiKey) manage(actor);
  const rows = await db
    .select({ endpoint: webhookEndpoints, createdBy: users.name })
    .from(webhookEndpoints)
    .leftJoin(users, eq(users.id, webhookEndpoints.createdBy))
    .where(eq(webhookEndpoints.orgId, actor.orgId))
    .orderBy(desc(webhookEndpoints.createdAt));
  const last = rows.length
    ? await db
        .selectDistinctOn([webhookDeliveries.endpointId], {
          endpointId: webhookDeliveries.endpointId,
          status: webhookDeliveries.status,
          code: webhookDeliveries.lastStatusCode,
          at: webhookDeliveries.createdAt,
        })
        .from(webhookDeliveries)
        .where(
          inArray(
            webhookDeliveries.endpointId,
            rows.map((r) => r.endpoint.id),
          ),
        )
        .orderBy(webhookDeliveries.endpointId, desc(webhookDeliveries.createdAt))
    : [];
  return rows.map((r) => ({
    ...summary(r.endpoint),
    createdBy: r.createdBy,
    lastDelivery: last.find((l) => l.endpointId === r.endpoint.id) ?? null,
  }));
}

export async function revealSecret(db: Db, actor: Actor, id: string) {
  manage(actor);
  return { secret: (await endpointOf(db, actor.orgId, id)).secret };
}

const updateBody = z.object({
  description: endpointBody.shape.description,
  events: endpointBody.shape.events,
  status: z.enum(["active", "disabled"]).optional(),
});

export async function updateEndpoint(db: Db, actor: Actor, id: string, raw: unknown) {
  manage(actor);
  const endpoint = await endpointOf(db, actor.orgId, id);
  const input = updateBody.parse(raw);
  const turningOn = input.status === "active" && endpoint.status !== "active";
  const [row] = await db
    .update(webhookEndpoints)
    .set({
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.events ? { events: input.events } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.status === "disabled" ? { disabledReason: "Switched off by an admin" } : {}),
      // Back on: it hears about changes from now, not everything it missed.
      ...(turningOn
        ? { disabledReason: null, failingSince: null, position: await feedHead(db) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(webhookEndpoints.id, endpoint.id))
    .returning();
  return summary(row);
}

export async function deleteEndpoint(db: Db, actor: Actor, id: string, onlyApiKey?: string) {
  if (!onlyApiKey) manage(actor);
  const endpoint = await endpointOf(db, actor.orgId, id);
  if (onlyApiKey && endpoint.apiKeyId !== onlyApiKey) throw new NotFoundError("webhook");
  await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
}

export async function listDeliveries(db: Db, actor: Actor, id: string) {
  manage(actor);
  const endpoint = await endpointOf(db, actor.orgId, id);
  return db
    .select({
      id: webhookDeliveries.id,
      eventType: webhookDeliveries.eventType,
      eventId: sql<string>`${webhookDeliveries.payload}->>'id'`,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastStatusCode: webhookDeliveries.lastStatusCode,
      lastError: webhookDeliveries.lastError,
      deliveredAt: webhookDeliveries.deliveredAt,
      createdAt: webhookDeliveries.createdAt,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.endpointId, endpoint.id))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(50);
}

async function queueDelivery(
  db: Db,
  endpoint: { id: string; orgId: string },
  eventType: string,
  payload: Record<string, unknown>,
) {
  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({ orgId: endpoint.orgId, endpointId: endpoint.id, eventType, payload })
    .returning({ id: webhookDeliveries.id });
  await enqueue(db, {
    kind: DELIVER_JOB,
    orgId: endpoint.orgId,
    payload: { deliveryId: delivery.id },
    maxAttempts: DELIVERY_ATTEMPTS,
  });
  return delivery.id;
}

/** Send a "ping" event now, to check the receiving end works. */
export async function sendTest(db: Db, actor: Actor, id: string) {
  manage(actor);
  const endpoint = await endpointOf(db, actor.orgId, id);
  const deliveryId = await queueDelivery(db, endpoint, "ping", {
    id: `evt_ping_${randomBytes(8).toString("hex")}`,
    type: "ping",
    createdAt: new Date().toISOString(),
    data: { message: "A test from Bagger. If you can read this, the webhook works." },
  });
  return { deliveryId };
}

/** Try a failed delivery again, as it was. */
export async function resend(db: Db, actor: Actor, deliveryId: string) {
  manage(actor);
  const parsed = z.uuid().safeParse(deliveryId);
  if (!parsed.success) throw new NotFoundError("delivery");
  const [row] = await db
    .update(webhookDeliveries)
    .set({ status: "pending", lastError: null })
    .where(and(eq(webhookDeliveries.orgId, actor.orgId), eq(webhookDeliveries.id, parsed.data)))
    .returning();
  if (!row) throw new NotFoundError("delivery");
  await enqueue(db, {
    kind: DELIVER_JOB,
    orgId: row.orgId,
    payload: { deliveryId: row.id },
    maxAttempts: DELIVERY_ATTEMPTS,
  });
}

// ---------------------------------------------------------- fan-out

/**
 * Turn new changes into deliveries, for every working endpoint. Runs every
 * few seconds as a job; each endpoint reads the change feed from where it
 * left off.
 */
export async function fanOut(db: Db): Promise<number> {
  let queued = 0;
  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.status, "active"));
  for (const endpoint of endpoints) {
    const wants = new Set(endpoint.events);
    const { rows, position } = await readFeed(db, endpoint.orgId, endpoint.position, 200);
    for (const change of rows) {
      const table = TABLES[change.recordType as keyof typeof TABLES];
      if (!table) continue;
      const type = `${change.recordType}.${ACTIONS[change.action]}`;
      if (wants.size > 0 && !wants.has(type)) continue;
      const [row] = await db
        .select()
        .from(table)
        .where(and(eq(table.orgId, endpoint.orgId), eq(table.id, change.recordId)));
      if (!row) continue; // gone for good (the organization was deleted)
      await queueDelivery(db, endpoint, type, {
        id: `evt_${change.id}`,
        type,
        createdAt: change.createdAt.toISOString(),
        data: {
          object: serialize(RESOURCE[change.recordType], row as Record<string, unknown>),
          ...(change.action === "update" ? { changedFields: change.fields } : {}),
        },
      });
      queued += 1;
    }
    if (rows.length > 0) {
      await db
        .update(webhookEndpoints)
        .set({ position })
        .where(eq(webhookEndpoints.id, endpoint.id));
    }
  }
  return queued;
}

// ---------------------------------------------------------- delivering

export function sign(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

async function deliver(db: Db, job: Job, options: WebhookOptions) {
  const [delivery] = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, String(job.payload.deliveryId)));
  if (!delivery || delivery.status === "delivered") return;
  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.id, delivery.endpointId));
  if (!endpoint) return;
  if (endpoint.status !== "active" && delivery.eventType !== "ping") {
    await db
      .update(webhookDeliveries)
      .set({ status: "failed", lastError: "The endpoint is switched off" })
      .where(eq(webhookDeliveries.id, delivery.id));
    return;
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  let status: number | null = null;
  let problem: string | null = null;
  try {
    const res = await postJson(
      new URL(endpoint.url),
      body,
      {
        "User-Agent": "Bagger-Webhooks/1",
        "Bagger-Event": delivery.eventType,
        "Bagger-Delivery": delivery.id,
        "Bagger-Signature": sign(endpoint.secret, timestamp, body),
      },
      { allowPrivate: Boolean(options.allowPrivateUrls) },
    );
    status = res.status;
    if (status < 200 || status >= 300) {
      problem = `Answered ${status}${res.body ? `: ${res.body.slice(0, 200)}` : ""}`;
    }
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }

  if (!problem) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "delivered",
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        lastStatusCode: status,
        lastError: null,
        deliveredAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    if (endpoint.failingSince) {
      await db
        .update(webhookEndpoints)
        .set({ failingSince: null })
        .where(eq(webhookEndpoints.id, endpoint.id));
    }
    return;
  }

  const lastTry = job.attempts >= job.maxAttempts;
  await db
    .update(webhookDeliveries)
    .set({
      status: lastTry ? "failed" : "pending",
      attempts: sql`${webhookDeliveries.attempts} + 1`,
      lastStatusCode: status,
      lastError: problem,
    })
    .where(eq(webhookDeliveries.id, delivery.id));
  const failingSince = endpoint.failingSince ?? new Date();
  const giveUp = lastTry && Date.now() - failingSince.getTime() > GIVE_UP_DAYS * 24 * 3600 * 1000;
  await db
    .update(webhookEndpoints)
    .set({
      failingSince,
      ...(giveUp
        ? {
            status: "disabled" as const,
            disabledReason: `Switched off after failing for ${GIVE_UP_DAYS} days: ${problem}`,
          }
        : {}),
    })
    .where(eq(webhookEndpoints.id, endpoint.id));
  throw new Error(problem); // the queue tries again later
}

export function webhookJobs(options: WebhookOptions): Record<string, JobHandler> {
  return {
    [FANOUT_JOB]: async (db) => {
      await fanOut(db);
    },
    [DELIVER_JOB]: (db, job) => deliver(db, job, options),
  };
}

/** Queue a fan-out (at most one waiting at a time). */
export function scheduleFanOut(db: Db) {
  return enqueue(db, { kind: FANOUT_JOB, dedupeKey: "webhooks:fanout", maxAttempts: 1 });
}

/** Forget deliveries after 30 days. */
export async function pruneDeliveries(db: Db): Promise<void> {
  await db
    .delete(webhookDeliveries)
    .where(lt(webhookDeliveries.createdAt, sql`now() - interval '30 days'`));
}
