import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveActor } from "../server/auth/actor";
import { syncIdentity, type ProfileSource } from "../server/auth/identity";
import type { Db } from "../server/db/types";
import * as s from "../shared/schema";
import { createTestDb } from "./helpers";

let db: Db;
let lookups: string[];

/** Stand-in for the Clerk API that records what was asked of it. */
const source: ProfileSource = {
  async user(id) {
    lookups.push(`user:${id}`);
    return { email: `${id}@Example.com`, name: `Name of ${id}` };
  },
  async organization(id) {
    lookups.push(`org:${id}`);
    return { name: `Org ${id}` };
  },
};

beforeEach(async () => {
  db = await createTestDb();
  lookups = [];
});

describe("first sign-in", () => {
  it("creates the organization with preset roles and makes its creator Admin", async () => {
    const local = await syncIdentity(db, { clerkUserId: "u1", clerkOrgId: "o1" }, source);
    const actor = await resolveActor(db, local);
    expect(actor?.roleName).toBe("Admin");
    expect(actor?.billingStatus).toBe("active");
    expect(actor?.isOwner).toBe(true);

    const roles = await db.select().from(s.roles).where(eq(s.roles.orgId, local.orgId));
    expect(roles.map((r) => r.name).sort()).toEqual(["Admin", "Manager", "Read-only", "Rep"]);
    const [settings] = await db
      .select()
      .from(s.orgSettings)
      .where(eq(s.orgSettings.orgId, local.orgId));
    expect(settings.waitDayMode).toBe("business");
    const [user] = await db.select().from(s.users).where(eq(s.users.id, local.userId));
    expect(user).toMatchObject({ email: "u1@example.com", name: "Name of u1" });
  });

  it("makes a person who joins an existing organization a Rep", async () => {
    await syncIdentity(db, { clerkUserId: "u1", clerkOrgId: "o1" }, source);
    const joiner = await syncIdentity(
      db,
      { clerkUserId: "u2", clerkOrgId: "o1", clerkOrgRole: "org:member" },
      source,
    );
    expect((await resolveActor(db, joiner))?.roleName).toBe("Rep");
  });

  it("makes a joining Clerk organization admin an Admin", async () => {
    await syncIdentity(db, { clerkUserId: "u1", clerkOrgId: "o1" }, source);
    const joiner = await syncIdentity(
      db,
      { clerkUserId: "u3", clerkOrgId: "o1", clerkOrgRole: "org:admin" },
      source,
    );
    const actor = await resolveActor(db, joiner);
    expect(actor?.roleName).toBe("Admin");
    expect(actor?.isOwner).toBe(false); // an Admin, but not the owner
  });
});

describe("later sign-ins", () => {
  it("reuses the same rows and does not call Clerk again", async () => {
    const first = await syncIdentity(db, { clerkUserId: "u1", clerkOrgId: "o1" }, source);
    lookups = [];
    const second = await syncIdentity(db, { clerkUserId: "u1", clerkOrgId: "o1" }, source);
    expect(second).toEqual(first);
    expect(lookups).toEqual([]);
    expect(await db.select().from(s.organizations)).toHaveLength(1);
    expect(await db.select().from(s.users)).toHaveLength(1);
  });

  it("keeps a role that was changed in Bagger, whatever Clerk says", async () => {
    await syncIdentity(db, { clerkUserId: "u1", clerkOrgId: "o1" }, source);
    const rep = await syncIdentity(db, { clerkUserId: "u2", clerkOrgId: "o1" }, source);
    const [manager] = await db.select().from(s.roles).where(eq(s.roles.presetKey, "manager"));
    await db
      .update(s.memberships)
      .set({ roleId: manager.id })
      .where(eq(s.memberships.userId, rep.userId));
    const again = await syncIdentity(
      db,
      { clerkUserId: "u2", clerkOrgId: "o1", clerkOrgRole: "org:admin" },
      source,
    );
    expect((await resolveActor(db, again))?.roleName).toBe("Manager");
  });

  it("lets one person belong to two organizations with different roles", async () => {
    const a = await syncIdentity(db, { clerkUserId: "u1", clerkOrgId: "o1" }, source);
    await syncIdentity(db, { clerkUserId: "u9", clerkOrgId: "o2" }, source);
    const b = await syncIdentity(db, { clerkUserId: "u1", clerkOrgId: "o2" }, source);
    expect(b.userId).toBe(a.userId);
    expect(b.orgId).not.toBe(a.orgId);
    expect((await resolveActor(db, a))?.roleName).toBe("Admin");
    expect((await resolveActor(db, b))?.roleName).toBe("Rep");
  });

  it("does not let a removed user back in by signing in again", async () => {
    await syncIdentity(db, { clerkUserId: "u1", clerkOrgId: "o1" }, source);
    const rep = await syncIdentity(db, { clerkUserId: "u2", clerkOrgId: "o1" }, source);
    await db
      .update(s.memberships)
      .set({ status: "removed" })
      .where(eq(s.memberships.userId, rep.userId));
    const again = await syncIdentity(db, { clerkUserId: "u2", clerkOrgId: "o1" }, source);
    expect(await resolveActor(db, again)).toBeNull();
  });

  it("survives two first requests arriving at the same moment", async () => {
    const [a, b] = await Promise.all([
      syncIdentity(db, { clerkUserId: "u1", clerkOrgId: "o1" }, source),
      syncIdentity(db, { clerkUserId: "u1", clerkOrgId: "o1" }, source),
    ]);
    expect(a).toEqual(b);
    expect(await db.select().from(s.organizations)).toHaveLength(1);
    expect(await db.select().from(s.memberships)).toHaveLength(1);
  });
});
