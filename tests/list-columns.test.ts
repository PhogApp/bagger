import { beforeAll, describe, expect, it } from "vitest";
import { resolveActor, type Actor } from "../server/auth/actor";
import type { Db } from "../server/db/types";
import { leadService, opportunityService, accountService } from "../server/records";
import { createOrg, createTestDb } from "./helpers";

let db: Db;
let actor: Actor;

beforeAll(async () => {
  db = await createTestDb();
  actor = (await resolveActor(db, await createOrg(db)))!;
});

describe("lists sort by any of the record's fields", () => {
  it("sorts text without regard to case, and numbers and dates as such", async () => {
    for (const [first, phone, linkedin] of [
      ["Ann", "555-0300", "linkedin.com/in/zed"],
      ["bea", "555-0100", "LinkedIn.com/in/amy"],
      ["Cy", "555-0200", null],
    ] as const) {
      await leadService.create(db, actor, {
        firstName: first,
        lastName: "Sort",
        email: `${first.toLowerCase()}@sort.example`,
        cellPhone: phone,
        linkedin,
      });
    }
    const names = async (sort: string, dir: "asc" | "desc" = "asc") =>
      (await leadService.list(db, actor, { sort, dir })).map((l) => l.firstName);
    expect(await names("cellPhone")).toEqual(["bea", "Cy", "Ann"]);
    expect(await names("firstName", "desc")).toEqual(["Cy", "bea", "Ann"]);
    // Empty values go last either way.
    expect(await names("linkedin")).toEqual(["bea", "Ann", "Cy"]);
    expect(await names("linkedin", "desc")).toEqual(["Ann", "bea", "Cy"]);

    const account = await accountService.create(db, actor, { name: "Sorters" });
    for (const [name, amount] of [
      ["Small", "900"],
      ["Big", "12000"],
    ]) {
      await opportunityService.create(db, actor, { name, accountId: account.id, amount });
    }
    const byAmount = await opportunityService.list(db, actor, { sort: "amount", dir: "desc" });
    expect(byAmount.map((o) => o.name)).toEqual(["Big", "Small"]);
  });

  it("refuses ids and system columns", async () => {
    for (const sort of ["orgId", "ownerId", "custom", "deletedAt", "nope"]) {
      await expect(leadService.list(db, actor, { sort })).rejects.toThrow(/can't be sorted/);
    }
  });
});
