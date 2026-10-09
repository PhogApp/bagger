import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { diffFields, recordLifecycle, recordUpdate } from "../server/audit/history";
import * as s from "../shared/schema";
import { createLead, createOrg, createTestDb } from "./helpers";

describe("diffFields", () => {
  it("reports only the fields that actually changed", () => {
    const before = { title: "CFO", status: "New", notes: null, updatedAt: new Date() };
    const changes = diffFields(before, {
      title: "CEO",
      status: "New",
      notes: "Met at SuiteWorld",
      updatedAt: new Date(),
    });
    expect(changes).toEqual([
      { field: "title", oldValue: "CFO", newValue: "CEO" },
      { field: "notes", oldValue: null, newValue: "Met at SuiteWorld" },
    ]);
  });
});

describe("audit history", () => {
  it("stores old value, new value, user and time for each changed field", async () => {
    const db = await createTestDb();
    const ctx = await createOrg(db);
    const lead = await createLead(db, ctx, { title: "CFO" });

    await db.transaction(async (tx) => {
      const patch = { title: "CEO", status: "Active" as const };
      await tx.update(s.leads).set(patch).where(eq(s.leads.id, lead.id));
      await recordLifecycle(tx, ctx, "lead", lead.id, "create");
      await recordUpdate(tx, ctx, "lead", lead.id, diffFields(lead, patch));
    });

    const rows = await db.select().from(s.fieldHistory).where(eq(s.fieldHistory.recordId, lead.id));
    const updates = rows.filter((r) => r.action === "update");
    expect(updates.map((r) => [r.field, r.oldValue, r.newValue]).sort()).toEqual([
      ["status", "New", "Active"],
      ["title", "CFO", "CEO"],
    ]);
    expect(rows.every((r) => r.userId === ctx.userId && r.createdAt instanceof Date)).toBe(true);
    expect(rows.some((r) => r.action === "create")).toBe(true);
  });

  it("rolls back the history if the change itself fails", async () => {
    const db = await createTestDb();
    const ctx = await createOrg(db);
    const lead = await createLead(db, ctx);
    await expect(
      db.transaction(async (tx) => {
        await recordUpdate(tx, ctx, "lead", lead.id, [
          { field: "title", oldValue: null, newValue: "X" },
        ]);
        throw new Error("change failed");
      }),
    ).rejects.toThrow("change failed");
    expect(await db.select().from(s.fieldHistory)).toHaveLength(0);
  });
});
