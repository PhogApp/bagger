import { describe, expect, it } from "vitest";
import {
  canAccessRecord,
  canCreate,
  canUse,
  PRESET_ROLES,
  requireTool,
} from "../server/auth/permissions";

const mine = { ownerId: "me" };
const theirs = { ownerId: "someone-else" };

describe("preset roles", () => {
  it("rep can view and edit anyone's records but not delete", () => {
    const p = PRESET_ROLES.rep.permissions;
    expect(canAccessRecord(p, "leads", "view", theirs, "me")).toBe(true);
    expect(canAccessRecord(p, "leads", "edit", theirs, "me")).toBe(true);
    expect(canAccessRecord(p, "leads", "delete", mine, "me")).toBe(false);
    expect(canCreate(p, "contacts")).toBe(true);
    expect(canUse(p, "sequences.enroll")).toBe(true);
    expect(canUse(p, "data.export_lists")).toBe(false);
    expect(canUse(p, "data.bulk_delete")).toBe(false);
    expect(canUse(p, "sequences.manage_others")).toBe(false);
  });

  it("manager can delete and export but not manage users or billing", () => {
    const p = PRESET_ROLES.manager.permissions;
    expect(canAccessRecord(p, "accounts", "delete", theirs, "me")).toBe(true);
    expect(canUse(p, "data.export_lists")).toBe(true);
    expect(canUse(p, "setup.dnc_list")).toBe(true);
    expect(canUse(p, "setup.org_settings")).toBe(false);
    expect(canUse(p, "account.users_and_roles")).toBe(false);
    expect(canUse(p, "account.billing")).toBe(false);
  });

  it("read-only can look but not touch", () => {
    const p = PRESET_ROLES.read_only.permissions;
    expect(canAccessRecord(p, "leads", "view", theirs, "me")).toBe(true);
    expect(canAccessRecord(p, "leads", "edit", mine, "me")).toBe(false);
    expect(canCreate(p, "leads")).toBe(false);
    expect(canUse(p, "sequences.enroll")).toBe(false);
    expect(canUse(p, "reports.view")).toBe(true);
  });

  it("admin has everything and is locked", () => {
    const p = PRESET_ROLES.admin.permissions;
    expect(PRESET_ROLES.admin.locked).toBe(true);
    expect(canUse(p, "account.billing")).toBe(true);
    expect(() => requireTool(p, "account.full_export")).not.toThrow();
  });
});

describe("scopes", () => {
  it("'own' limits access to records the user owns", () => {
    const p = { ...PRESET_ROLES.rep.permissions, "leads.edit": "own" };
    expect(canAccessRecord(p, "leads", "edit", mine, "me")).toBe(true);
    expect(canAccessRecord(p, "leads", "edit", theirs, "me")).toBe(false);
  });
  it("a missing permission means no access", () => {
    expect(canAccessRecord({}, "leads", "view", mine, "me")).toBe(false);
    expect(() => requireTool({}, "data.import")).toThrow("Not allowed");
  });
});
