/**
 * Roles and permissions, modeled on HubSpot's shape:
 *   - record permissions: per object, per action, with a scope
 *   - tool permissions: on/off switches
 *   - roles: named bundles of both, assigned one per user
 *
 * "team" scope is intentionally absent until teams exist. Adding it means a
 * new Scope value and one more branch in `canAccessRecord`.
 */

export const OBJECTS = [
  "leads",
  "contacts",
  "accounts",
  "opportunities",
  "activities",
  "templates",
  "sequences",
] as const;
export type ObjectName = (typeof OBJECTS)[number];

export const RECORD_ACTIONS = ["view", "edit", "delete"] as const;
export type RecordAction = (typeof RECORD_ACTIONS)[number];

export type Scope = "all" | "own" | "none";

export const TOOLS = [
  "sequences.enroll",
  "sequences.bulk_enroll",
  "sequences.manage_others",
  "data.import",
  "data.export_lists",
  "data.bulk_edit",
  "data.bulk_delete",
  "data.bulk_reassign",
  "reports.view",
  "reports.create",
  "reports.manage_all",
  "history.view",
  "setup.pipeline_stages",
  "setup.dnc_list",
  "setup.org_settings",
  "account.users_and_roles",
  "account.billing",
  "account.full_export",
] as const;
export type Tool = (typeof TOOLS)[number];

/** Stored on roles.permissions. Missing keys mean "none" / off. */
export type PermissionMap = Record<string, string | boolean>;

export type PresetKey = "admin" | "manager" | "rep" | "read_only";

function build(
  record: { view: Scope; create: boolean; edit: Scope; delete: Scope },
  tools: Tool[],
): PermissionMap {
  const map: PermissionMap = {};
  for (const obj of OBJECTS) {
    map[`${obj}.view`] = record.view;
    map[`${obj}.edit`] = record.edit;
    map[`${obj}.delete`] = record.delete;
    map[`${obj}.create`] = record.create;
  }
  for (const tool of tools) map[tool] = true;
  return map;
}

export const PRESET_ROLES: Record<
  PresetKey,
  { name: string; locked: boolean; permissions: PermissionMap }
> = {
  admin: {
    name: "Admin",
    locked: true,
    permissions: build({ view: "all", create: true, edit: "all", delete: "all" }, [...TOOLS]),
  },
  manager: {
    name: "Manager",
    locked: false,
    permissions: build({ view: "all", create: true, edit: "all", delete: "all" }, [
      "sequences.enroll",
      "sequences.bulk_enroll",
      "sequences.manage_others",
      "data.import",
      "data.export_lists",
      "data.bulk_edit",
      "data.bulk_delete",
      "data.bulk_reassign",
      "reports.view",
      "reports.create",
      "reports.manage_all",
      "history.view",
      "setup.pipeline_stages",
      "setup.dnc_list",
    ]),
  },
  rep: {
    name: "Rep",
    locked: false,
    permissions: build({ view: "all", create: true, edit: "all", delete: "none" }, [
      "sequences.enroll",
      "sequences.bulk_enroll",
      "data.import",
      "data.bulk_edit",
      "reports.view",
      "reports.create",
      "history.view",
    ]),
  },
  read_only: {
    name: "Read-only",
    locked: false,
    permissions: build({ view: "all", create: false, edit: "none", delete: "none" }, [
      "reports.view",
      "history.view",
    ]),
  },
};

export class PermissionError extends Error {
  constructor(public readonly permission: string) {
    super(`Not allowed: ${permission}`);
    this.name = "PermissionError";
  }
}

export function scopeFor(perms: PermissionMap, object: ObjectName, action: RecordAction): Scope {
  const value = perms[`${object}.${action}`];
  return value === "all" || value === "own" ? value : "none";
}

/** Can this user act on this particular record? */
export function canAccessRecord(
  perms: PermissionMap,
  object: ObjectName,
  action: RecordAction,
  record: { ownerId: string },
  userId: string,
): boolean {
  const scope = scopeFor(perms, object, action);
  if (scope === "all") return true;
  if (scope === "own") return record.ownerId === userId;
  return false;
}

export function canCreate(perms: PermissionMap, object: ObjectName): boolean {
  return perms[`${object}.create`] === true;
}

export function canUse(perms: PermissionMap, tool: Tool): boolean {
  return perms[tool] === true;
}

export function requireTool(perms: PermissionMap, tool: Tool): void {
  if (!canUse(perms, tool)) throw new PermissionError(tool);
}

export function requireRecord(
  perms: PermissionMap,
  object: ObjectName,
  action: RecordAction,
  record: { ownerId: string },
  userId: string,
): void {
  if (!canAccessRecord(perms, object, action, record, userId)) {
    throw new PermissionError(`${object}.${action}`);
  }
}
