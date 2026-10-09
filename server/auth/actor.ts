import { and, eq, inArray } from "drizzle-orm";
import { memberships, organizations, roles } from "../../shared/schema";
import type { Ctx, Db } from "../db/types";
import type { PermissionMap } from "./permissions";

/** The signed-in user, their organization, and what their role allows. */
export interface Actor extends Ctx {
  permissions: PermissionMap;
  roleName: string;
  billingStatus: "active" | "locked" | "cancelled";
}

/**
 * Look up a user's membership in an organization. Returns null when they are
 * not a member (or have been removed), which callers treat as "not signed in".
 */
export async function resolveActor(
  db: Db,
  who: { orgId: string; userId: string },
): Promise<Actor | null> {
  const [row] = await db
    .select({
      permissions: roles.permissions,
      roleName: roles.name,
      billingStatus: organizations.billingStatus,
    })
    .from(memberships)
    .innerJoin(roles, eq(memberships.roleId, roles.id))
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(
      and(
        eq(memberships.orgId, who.orgId),
        eq(memberships.userId, who.userId),
        // "ending" seats keep access until the end of the month.
        inArray(memberships.status, ["active", "ending"]),
      ),
    );
  if (!row) return null;
  return { orgId: who.orgId, userId: who.userId, ...row };
}

/** Is this user an active member of the organization? Used to validate owners. */
export async function isMember(db: Db, orgId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.userId, userId),
        inArray(memberships.status, ["active", "ending"]),
      ),
    );
  return Boolean(row);
}
