import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { memberships, organizations, roles, users } from "../../shared/schema";
import { diffFields, recordUpdate } from "../audit/history";
import type { Actor } from "../auth/actor";
import { PermissionError } from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";

/**
 * The Organization tab. Only the organization's owner may use it: one person
 * answerable for billing and for handing the organization on.
 */

function requireOwner(actor: Actor) {
  if (!actor.isOwner) throw new PermissionError("organization.owner");
}

export async function getOrganization(db: Db, actor: Actor) {
  requireOwner(actor);
  const [org] = await db.select().from(organizations).where(eq(organizations.id, actor.orgId));
  if (!org) throw new NotFoundError("organization");
  const [owner] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, actor.userId));
  // Ownership can only pass to someone who is already an Admin.
  const admins = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .innerJoin(roles, eq(memberships.roleId, roles.id))
    .where(
      and(
        eq(memberships.orgId, actor.orgId),
        eq(roles.presetKey, "admin"),
        inArray(memberships.status, ["active", "ending"]),
      ),
    )
    .orderBy(asc(users.name));
  return {
    name: org.name,
    billingEmail: org.billingEmail,
    billingStatus: org.billingStatus,
    owner,
    transferCandidates: admins.filter((a) => a.id !== actor.userId),
  };
}

export const organizationInput = z.object({
  billingEmail: z
    .union([z.literal(""), z.email().trim().toLowerCase()])
    .transform((v) => (v === "" ? null : v))
    .nullable(),
});

export async function updateOrganization(db: Db, actor: Actor, raw: unknown) {
  requireOwner(actor);
  const patch = organizationInput.parse(raw);
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, actor.orgId))
      .for("update");
    const changes = diffFields(before, patch);
    if (changes.length === 0) return;
    await tx.update(organizations).set(patch).where(eq(organizations.id, actor.orgId));
    await recordUpdate(tx, actor, "organization", actor.orgId, changes);
  });
  return getOrganization(db, actor);
}

export const transferInput = z.object({ userId: z.uuid() });

/**
 * Hand the organization to another Admin. Takes effect at once, with no
 * acceptance step; the previous owner stays on as an ordinary Admin.
 */
export async function transferOwnership(db: Db, actor: Actor, raw: unknown) {
  requireOwner(actor);
  const { userId } = transferInput.parse(raw);
  if (userId === actor.userId) throw new ValidationError("You already own this organization");

  await db.transaction(async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, actor.orgId))
      .for("update");
    // Re-check under the lock: two transfers at once must not both succeed.
    if (org.ownerUserId !== actor.userId) throw new PermissionError("organization.owner");

    const [target] = await tx
      .select({ name: users.name, presetKey: roles.presetKey })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .innerJoin(roles, eq(memberships.roleId, roles.id))
      .where(
        and(
          eq(memberships.orgId, actor.orgId),
          eq(memberships.userId, userId),
          inArray(memberships.status, ["active", "ending"]),
        ),
      )
      .for("update");
    if (!target) throw new NotFoundError("user");
    if (target.presetKey !== "admin") {
      throw new ValidationError("Make this person an Admin first, then transfer ownership");
    }
    const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.userId));

    await tx
      .update(organizations)
      .set({ ownerUserId: userId })
      .where(eq(organizations.id, actor.orgId));
    await recordUpdate(tx, actor, "organization", actor.orgId, [
      { field: "owner", oldValue: me?.name ?? actor.userId, newValue: target.name },
    ]);
  });
}
