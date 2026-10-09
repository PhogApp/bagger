import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { memberships, orgSettings, roles, users, waitDayModeEnum } from "../../shared/schema";
import { diffFields, recordUpdate } from "../audit/history";
import type { Actor } from "../auth/actor";
import { requireTool } from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";
import { isValidTimeZone } from "../sequences/dates";

const timezone = z.string().refine(isValidTimeZone, { message: "Unknown time zone" });

// ------------------------------------------------------------ my settings

export const mySettingsInput = z.object({ timezone: timezone.nullable() });

/**
 * A user's own settings. `timezone` is what they chose (or null);
 * `effectiveTimezone` is what Bagger actually uses for their due dates.
 */
export async function getMySettings(db: Db, actor: Actor) {
  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, actor.userId));
  const [org] = await db
    .select({ timezone: orgSettings.timezone })
    .from(orgSettings)
    .where(eq(orgSettings.orgId, actor.orgId));
  const fallback = org?.timezone ?? "America/Chicago";
  return {
    timezone: user?.timezone ?? null,
    effectiveTimezone: user?.timezone ?? fallback,
    organizationDefault: fallback,
  };
}

export async function updateMySettings(db: Db, actor: Actor, raw: unknown) {
  const patch = mySettingsInput.parse(raw);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.id, actor.userId)).for("update");
    const changes = diffFields(before, patch);
    if (changes.length === 0) return;
    await tx.update(users).set(patch).where(eq(users.id, actor.userId));
    await recordUpdate(tx, actor, "user", actor.userId, changes);
  });
  return getMySettings(db, actor);
}

// ---------------------------------------------------- organization settings

export const orgSettingsInput = z
  .object({
    waitDayMode: z.enum(waitDayModeEnum.enumValues),
    timezone,
    postalAddress: z
      .string()
      .trim()
      .transform((v) => (v === "" ? null : v))
      .nullable(),
  })
  .partial();

/** Any member may read these; the screens show the wait-day rule to everyone. */
export async function getOrgSettings(db: Db, actor: Actor) {
  const [row] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, actor.orgId));
  if (!row) throw new NotFoundError("organization settings");
  return {
    waitDayMode: row.waitDayMode,
    timezone: row.timezone,
    postalAddress: row.postalAddress,
  };
}

/**
 * Changing the wait-day mode affects tasks created from now on. Tasks that
 * are already open keep their due date.
 */
export async function updateOrgSettings(db: Db, actor: Actor, raw: unknown) {
  requireTool(actor.permissions, "setup.org_settings");
  const patch = orgSettingsInput.parse(raw);
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(orgSettings)
      .where(eq(orgSettings.orgId, actor.orgId))
      .for("update");
    if (!before) throw new NotFoundError("organization settings");
    const changes = diffFields(before, patch);
    if (changes.length === 0) return;
    await tx
      .update(orgSettings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(orgSettings.orgId, actor.orgId));
    await recordUpdate(tx, actor, "org_settings", actor.orgId, changes);
  });
  return getOrgSettings(db, actor);
}

// ------------------------------------------------------- users and roles

export async function listUsers(db: Db, actor: Actor) {
  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: roles.name,
      roleId: roles.id,
      status: memberships.status,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .innerJoin(roles, eq(memberships.roleId, roles.id))
    .where(
      and(eq(memberships.orgId, actor.orgId), inArray(memberships.status, ["active", "ending"])),
    )
    .orderBy(asc(users.name));
}

export async function listRoles(db: Db, actor: Actor) {
  return db
    .select({ id: roles.id, name: roles.name, presetKey: roles.presetKey, locked: roles.locked })
    .from(roles)
    .where(eq(roles.orgId, actor.orgId))
    .orderBy(asc(roles.createdAt));
}

export const changeRoleInput = z.object({ roleId: z.uuid() });

export async function changeUserRole(db: Db, actor: Actor, userId: string, raw: unknown) {
  requireTool(actor.permissions, "account.users_and_roles");
  const { roleId } = changeRoleInput.parse(raw);
  await db.transaction(async (tx) => {
    // Lock every active membership in the org so two admins demoting each
    // other at the same moment cannot leave the organization with none.
    const members = await tx
      .select({ membership: memberships, roleName: roles.name, presetKey: roles.presetKey })
      .from(memberships)
      .innerJoin(roles, eq(memberships.roleId, roles.id))
      .where(
        and(eq(memberships.orgId, actor.orgId), inArray(memberships.status, ["active", "ending"])),
      )
      .for("update");
    const target = members.find((m) => m.membership.userId === userId);
    if (!target) throw new NotFoundError("user");

    const [newRole] = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)));
    if (!newRole) throw new ValidationError("Role not found");
    if (newRole.id === target.membership.roleId) return;

    const admins = members.filter((m) => m.presetKey === "admin");
    if (target.presetKey === "admin" && admins.length === 1) {
      throw new ValidationError(
        "This is the only Admin. Make someone else an Admin before changing this role.",
      );
    }

    await tx
      .update(memberships)
      .set({ roleId: newRole.id })
      .where(eq(memberships.id, target.membership.id));
    await recordUpdate(tx, actor, "membership", target.membership.id, [
      { field: "role", oldValue: target.roleName, newValue: newRole.name },
    ]);
  });
}
