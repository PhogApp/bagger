import { clerkClient, clerkMiddleware, getAuth } from "@clerk/express";
import type { RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { organizations, users } from "../../shared/schema";
import type { Db } from "../db/types";
import type { Authenticator } from "../http/app";
import type { RoleChangeListener } from "../settings/service";
import { resolveActor } from "./actor";
import { syncIdentity, type ProfileSource } from "./identity";

const clerkProfiles: ProfileSource = {
  async user(clerkUserId) {
    const user = await clerkClient.users.getUser(clerkUserId);
    const email =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
      user.emailAddresses[0]?.emailAddress;
    if (!email) throw new Error("Clerk user has no email address");
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || email;
    return { email, name };
  },
  async organization(clerkOrgId) {
    const org = await clerkClient.organizations.getOrganization({ organizationId: clerkOrgId });
    return { name: org.name };
  },
};

/** Reads the Clerk session on every request. Requires the CLERK_* env vars. */
export function clerkSession(): RequestHandler {
  return clerkMiddleware();
}

/**
 * A request is signed in when it carries a Clerk session with an active
 * organization. Signed in with no organization selected counts as not signed
 * in; the client sends the user to create or pick one first.
 */
export function clerkAuthenticator(db: Db): Authenticator {
  return async (req) => {
    const auth = getAuth(req);
    if (!auth.userId || !auth.orgId) return null;
    const local = await syncIdentity(
      db,
      { clerkUserId: auth.userId, clerkOrgId: auth.orgId, clerkOrgRole: auth.orgRole },
      clerkProfiles,
    );
    return resolveActor(db, local);
  };
}

/**
 * Keeps Clerk's own admin flag in step with Bagger's Admin role. Clerk draws
 * the screens for inviting and removing people and only lets its own admins
 * use them, so a Bagger Admin must be a Clerk admin too.
 */
export function clerkRoleSync(db: Db): RoleChangeListener {
  return async ({ orgId, userId, isAdmin }) => {
    const [org] = await db
      .select({ clerkOrgId: organizations.clerkOrgId })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    const [user] = await db
      .select({ clerkUserId: users.clerkUserId })
      .from(users)
      .where(eq(users.id, userId));
    if (!org?.clerkOrgId || !user?.clerkUserId) return;
    try {
      await clerkClient.organizations.updateOrganizationMembership({
        organizationId: org.clerkOrgId,
        userId: user.clerkUserId,
        role: isAdmin ? "org:admin" : "org:member",
      });
    } catch (err) {
      // The Bagger role is already saved and is what Bagger enforces. Log
      // and carry on; the next role change will try again.
      console.error("Could not update the Clerk role", err);
    }
  };
}
