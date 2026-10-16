import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import express, { type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import {
  accounts,
  activities,
  apiIdempotency,
  contacts,
  customFields,
  leads,
  memberships,
  opportunities,
  organizations,
  roles,
  sequences,
  statusOptions,
  users,
} from "../../shared/schema";
import * as activityService from "../activities/service";
import { asApi } from "../audit/origin";
import type { Actor } from "../auth/actor";
import { PermissionError } from "../auth/permissions";
import type { Db } from "../db/types";
import { DuplicateError, NotFoundError, ValidationError } from "../errors";
import { accountService, contactService, leadService, opportunityService } from "../records";
import { SequenceError } from "../sequences/engine";
import * as seq from "../sequences/service";
import * as webhooks from "../webhooks/service";
import { authenticateKey, type KeyActor } from "./keys";
import { RESOURCES, serialize, type ResourceName } from "./resources";

/**
 * Bagger's public API, version 1, at /api/v1. For other systems, with an API
 * key (`Authorization: Bearer bgr_…`), not a person's sign-in.
 *
 * This is a promise to the people who build on it: fields, shapes and
 * meanings here only ever grow. Breaking changes would be a /api/v2. The
 * internal API the screens use (/api/…) is separate and can change freely.
 *
 * Everything goes through the same services as the screens, so permissions,
 * validation, duplicate checks, statuses, custom fields and History behave
 * exactly as in the app. History shows "via API: <key name>".
 */

declare module "express-serve-static-core" {
  interface Request {
    apiKey?: KeyActor;
  }
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------- rate limits

/** 120 requests a minute per key, with bursts up to that. Per server. */
const RATE = { perMinute: 120 };
const buckets = new Map<string, { tokens: number; at: number }>();
function takeToken(keyId: string): { ok: boolean; remaining: number; retryAfter: number } {
  const now = Date.now();
  const b = buckets.get(keyId) ?? { tokens: RATE.perMinute, at: now };
  b.tokens = Math.min(RATE.perMinute, b.tokens + ((now - b.at) / 60_000) * RATE.perMinute);
  b.at = now;
  buckets.set(keyId, b);
  if (b.tokens < 1) {
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.ceil(((1 - b.tokens) * 60) / RATE.perMinute),
    };
  }
  b.tokens -= 1;
  return { ok: true, remaining: Math.floor(b.tokens), retryAfter: 0 };
}

// ------------------------------------------------------------- paging

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
  updatedSince: z.iso.datetime({ offset: true }).optional(),
  includeDeleted: z.enum(["true", "false"]).optional(),
});

const encodeCursor = (at: string, id: string) =>
  Buffer.from(JSON.stringify([at, id])).toString("base64url");
function decodeCursor(cursor: string): [string, string] {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      typeof value[0] === "string" &&
      z.uuid().safeParse(value[1]).success
    ) {
      return value as [string, string];
    }
  } catch {
    // fall through
  }
  throw new ApiError(400, "invalid_cursor", "That cursor isn't one Bagger gave out");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PagedTable = any;

/**
 * Records in the order they last changed (oldest first), a page at a time.
 * Ask with `updatedSince` to pick up only what changed; follow `nextCursor`
 * until it's null.
 */
async function page(
  db: Db,
  table: PagedTable,
  orgId: string,
  raw: unknown,
  extra: SQL[] = [],
  softDeleted = true,
) {
  const q = listQuery.parse(raw);
  const conds: SQL[] = [eq(table.orgId, orgId), ...extra];
  if (softDeleted && q.includeDeleted !== "true") conds.push(isNull(table.deletedAt));
  if (q.updatedSince) conds.push(gt(table.updatedAt, new Date(q.updatedSince)));
  if (q.cursor) {
    const [at, id] = decodeCursor(q.cursor);
    conds.push(sql`(${table.updatedAt}, ${table.id}) > (${at}::timestamptz, ${id}::uuid)`);
  }
  const rows = (await db
    .select({ row: table, at: sql<string>`${table.updatedAt}::text` })
    .from(table)
    .where(and(...conds))
    .orderBy(asc(table.updatedAt), asc(table.id))
    .limit(q.limit + 1)) as { row: Record<string, unknown> & { id: string }; at: string }[];
  const more = rows.length > q.limit;
  const shown = rows.slice(0, q.limit);
  const last = shown[shown.length - 1];
  return {
    rows: shown.map((r) => r.row),
    nextCursor: more && last ? encodeCursor(last.at, last.row.id) : null,
  };
}

/** Exact-match filters from the query string, e.g. ?email=…&accountId=… */
function filtersFor(table: PagedTable, allowed: string[], query: Record<string, unknown>): SQL[] {
  const out: SQL[] = [];
  for (const name of allowed) {
    const value = query[name];
    if (typeof value !== "string" || value === "") continue;
    if (name.endsWith("Id") && !z.uuid().safeParse(value).success) {
      throw new ApiError(400, "invalid_input", `${name} must be an id`);
    }
    out.push(
      name === "email" ? eq(table.email, value.trim().toLowerCase()) : eq(table[name], value),
    );
  }
  return out;
}

const idOf = (req: Request) => {
  const parsed = z.uuid().safeParse(req.params.id);
  if (!parsed.success) throw new ApiError(404, "not_found", "No such record");
  return parsed.data;
};

// ------------------------------------------------------------- idempotency

/**
 * A write sent with `Idempotency-Key: <anything unique>` is done once: sending
 * the same key again returns the first answer instead of doing it again.
 */
async function startIdempotent(
  db: Db,
  req: Request,
): Promise<{ replay?: { status: number; body: unknown }; id?: string }> {
  const idemKey = req.header("idempotency-key");
  if (!idemKey || req.method === "GET") return {};
  if (idemKey.length > 200) throw new ApiError(400, "invalid_input", "Idempotency-Key is too long");
  const key = req.apiKey!;
  const requestHash = createHash("sha256")
    .update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? null)}`)
    .digest("hex");
  const [made] = await db
    .insert(apiIdempotency)
    .values({ orgId: key.actor.orgId, keyId: key.key.id, idempotencyKey: idemKey, requestHash })
    .onConflictDoNothing()
    .returning({ id: apiIdempotency.id });
  if (made) return { id: made.id };
  const [prior] = await db
    .select()
    .from(apiIdempotency)
    .where(and(eq(apiIdempotency.keyId, key.key.id), eq(apiIdempotency.idempotencyKey, idemKey)));
  if (prior.requestHash !== requestHash) {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "That Idempotency-Key was used for a different request",
    );
  }
  if (prior.statusCode === null) {
    throw new ApiError(
      409,
      "in_progress",
      "A request with that Idempotency-Key is still being handled",
    );
  }
  return { replay: { status: prior.statusCode, body: prior.response } };
}

// ------------------------------------------------------------- router

export interface V1Options {
  /** "active" when the organization can be used; otherwise why not. */
  accountStatus: (actor: Actor) => string;
  webhooks: webhooks.WebhookOptions;
}

export function v1Router(db: Db, options: V1Options) {
  const router = express.Router();

  // Every request: a working key, an open account, within the rate limit.
  router.use(async (req, res, next) => {
    try {
      const found = await authenticateKey(db, req.header("authorization"));
      if (!found) {
        throw new ApiError(
          401,
          "unauthorized",
          "Send a valid API key: Authorization: Bearer bgr_…",
        );
      }
      const status = options.accountStatus(found.actor);
      if (status !== "active") {
        throw new ApiError(402, "account_locked", "This Bagger account isn't open", { status });
      }
      const limit = takeToken(found.key.id);
      res.setHeader("X-RateLimit-Limit", String(RATE.perMinute));
      res.setHeader("X-RateLimit-Remaining", String(limit.remaining));
      if (!limit.ok) {
        res.setHeader("Retry-After", String(limit.retryAfter));
        throw new ApiError(
          429,
          "rate_limited",
          `Slow down: ${RATE.perMinute} requests a minute per key`,
        );
      }
      if (req.method !== "GET" && found.key.access === "read") {
        throw new ApiError(403, "read_only_key", "This key can only read");
      }
      req.apiKey = found;
      next();
    } catch (e) {
      next(e);
    }
  });

  /** A handler that runs as the key, with History "via API: <key name>", and answers once. */
  const handle =
    (work: (req: Request, actor: Actor) => Promise<{ status: number; body?: unknown }>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      let idem: { replay?: { status: number; body: unknown }; id?: string } = {};
      try {
        idem = await startIdempotent(db, req);
        if (idem.replay) {
          res.setHeader("Idempotent-Replayed", "true");
          res.status(idem.replay.status);
          if (idem.replay.status === 204) res.end();
          else res.json(idem.replay.body);
          return;
        }
        const key = req.apiKey!;
        const out = await asApi(key.key.name, () => work(req, key.actor));
        if (idem.id) {
          await db
            .update(apiIdempotency)
            .set({ statusCode: out.status, response: out.body ?? null })
            .where(eq(apiIdempotency.id, idem.id));
        }
        res.status(out.status);
        if (out.status === 204) res.end();
        else res.json(out.body);
      } catch (e) {
        // Let the request be tried again with the same key.
        if (idem.id) await db.delete(apiIdempotency).where(eq(apiIdempotency.id, idem.id));
        next(e);
      }
    };

  router.get(
    "/me",
    handle(async (req, actor) => {
      const [org] = await db
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, actor.orgId));
      const key = req.apiKey!.key;
      return {
        status: 200,
        body: { organization: org, key: { name: key.name, access: key.access } },
      };
    }),
  );

  // ---- leads, contacts, accounts, opportunities
  const services = {
    leads: leadService,
    contacts: contactService,
    accounts: accountService,
    opportunities: opportunityService,
  } as const;
  const tables = { leads, contacts, accounts, opportunities } as const;
  for (const name of ["leads", "contacts", "accounts", "opportunities"] as const) {
    const service = services[name];
    const table = tables[name];
    const res = RESOURCES[name];
    const find = async (actor: Actor, id: string) => {
      const [row] = await db
        .select()
        .from(table)
        .where(and(eq(table.orgId, actor.orgId), eq(table.id, id)));
      if (!row) throw new ApiError(404, "not_found", `No such ${res.singular}`);
      return row as Record<string, unknown>;
    };
    router.get(
      `/${name}`,
      handle(async (req, actor) => {
        const { rows, nextCursor } = await page(
          db,
          table,
          actor.orgId,
          req.query,
          filtersFor(table, res.filters, req.query as Record<string, unknown>),
        );
        return { status: 200, body: { data: rows.map((r) => serialize(name, r)), nextCursor } };
      }),
    );
    router.get(
      `/${name}/:id`,
      handle(async (req, actor) => ({
        status: 200,
        body: serialize(name, await find(actor, idOf(req))),
      })),
    );
    router.post(
      `/${name}`,
      handle(async (req, actor) => {
        const allowDuplicate = req.query.allowDuplicate === "true";
        const row = await service.create(db, actor, req.body, { allowDuplicate, source: "api" });
        return { status: 201, body: serialize(name, row as unknown as Record<string, unknown>) };
      }),
    );
    router.patch(
      `/${name}/:id`,
      handle(async (req, actor) => {
        const row = await service.update(db, actor, idOf(req), req.body);
        return { status: 200, body: serialize(name, row as unknown as Record<string, unknown>) };
      }),
    );
    router.delete(
      `/${name}/:id`,
      handle(async (req, actor) => {
        await service.remove(db, actor, idOf(req));
        return { status: 204 };
      }),
    );
  }

  // ---- activities
  router.get(
    "/activities",
    handle(async (req, actor) => {
      const { rows, nextCursor } = await page(
        db,
        activities,
        actor.orgId,
        req.query,
        filtersFor(activities, RESOURCES.activities.filters, req.query as Record<string, unknown>),
      );
      return {
        status: 200,
        body: { data: rows.map((r) => serialize("activities", r)), nextCursor },
      };
    }),
  );
  router.get(
    "/activities/:id",
    handle(async (req, actor) => {
      const [row] = await db
        .select()
        .from(activities)
        .where(and(eq(activities.orgId, actor.orgId), eq(activities.id, idOf(req))));
      if (!row) throw new ApiError(404, "not_found", "No such activity");
      return { status: 200, body: serialize("activities", row) };
    }),
  );
  router.post(
    "/activities",
    handle(async (req, actor) => {
      const row = await activityService.logActivity(db, actor, req.body);
      return {
        status: 201,
        body: serialize("activities", row as unknown as Record<string, unknown>),
      };
    }),
  );
  router.patch(
    "/activities/:id",
    handle(async (req, actor) => {
      const row = await activityService.updateActivity(db, actor, idOf(req), req.body);
      return {
        status: 200,
        body: serialize("activities", row as unknown as Record<string, unknown>),
      };
    }),
  );
  router.delete(
    "/activities/:id",
    handle(async (req, actor) => {
      await activityService.deleteActivity(db, actor, idOf(req));
      return { status: 204 };
    }),
  );

  // ---- sequences and enrolling people
  router.get(
    "/sequences",
    handle(async (req, actor) => {
      const { rows, nextCursor } = await page(db, sequences, actor.orgId, req.query);
      return {
        status: 200,
        body: { data: rows.map((r) => serialize("sequences", r)), nextCursor },
      };
    }),
  );
  router.post(
    "/sequences/:id/enrollments",
    handle(async (req, actor) => {
      const { enrollment } = await seq.enrollPerson(db, actor, idOf(req), req.body);
      return {
        status: 201,
        body: serialize("enrollments", enrollment as unknown as Record<string, unknown>),
      };
    }),
  );

  // ---- reference: people, statuses, custom fields
  router.get(
    "/users",
    handle(async (_req, actor) => {
      const rows = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: roles.name,
          status: memberships.status,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .leftJoin(roles, eq(roles.id, memberships.roleId))
        .where(
          and(
            eq(memberships.orgId, actor.orgId),
            inArray(memberships.status, ["active", "ending"]),
          ),
        )
        .orderBy(asc(users.name));
      return { status: 200, body: { data: rows } };
    }),
  );
  router.get(
    "/statuses",
    handle(async (_req, actor) => {
      const rows = await db
        .select({
          object: statusOptions.object,
          name: statusOptions.name,
          effect: statusOptions.effect,
          isDefault: statusOptions.isDefault,
          probability: statusOptions.probability,
        })
        .from(statusOptions)
        .where(eq(statusOptions.orgId, actor.orgId))
        .orderBy(asc(statusOptions.object), asc(statusOptions.position));
      const grouped: Record<string, unknown[]> = {};
      for (const { object, ...rest } of rows) (grouped[object] ??= []).push(rest);
      return { status: 200, body: grouped };
    }),
  );
  router.get(
    "/custom-fields",
    handle(async (_req, actor) => {
      const rows = await db
        .select({
          object: customFields.object,
          key: customFields.key,
          label: customFields.label,
          type: customFields.type,
          required: customFields.required,
          options: customFields.options,
        })
        .from(customFields)
        .where(and(eq(customFields.orgId, actor.orgId), isNull(customFields.archivedAt)))
        .orderBy(asc(customFields.object), asc(customFields.createdAt));
      return { status: 200, body: { data: rows } };
    }),
  );

  // ---- webhooks, for systems that subscribe themselves (Zapier and the like)
  router.get(
    "/webhooks",
    handle(async (_req, actor) => ({
      status: 200,
      body: {
        data: (await webhooks.listEndpoints(db, actor, "api")).map((w) => ({
          id: w.id,
          url: w.url,
          description: w.description,
          events: w.events,
          status: w.status,
          createdAt: w.createdAt,
        })),
      },
    })),
  );
  router.post(
    "/webhooks",
    handle(async (req, actor) => {
      const made = await webhooks.createEndpoint(
        db,
        actor,
        req.body,
        options.webhooks,
        req.apiKey!.key.id,
      );
      return {
        status: 201,
        body: {
          id: made.id,
          url: made.url,
          description: made.description,
          events: made.events,
          status: made.status,
          secret: made.secret,
          createdAt: made.createdAt,
        },
      };
    }),
  );
  router.delete(
    "/webhooks/:id",
    handle(async (req, actor) => {
      await webhooks.deleteEndpoint(db, actor, idOf(req), req.apiKey!.key.id);
      return { status: 204 };
    }),
  );

  router.use((_req, _res, next) => next(new ApiError(404, "not_found", "No such endpoint")));

  // One shape for every error: { error: { code, message, details? } }
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    let e: ApiError;
    if (err instanceof ApiError) e = err;
    else if (err instanceof ZodError) {
      e = new ApiError(400, "invalid_input", "Some fields aren't right", {
        fields: err.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      });
    } else if (err instanceof ValidationError) e = new ApiError(400, "invalid_input", err.message);
    else if (err instanceof DuplicateError) {
      e = new ApiError(
        409,
        "duplicate",
        "Bagger already has a record like this; add ?allowDuplicate=true to create it anyway",
        {
          matches: err.matches,
        },
      );
    } else if (err instanceof PermissionError) {
      e = new ApiError(403, "forbidden", "This key isn't allowed to do that", {
        permission: err.permission,
      });
    } else if (err instanceof NotFoundError) e = new ApiError(404, "not_found", err.message);
    else if (err instanceof SequenceError) {
      const status = err.code.endsWith("_not_found") ? 404 : 400;
      e = new ApiError(status, err.code, err.message);
    } else if (err instanceof SyntaxError && "body" in (err as object)) {
      e = new ApiError(400, "invalid_json", "The request body isn't valid JSON");
    } else {
      console.error(err);
      e = new ApiError(500, "internal", "Something went wrong on Bagger's side");
    }
    res.status(e.status).json({
      error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
    });
  });

  return router;
}

/** Forget idempotency records after a day. */
export async function pruneIdempotency(db: Db): Promise<void> {
  await db
    .delete(apiIdempotency)
    .where(lt(apiIdempotency.createdAt, sql`now() - interval '1 day'`));
}

export type { ResourceName };
