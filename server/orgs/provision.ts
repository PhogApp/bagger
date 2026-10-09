import { memberships, organizations, orgSettings, roles, users } from "../../shared/schema";
import { PRESET_ROLES, type PresetKey } from "../auth/permissions";
import type { Db } from "../db/types";

/**
 * Create an organization with its settings and the four preset roles.
 * Run inside a transaction; the caller adds the first Admin.
 */
export async function createOrganization(
  tx: Db,
  input: { name: string; clerkOrgId?: string; timezone?: string },
): Promise<{ orgId: string; roleIds: Record<PresetKey, string> }> {
  const [org] = await tx
    .insert(organizations)
    .values({ name: input.name, clerkOrgId: input.clerkOrgId })
    .returning();
  await tx
    .insert(orgSettings)
    .values({ orgId: org.id, ...(input.timezone ? { timezone: input.timezone } : {}) });

  const roleIds = {} as Record<PresetKey, string>;
  for (const key of Object.keys(PRESET_ROLES) as PresetKey[]) {
    const preset = PRESET_ROLES[key];
    const [role] = await tx
      .insert(roles)
      .values({
        orgId: org.id,
        name: preset.name,
        presetKey: key,
        locked: preset.locked,
        permissions: preset.permissions,
      })
      .returning();
    roleIds[key] = role.id;
  }
  return { orgId: org.id, roleIds };
}

/**
 * Create an organization together with its first user as Admin. Every
 * organization must always have an Admin.
 */
export async function provisionOrganization(
  db: Db,
  input: {
    name: string;
    admin: { email: string; name: string; clerkUserId?: string };
    clerkOrgId?: string;
    timezone?: string;
  },
): Promise<{ orgId: string; adminUserId: string; roleIds: Record<PresetKey, string> }> {
  return db.transaction(async (tx) => {
    const { orgId, roleIds } = await createOrganization(tx, input);
    const [admin] = await tx
      .insert(users)
      .values({
        email: input.admin.email.toLowerCase(),
        name: input.admin.name,
        clerkUserId: input.admin.clerkUserId,
      })
      .returning();
    await tx.insert(memberships).values({ orgId, userId: admin.id, roleId: roleIds.admin });
    return { orgId, adminUserId: admin.id, roleIds };
  });
}
