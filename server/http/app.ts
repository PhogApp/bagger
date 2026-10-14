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
import type { ListOptions } from "../records/service";
import { SequenceError } from "../sequences/engine";
import * as seq from "../sequences/service";
import * as organization from "../orgs/organization";
import * as activityService from "../activities/service";
import { globalSearch } from "../search/service";
import * as exportService from "../export/service";
import * as people from "../people/service";
import * as billing from "../billing/service";
import * as staffService from "../staff/service";
import type { BillingGateway } from "../billing/gateway";
import { verifyClerkWebhook, type ClerkEvent } from "../people/clerk-webhook";
import * as dashboard from "../dashboard/service";
import * as fields from "../fields/service";
import * as builder from "../reports/builder";
import * as reports from "../reports/standard";
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
  sort: z.string().max(80).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  /** Owner ids, comma separated; "me" for whoever is asking. */
  owner: z.string().optional(),
  /** Repeat for several: ?status=New&status=Prospecting */
  status: z.union([z.string(), z.array(z.string())]).optional(),
  /** Answer { rows, total } instead of just the rows. */
  withTotal: z.literal("1").optional(),
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
  list(db: Db, actor: Actor, options: ListOptions): Promise<unknown[]>;
  count(db: Db, actor: Actor, options: ListOptions): Promise<number>;
  bulk(db: Db, actor: Actor, raw: unknown): Promise<unknown>;
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
    const actor = actorOf(req);
    const { accountId, leadId, contactId, opportunityId, owner, status, withTotal, ...options } =
      listQuery.parse(req.query);
    const owners = owner
      ?.split(",")
      .filter(Boolean)
      .map((o) => (o === "me" ? actor.userId : z.uuid().parse(o)));
    const statuses = status === undefined ? undefined : [status].flat();
    const full = { ...options, owners, statuses, where: { accountId, leadId, contactId, opportunityId } };
    const rows = await service.list(db, actor, full);
    res.json(withTotal ? { rows, total: await service.count(db, actor, full) } : rows);
  }) satisfies Handler);
  router.post(`${path}/bulk`, (async (req, res) => {
    res.json(await service.bulk(db, actorOf(req), req.body));
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
  /** Signing secret for Clerk's webhooks (CLERK_WEBHOOK_SECRET). Without it the endpoint is off. */
  clerkWebhookSecret?: string;
  /** Payments. Without it billing is switched off and nobody is asked for a card. */
  billing?: BillingGateway | null;
  /** Lowercased email addresses of Bagger staff, who can open the staff console. */
  staffEmails?: string[];
  /** Called after staff delete an organization, to remove it from sign-in too. */
  onOrgDeleted?: (org: { clerkOrgId: string | null }) => Promise<void>;
}

export function createApp(db: Db, authenticate: Authenticator, options: AppOptions = {}) {
  /** With payments on, an organization can't be used until a card is saved. */
  const effectiveStatus = (actor: Actor) =>
    options.billing && actor.billingStatus === "active" && !actor.hasCard
      ? ("setup" as const)
      : actor.billingStatus;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    express.json({
      limit: "8mb",
      // Webhook signatures are checked against the exact bytes that were sent.
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Clerk tells Bagger when someone is removed from an organization or deletes
  // their sign-in. Not behind sign-in: the signature proves it came from Clerk.
  app.post("/api/webhooks/clerk", async (req, res) => {
    const secret = options.clerkWebhookSecret;
    if (!secret) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
    const ok = verifyClerkWebhook(
      secret,
      {
        id: req.header("svix-id"),
        timestamp: req.header("svix-timestamp"),
        signature: req.header("svix-signature"),
      },
      raw,
    );
    if (!ok) {
      res.status(401).json({ error: "bad_signature" });
      return;
    }
    const event = req.body as ClerkEvent;
    let ended = 0;
    if (event.type === "organizationMembership.deleted") {
      const clerkUserId = event.data.public_user_data?.user_id;
      const clerkOrgId = event.data.organization?.id;
      if (clerkUserId && clerkOrgId) ended = await people.removedInClerk(db, { clerkUserId, clerkOrgId });
    } else if (event.type === "user.deleted" && event.data.id) {
      ended = await people.removedInClerk(db, { clerkUserId: event.data.id });
    }
    res.json({ ok: true, ended });
  });
  app.get("/api/config", (_req, res) => {
    res.json(options.publicConfig ?? {});
  });

  // Stripe tells Bagger when a bill is paid or fails. Its signature proves it came from Stripe.
  app.post("/api/webhooks/stripe", async (req, res) => {
    const gateway = options.billing;
    if (!gateway) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    let event;
    try {
      event = gateway.readEvent(
        (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(""),
        req.header("stripe-signature") ?? "",
      );
    } catch {
      res.status(400).json({ error: "bad_signature" });
      return;
    }
    const applied = event.kind === "invoice" ? await billing.applyEvent(db, event) : false;
    res.json({ received: true, applied });
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
      billingStatus: effectiveStatus(actor),
      isOwner: actor.isOwner,
      isStaff: Boolean(await staffService.staffFor(db, actor, options.staffEmails ?? [])),
    });
  });

  // ---- staff console: Bagger staff only, whatever state their own organization is in.
  // Anyone else gets "not found", so the console isn't advertised.
  const staffOf = async (req: Request) => {
    const staff = await staffService.staffFor(db, actorOf(req), options.staffEmails ?? []);
    if (!staff) throw new NotFoundError();
    return staff;
  };
  api.get("/staff/organizations", async (req, res) => {
    await staffOf(req);
    res.json(await staffService.listOrganizations(db));
  });
  api.get("/staff/organizations/:id", async (req, res) => {
    await staffOf(req);
    res.json(await staffService.getOrganization(db, String(req.params.id)));
  });
  api.post("/staff/organizations/:id/owner", async (req, res) => {
    const staff = await staffOf(req);
    const done = await staffService.changeOwner(db, staff, String(req.params.id), req.body);
    // Clerk only lets its own admins manage members, so keep it in step.
    if (done.madeAdmin && options.onRoleChange) {
      await options.onRoleChange({ orgId: done.orgId, userId: done.userId, isAdmin: true });
    }
    res.json({ owner: done.owner, madeAdmin: done.madeAdmin });
  });
  api.post("/staff/organizations/:id/delete", async (req, res) => {
    const staff = await staffOf(req);
    const orgId = String(req.params.id);
    const done = await staffService.deleteOrganization(db, staff, orgId, req.body);
    let signIn: "removed" | "failed" | "none" = "none";
    if (done.clerkOrgId && options.onOrgDeleted) {
      try {
        await options.onOrgDeleted({ clerkOrgId: done.clerkOrgId });
        signIn = "removed";
      } catch (e) {
        // The data is gone either way; say so, and log it for removing by hand.
        console.error("Could not delete the Clerk organization", e);
        await staffService.noteClerkFailure(db, staff, orgId, e instanceof Error ? e.message : "");
        signIn = "failed";
      }
    }
    res.json({ name: done.name, peopleDeleted: done.peopleDeleted, signIn });
  });

  // The full data export stays open on a locked or cancelled account, so a
  // customer can always take their data. Admins only (account.full_export).
  api.get("/export", async (req, res) => {
    const actor = actorOf(req);
    const name = await exportService.exportFileName(db, actor);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Cache-Control", "no-store");
    try {
      await exportService.writeExport(db, actor, (chunk) => res.write(Buffer.from(chunk)));
      res.end();
    } catch (err) {
      // Part of the file has gone out; end it broken rather than look complete.
      console.error(err);
      res.destroy(err as Error);
    }
  });

  // A locked or cancelled organization can reach /me, the export (above) and
  // nothing else here. Billing routes will be registered before this gate when
  // they are built.
  // Billing belongs to the owner, and stays reachable when the account is
  // locked, waiting for a card, or cancelled, so it can be put right.
  api.get("/billing", async (req, res) => {
    res.json(await billing.getBilling(db, actorOf(req), options.billing ?? null));
  });
  api.post("/billing/card", async (req, res) => {
    const origin = `${req.protocol}://${req.get("host")}`;
    res.json(await billing.startCardSetup(db, actorOf(req), options.billing ?? null, origin));
  });
  api.post("/billing/card/confirm", async (req, res) => {
    res.json(await billing.confirmCardSetup(db, actorOf(req), options.billing ?? null, req.body));
  });
  api.post("/billing/pay", async (req, res) => {
    res.json(await billing.payNow(db, actorOf(req), options.billing ?? null));
  });
  api.post("/billing/cancel", async (req, res) => {
    res.json(await billing.cancelAccount(db, actorOf(req)));
  });
  api.post("/billing/undo-cancel", async (req, res) => {
    await billing.undoCancel(db, actorOf(req));
    res.status(204).end();
  });
  api.post("/billing/reactivate", async (req, res) => {
    await billing.reactivate(db, actorOf(req));
    res.status(204).end();
  });

  api.use((req, res, next) => {
    const status = effectiveStatus(actorOf(req));
    if (status !== "active") {
      res.status(402).json({ error: "account_locked", status });
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
  // ---- people: removing, undoing, reinstating
  api.get("/people", async (req, res) => {
    res.json(await people.listPeople(db, actorOf(req)));
  });
  api.post("/people/:id/remove", async (req, res) => {
    await people.removePerson(db, actorOf(req), id(req), req.body);
    res.status(204).end();
  });
  api.post("/people/:id/undo", async (req, res) => {
    await people.undoRemoval(db, actorOf(req), id(req));
    res.status(204).end();
  });
  api.put("/people/:id/hand-to", async (req, res) => {
    await people.changeHandTo(db, actorOf(req), id(req), req.body);
    res.status(204).end();
  });
  api.post("/people/:id/reinstate", async (req, res) => {
    await people.reinstatePerson(db, actorOf(req), id(req));
    res.status(204).end();
  });
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
  api.get("/templates/:id/usage", async (req, res) => {
    res.json(await seq.templateUsage(db, actorOf(req), id(req)));
  });
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

  // ---- Roll the Calls
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

  // ---- the search box at the top of every page
  api.get("/search", async (req, res) => {
    res.json(await globalSearch(db, actorOf(req), req.query));
  });

  // ---- activities and the dashboard
  api.get("/activities", async (req, res) => {
    // ?withTotal=1 is the Activities page: paged, with the total. Otherwise one record's timeline.
    const { withTotal, ...query } = req.query;
    res.json(
      withTotal
        ? await activityService.listActivities(db, actorOf(req), query)
        : await activityService.timeline(db, actorOf(req), query),
    );
  });
  api.post("/activities", async (req, res) => {
    res.status(201).json(await activityService.logActivity(db, actorOf(req), req.body));
  });
  api.post("/activities/bulk", async (req, res) => {
    res.json(await activityService.bulkActivities(db, actorOf(req), req.body));
  });
  api.get("/activities/:id", async (req, res) => {
    res.json(await activityService.getActivity(db, actorOf(req), id(req)));
  });
  api.patch("/activities/:id", async (req, res) => {
    res.json(await activityService.updateActivity(db, actorOf(req), id(req), req.body));
  });
  api.delete("/activities/:id", async (req, res) => {
    await activityService.deleteActivity(db, actorOf(req), id(req));
    res.status(204).end();
  });
  // ---- the report builder and saved reports
  api.get("/reports/fields", async (req, res) => {
    res.json(await builder.reportFields(db, actorOf(req)));
  });
  api.post("/reports/run", async (req, res) => {
    const { definition, export: wantsAll } = z
      .object({ definition: z.unknown(), export: z.boolean().optional() })
      .parse(req.body);
    // Downloading every row is an export; showing the first thousand is not.
    if (wantsAll) requireTool(actorOf(req).permissions, "data.export_lists");
    res.json(await builder.runReport(db, actorOf(req), definition, { limit: wantsAll ? 50000 : 1000 }));
  });
  api.get("/reports/saved", async (req, res) => {
    res.json(await builder.listSaved(db, actorOf(req)));
  });
  api.post("/reports/saved", async (req, res) => {
    res.status(201).json(await builder.createSaved(db, actorOf(req), req.body));
  });
  api.get("/reports/saved/:id", async (req, res) => {
    res.json(await builder.getSaved(db, actorOf(req), id(req)));
  });
  api.patch("/reports/saved/:id", async (req, res) => {
    await builder.updateSaved(db, actorOf(req), id(req), req.body);
    res.status(204).end();
  });
  api.delete("/reports/saved/:id", async (req, res) => {
    await builder.deleteSaved(db, actorOf(req), id(req));
    res.status(204).end();
  });

  // ---- standard reports
  api.get("/reports/sequences", async (req, res) => {
    res.json(await reports.sequenceReport(db, actorOf(req), req.query));
  });
  api.get("/reports/activity", async (req, res) => {
    res.json(await reports.activityReport(db, actorOf(req), req.query));
  });
  api.get("/reports/pipeline", async (req, res) => {
    res.json(await reports.pipelineReport(db, actorOf(req), req.query));
  });
  api.get("/reports/conversion", async (req, res) => {
    res.json(await reports.conversionReport(db, actorOf(req), req.query));
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
      const status = err.code.endsWith("_not_found")
        ? 404
        : err.code === "call_outcome_required"
          ? 400
          : 409;
      res
        .status(status)
        .json({ error: err.code, ...(err.message !== err.code ? { message: err.message } : {}) });
    } else {
      console.error(err);
      res.status(500).json({ error: "server_error" });
    }
  });

  return app;
}
