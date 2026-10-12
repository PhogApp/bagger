import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import path from "node:path";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";
import { z, ZodError } from "zod";
import { fieldHistory, leads, users } from "../../shared/schema";
import type { Actor } from "../auth/actor";
import { PermissionError, requireTool } from "../auth/permissions";
import type { Db } from "../db/types";
import { DuplicateError, NotFoundError, ValidationError } from "../errors";
import {
  accountService,
  contactService,
  leadService,
  opportunityService,
  sequenceService,
  templateService,
} from "../records";
import { conversionPreview, convertLead } from "../records/convert";
import { IMPORT_KINDS, importRecords } from "../records/import";
import { SequenceError } from "../sequences/engine";
import * as seq from "../sequences/service";
import * as organization from "../orgs/organization";
import * as activityService from "../activities/service";
import * as dashboard from "../dashboard/service";
import * as fields from "../fields/service";
import * as settings from "../settings/service";
import * as statuses from "../statuses/service";

/**
 * Works out who is making a request. Production uses Clerk; tests pass a
 * stand-in. Returning null means "not signed in".
 */
export type Authenticator = (req: Request) => Promise<Actor | null>;

declare module "express-serve-static-core" {
  interface Request {
    actor?: Actor;
  }
}

const idParam = z.uuid();
const listQuery = z.object({
  q: z.string().optional(),
  accountId: z.uuid().optional(),
  leadId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  opportunityId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function actorOf(req: Request): Actor {
  if (!req.actor) throw new Error("actor missing: route registered before authentication");
  return req.actor;
}

function id(req: Request, name = "id"): string {
  const parsed = idParam.safeParse(req.params[name]);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
}

type Handler = (req: Request, res: Response) => Promise<void>;

interface CrudService {
  list(
    db: Db,
    actor: Actor,
    options: { q?: string; limit?: number; offset?: number; where?: Record<string, string | undefined> },
  ): Promise<unknown[]>;
  get(db: Db, actor: Actor, id: string): Promise<unknown>;
  create(
    db: Db,
    actor: Actor,
    raw: unknown,
    options?: { allowDuplicate?: boolean },
  ): Promise<unknown>;
  update(db: Db, actor: Actor, id: string, raw: unknown): Promise<unknown>;
  remove(db: Db, actor: Actor, id: string): Promise<void>;
}

function crud(router: Router, path: string, db: Db, service: CrudService) {
  router.get(path, (async (req, res) => {
    const { accountId, leadId, contactId, opportunityId, ...options } = listQuery.parse(req.query);
    const where = { accountId, leadId, contactId, opportunityId };
    res.json(await service.list(db, actorOf(req), { ...options, where }));
  }) satisfies Handler);
  router.post(path, (async (req, res) => {
    // ?allowDuplicate=1 is sent after the user has been shown the matches.
    const allowDuplicate = req.query.allowDuplicate === "1";
    res.status(201).json(await service.create(db, actorOf(req), req.body, { allowDuplicate }));
  }) satisfies Handler);
  router.get(`${path}/:id`, (async (req, res) => {
    res.json(await service.get(db, actorOf(req), id(req)));
  }) satisfies Handler);
  router.patch(`${path}/:id`, (async (req, res) => {
    res.json(await service.update(db, actorOf(req), id(req), req.body));
  }) satisfies Handler);
  router.delete(`${path}/:id`, (async (req, res) => {
    await service.remove(db, actorOf(req), id(req));
    res.status(204).end();
  }) satisfies Handler);
}

export interface AppOptions {
  /** Middleware that must run first, e.g. the Clerk session reader. */
  before?: RequestHandler[];
  /** Non-secret settings the browser needs before anyone is signed in. */
  publicConfig?: Record<string, string>;
  /** Called after a user gains or loses the Admin role. */
  onRoleChange?: settings.RoleChangeListener;
  /** Folder holding the built web client. Omitted in tests. */
  staticDir?: string;
}

export function createApp(db: Db, authenticate: Authenticator, options: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "8mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/config", (_req, res) => {
    res.json(options.publicConfig ?? {});
  });

  for (const handler of options.before ?? []) app.use(handler);

  const api = express.Router();

  api.use(async (req, res, next) => {
    const actor = await authenticate(req);
    if (!actor) {
      res.status(401).json({ error: "not_signed_in" });
      return;
    }
    req.actor = actor;
    next();
  });

  api.get("/me", async (req, res) => {
    const actor = actorOf(req);
    const [user] = await db.select().from(users).where(eq(users.id, actor.userId));
    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      orgId: actor.orgId,
      role: actor.roleName,
      permissions: actor.permissions,
      billingStatus: actor.billingStatus,
      isOwner: actor.isOwner,
    });
  });

  // A locked or cancelled organization can reach /me (above) and nothing
  // else here. Billing and data-export routes will be registered before this
  // gate when they are built.
  api.use((req, res, next) => {
    if (actorOf(req).billingStatus !== "active") {
      res.status(402).json({ error: "account_locked", status: actorOf(req).billingStatus });
      return;
    }
    next();
  });

  // ---- settings, users and roles
  api.get("/me/settings", async (req, res) => {
    res.json(await settings.getMySettings(db, actorOf(req)));
  });
  api.patch("/me/settings", async (req, res) => {
    res.json(await settings.updateMySettings(db, actorOf(req), req.body));
  });
  api.get("/settings", async (req, res) => {
    res.json(await settings.getOrgSettings(db, actorOf(req)));
  });
  api.patch("/settings", async (req, res) => {
    res.json(await settings.updateOrgSettings(db, actorOf(req), req.body));
  });
  /** People in this organization, for owner pickers and the users page. */
  api.get("/users", async (req, res) => {
    res.json(await settings.listUsers(db, actorOf(req)));
  });
  api.get("/roles", async (req, res) => {
    res.json(await settings.listRoles(db, actorOf(req)));
  });
  api.put("/users/:id/role", async (req, res) => {
    await settings.changeUserRole(db, actorOf(req), id(req), req.body, options.onRoleChange);
    res.status(204).end();
  });

  // ---- custom fields and record layouts (read by everyone, changed in Admin)
  api.get("/fields", async (req, res) => {
    res.json(await fields.fieldSetup(db, actorOf(req)));
  });
  api.post("/fields", async (req, res) => {
    res.status(201).json(await fields.createField(db, actorOf(req), req.body));
  });
  api.put("/fields/layout", async (req, res) => {
    res.json(await fields.saveLayout(db, actorOf(req), req.body));
  });
  api.get("/fields/:id/usage", async (req, res) => {
    res.json(await fields.fieldUsage(db, actorOf(req), id(req)));
  });
  api.patch("/fields/:id", async (req, res) => {
    res.json(await fields.updateField(db, actorOf(req), id(req), req.body));
  });

  // ---- status lists (read by everyone, changed in Admin)
  api.get("/statuses", async (req, res) => {
    res.json(await statuses.listStatuses(db, actorOf(req)));
  });
  api.post("/statuses", async (req, res) => {
    res.status(201).json(await statuses.createStatus(db, actorOf(req), req.body));
  });
  api.put("/statuses/order", async (req, res) => {
    res.json(await statuses.reorderStatuses(db, actorOf(req), req.body));
  });
  api.patch("/statuses/:id", async (req, res) => {
    res.json(await statuses.updateStatus(db, actorOf(req), id(req), req.body));
  });
  api.delete("/statuses/:id", async (req, res) => {
    res.json(await statuses.deleteStatus(db, actorOf(req), id(req), req.query));
  });

  // ---- the Organization tab (owner only)
  api.get("/organization", async (req, res) => {
    res.json(await organization.getOrganization(db, actorOf(req)));
  });
  api.patch("/organization", async (req, res) => {
    res.json(await organization.updateOrganization(db, actorOf(req), req.body));
  });
  api.post("/organization/transfer", async (req, res) => {
    await organization.transferOwnership(db, actorOf(req), req.body);
    res.status(204).end();
  });

  // Registered before the generic /sequences/:id route so "stats" is not read as an id.
  api.get("/sequences/stats", async (req, res) => {
    res.json(await seq.sequenceStats(db, actorOf(req)));
  });

  api.post("/import/:kind", async (req, res) => {
    const kind = z.enum(IMPORT_KINDS).safeParse(req.params.kind);
    if (!kind.success) throw new NotFoundError();
    res.json(await importRecords(db, actorOf(req), kind.data, req.body));
  });
  api.get("/leads/:id/conversion", async (req, res) => {
    res.json(await conversionPreview(db, actorOf(req), id(req)));
  });
  api.post("/leads/:id/convert", async (req, res) => {
    res.json(await convertLead(db, actorOf(req), id(req), req.body));
  });
  crud(api, "/leads", db, leadService);
  crud(api, "/accounts", db, accountService);
  crud(api, "/contacts", db, contactService);
  crud(api, "/opportunities", db, opportunityService);
  crud(api, "/templates", db, templateService);
  crud(api, "/sequences", db, sequenceService);

  // ---- sequence steps
  api.get("/sequences/:id/steps", async (req, res) => {
    res.json(await seq.listSteps(db, actorOf(req), id(req)));
  });
  api.post("/sequences/:id/steps", async (req, res) => {
    res.status(201).json(await seq.addStep(db, actorOf(req), id(req), req.body));
  });
  api.put("/sequences/:id/steps/order", async (req, res) => {
    const { stepIds } = z.object({ stepIds: z.array(z.uuid()) }).parse(req.body);
    res.json(await seq.reorderSteps(db, actorOf(req), id(req), stepIds));
  });
  api.patch("/steps/:id", async (req, res) => {
    res.json(await seq.updateStep(db, actorOf(req), id(req), req.body));
  });
  api.delete("/steps/:id", async (req, res) => {
    await seq.deleteStep(db, actorOf(req), id(req));
    res.status(204).end();
  });

  // ---- enrollments
  api.get("/sequences/:id/enrollments", async (req, res) => {
    res.json(await seq.listEnrollments(db, actorOf(req), id(req)));
  });
  api.post("/sequences/:id/enrollments", async (req, res) => {
    res.status(201).json(await seq.enrollPerson(db, actorOf(req), id(req), req.body));
  });
  api.post("/sequences/:id/enrollments/bulk", async (req, res) => {
    res.json(await seq.bulkEnroll(db, actorOf(req), id(req), req.body));
  });
  api.post("/enrollments/:id/pause", async (req, res) => {
    await seq.pause(db, actorOf(req), id(req));
    res.status(204).end();
  });
  api.post("/enrollments/:id/resume", async (req, res) => {
    await seq.resume(db, actorOf(req), id(req));
    res.status(204).end();
  });
  api.post("/enrollments/:id/stop", async (req, res) => {
    await seq.stop(db, actorOf(req), id(req), req.body);
    res.status(204).end();
  });

  // ---- Run Steps
  api.get("/tasks/due", async (req, res) => {
    const owner = z.union([z.uuid(), z.literal("all")]).optional().parse(req.query.owner);
    res.json(await seq.dueTasks(db, actorOf(req), { ownerId: owner }));
  });
  api.get("/tasks/:id", async (req, res) => {
    res.json(await seq.getTask(db, actorOf(req), id(req)));
  });
  api.post("/tasks/:id/complete", async (req, res) => {
    res.json(await seq.complete(db, actorOf(req), id(req), req.body));
  });
  api.post("/tasks/:id/skip", async (req, res) => {
    res.json(await seq.skip(db, actorOf(req), id(req), req.body));
  });
  api.post("/tasks/:id/snooze", async (req, res) => {
    await seq.snooze(db, actorOf(req), id(req), req.body);
    res.status(204).end();
  });
  api.put("/tasks/:id/message", async (req, res) => {
    res.json(await seq.editMessage(db, actorOf(req), id(req), req.body));
  });

  // ---- activities and the dashboard
  api.get("/activities", async (req, res) => {
    res.json(await activityService.timeline(db, actorOf(req), req.query));
  });
  api.post("/activities", async (req, res) => {
    res.status(201).json(await activityService.logActivity(db, actorOf(req), req.body));
  });
  api.delete("/activities/:id", async (req, res) => {
    await activityService.deleteActivity(db, actorOf(req), id(req));
    res.status(204).end();
  });
  api.get("/dashboard", async (req, res) => {
    res.json(await dashboard.getDashboard(db, actorOf(req), req.query));
  });

  // ---- audit history
  api.get("/history/:recordType/:id", async (req, res) => {
    const actor = actorOf(req);
    requireTool(actor.permissions, "history.view");
    const recordType = String(req.params.recordType);
    const recordId = id(req);
    // A contact that began as a lead shows the lead's history too.
    const asLead =
      recordType === "contact"
        ? await db
            .select({ id: leads.id })
            .from(leads)
            .where(and(eq(leads.orgId, actor.orgId), eq(leads.convertedContactId, recordId)))
        : [];
    const rows = await db
      .select({
        id: fieldHistory.id,
        recordType: fieldHistory.recordType,
        action: fieldHistory.action,
        field: fieldHistory.field,
        oldValue: fieldHistory.oldValue,
        newValue: fieldHistory.newValue,
        source: fieldHistory.source,
        at: fieldHistory.createdAt,
        userId: fieldHistory.userId,
        userName: users.name,
      })
      .from(fieldHistory)
      .leftJoin(users, eq(fieldHistory.userId, users.id))
      .where(
        and(
          eq(fieldHistory.orgId, actor.orgId),
          or(
            and(eq(fieldHistory.recordType, recordType), eq(fieldHistory.recordId, recordId)),
            asLead.length > 0
              ? and(
                  eq(fieldHistory.recordType, "lead"),
                  inArray(
                    fieldHistory.recordId,
                    asLead.map((l) => l.id),
                  ),
                )
              : undefined,
          ),
        ),
      )
      .orderBy(desc(fieldHistory.createdAt), asc(fieldHistory.field));
    res.json(rows);
  });

  api.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use("/api", api);

  if (options.staticDir) {
    const staticDir = options.staticDir;
    app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
    // Any other page request gets the web app, which does its own routing.
    app.get("/{*path}", (_req, res) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  // Express 5 forwards rejected promises from async handlers to this.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid_input", issues: z.flattenError(err) });
    } else if (err instanceof ValidationError) {
      res.status(400).json({ error: "invalid_input", message: err.message });
    } else if (err instanceof DuplicateError) {
      res.status(409).json({ error: "duplicate", matches: err.matches });
    } else if (err instanceof PermissionError) {
      res.status(403).json({ error: "forbidden", permission: err.permission });
    } else if (err instanceof NotFoundError) {
      res.status(404).json({ error: "not_found", message: err.message });
    } else if (err instanceof SequenceError) {
      const status = err.code.endsWith("_not_found") ? 404 : 409;
      res.status(status).json({ error: err.code });
    } else {
      console.error(err);
      res.status(500).json({ error: "server_error" });
    }
  });

  return app;
}
