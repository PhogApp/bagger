import { and, eq } from "drizzle-orm";
import { memberships, organizations, roles, users } from "../../shared/schema";
import type { Db } from "../db/types";
import { createOrganization } from "../orgs/provision";

/**
 * Connects a signed-in Clerk user to Bagger's own records.
 *
 * Clerk owns sign-in, invitations, and which organization a person belongs
 * to. Bagger owns everything else, including roles. The first time we see a
 * Clerk user or organization we create the matching Bagger rows:
 *   - a new organization gets settings and the preset roles, and the person
 *     who created it becomes its Admin;
 *   - a person joining an existing organization becomes a Rep, unless Clerk
 *     says they are an organization admin.
 * After that, role changes are made in Bagger and Clerk's role is ignored.
 */

export interface ClerkIdentity {
  clerkUserId: string;
  clerkOrgId: string;
  /** Clerk's own role key, e.g. "org:admin" or "org:member". */
  clerkOrgRole?: string | null;
}

/** Looks up names and emails. Backed by the Clerk API in production. */
export interface ProfileSource {
  user(clerkUserId: string): Promise<{ email: string; name: string }>;
  organization(clerkOrgId: string): Promise<{ name: string }>;
}

export interface LocalIdentity {
  orgId: string;
  userId: string;
}

async function findExisting(db: Db, identity: ClerkIdentity): Promise<LocalIdentity | null> {
  const [row] = await db
    .select({ orgId: memberships.orgId, userId: memberships.userId })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(
      and(
        eq(users.clerkUserId, identity.clerkUserId),
        eq(organizations.clerkOrgId, identity.clerkOrgId),
      ),
    );
  return row ?? null;
}

async function createMissing(
  db: Db,
  identity: ClerkIdentity,
  source: ProfileSource,
): Promise<LocalIdentity> {
  // Fetch from Clerk before opening the transaction so it stays short.
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, identity.clerkUserId));
  const [existingOrg] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.clerkOrgId, identity.clerkOrgId));
  const profile = existingUser ? null : await source.user(identity.clerkUserId);
  const orgProfile = existingOrg ? null : await source.organization(identity.clerkOrgId);

  return db.transaction(async (tx) => {
    let userId = existingUser?.id;
    if (!userId && profile) {
      const email = profile.email.trim().toLowerCase();
      const [byEmail] = await tx.select().from(users).where(eq(users.email, email));
      if (byEmail?.clerkUserId && byEmail.clerkUserId !== identity.clerkUserId) {
        throw new Error("This email address is already linked to a different sign-in");
      }
      if (byEmail) {
        await tx
          .update(users)
          .set({ clerkUserId: identity.clerkUserId })
          .where(eq(users.id, byEmail.id));
        userId = byEmail.id;
      } else {
        const [created] = await tx
          .insert(users)
          .values({ email, name: profile.name, clerkUserId: identity.clerkUserId })
          .returning();
        userId = created.id;
      }
    }
    if (!userId) throw new Error("Could not resolve user");

    let orgId = existingOrg?.id;
    let isNewOrg = false;
    if (!orgId && orgProfile) {
      const created = await createOrganization(tx, {
        name: orgProfile.name,
        clerkOrgId: identity.clerkOrgId,
      });
      orgId = created.orgId;
      isNewOrg = true;
    }
    if (!orgId) throw new Error("Could not resolve organization");

    const [membership] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
    if (!membership) {
      const presetKey = isNewOrg || identity.clerkOrgRole === "org:admin" ? "admin" : "rep";
      const [role] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), eq(roles.presetKey, presetKey)));
      await tx.insert(memberships).values({ orgId, userId, roleId: role.id });
    }
    return { orgId, userId };
  });
}

export async function syncIdentity(
  db: Db,
  identity: ClerkIdentity,
  source: ProfileSource,
): Promise<LocalIdentity> {
  const existing = await findExisting(db, identity);
  if (existing) return existing;
  try {
    return await createMissing(db, identity, source);
  } catch (err) {
    // Two first requests can race to create the same rows. The loser hits a
    // unique constraint; by then the winner's rows exist.
    const retry = await findExisting(db, identity);
    if (retry) return retry;
    throw err;
  }
}
