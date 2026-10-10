import { describe, expect, it } from "vitest";
import { resolveActor } from "../server/auth/actor";
import { changeUserRole, listRoles } from "../server/settings/service";
import { addMember, createOrg, createTestDb } from "./helpers";

describe("telling the sign-in provider about role changes", () => {
  it("reports when someone gains or loses Admin, and stays quiet otherwise", async () => {
    const db = await createTestDb();
    const org = await createOrg(db);
    const person = await addMember(db, org.orgId, "rep", "Person");
    const admin = (await resolveActor(db, org))!;
    const roles = await listRoles(db, admin);
    const role = (name: string) => roles.find((r) => r.name === name)!.id;

    const seen: { userId: string; isAdmin: boolean }[] = [];
    const listener = async (change: { orgId: string; userId: string; isAdmin: boolean }) => {
      seen.push({ userId: change.userId, isAdmin: change.isAdmin });
    };

    await changeUserRole(db, admin, person.userId, { roleId: role("Admin") }, listener);
    await changeUserRole(db, admin, person.userId, { roleId: role("Admin") }, listener); // no change
    await changeUserRole(db, admin, person.userId, { roleId: role("Manager") }, listener);

    expect(seen).toEqual([
      { userId: person.userId, isAdmin: true },
      { userId: person.userId, isAdmin: false },
    ]);
  });

  it("does not report a change that was refused", async () => {
    const db = await createTestDb();
    const org = await createOrg(db);
    const admin = (await resolveActor(db, org))!;
    const roles = await listRoles(db, admin);
    const seen: unknown[] = [];
    await expect(
      changeUserRole(
        db,
        admin,
        org.userId,
        { roleId: roles.find((r) => r.name === "Rep")!.id },
        async (c) => void seen.push(c),
      ),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
