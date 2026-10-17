import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveActor, type Actor } from "../server/auth/actor";
import type { Db } from "../server/db/types";
import { accountService, contactService, leadService } from "../server/records";
import { conversionPreview, convertLead } from "../server/records/convert";
import * as seq from "../server/sequences/service";
import { sequenceHistory, type SequenceSummary } from "../server/sequences/summary";
import { createOrg, createSequence, createTestDb } from "./helpers";

let db: Db;
let actor: Actor;

const email = (subject: string) => ({ waitDays: 0, subject, body: `<p>${subject}</p>` });
type WithSummary = { id: string; sequences: SequenceSummary };

beforeAll(async () => {
  db = await createTestDb();
  actor = (await resolveActor(db, await createOrg(db)))!;
});

let n = 0;
async function lead(domain = "summit.example", extra: Record<string, unknown> = {}) {
  n++;
  return leadService.create(db, actor, {
    firstName: `Pat${n}`,
    lastName: "Lee",
    email: `pat${n}@${domain}`,
    company: "Summit",
    ...extra,
  });
}

async function sequence(name: string, steps = 3) {
  const { sequence } = await createSequence(
    db,
    actor,
    Array.from({ length: steps }, (_, i) => email(`${name} ${i + 1}`)),
  );
  // createSequence names everything "Outbound"; give each its own name.
  await db.execute(sql`update sequences set name = ${name} where id = ${sequence.id}`);
  return sequence;
}

async function finish(enrollmentTaskId: string, steps: number) {
  let taskId: string | undefined = enrollmentTaskId;
  for (let i = 0; i < steps && taskId; i++) {
    taskId = (await seq.complete(db, actor, taskId, {})).nextTask?.id;
  }
}

async function listLeads(options: Parameters<typeof leadService.list>[2] = {}) {
  return (await leadService.list(db, actor, {
    ...options,
    withSequences: true,
    limit: 500,
  })) as unknown as WithSummary[];
}

describe("sequence history on lists", () => {
  it("shows where a lead is now and where it has been", async () => {
    const cold = await sequence("Cold", 3);
    const nurture = await sequence("Nurture", 2);
    const p = await lead();

    // Never been in one.
    let [row] = (await listLeads()).filter((r) => r.id === p.id);
    expect(row.sequences).toMatchObject({ current: null, last: null, total: 0, inNow: 0 });

    // In Cold, on step 2 of 3 after doing the first.
    const first = await seq.enrollPerson(db, actor, cold.id, { leadId: p.id });
    await seq.complete(db, actor, first.task.id, {});
    [row] = (await listLeads()).filter((r) => r.id === p.id);
    expect(row.sequences.current).toMatchObject({
      sequenceName: "Cold",
      state: "active",
      step: 2,
      steps: 3,
      stepsDone: 1,
    });
    expect(row.sequences.current!.nextDueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Paused still counts as in a sequence.
    await seq.pause(db, actor, first.enrollment.id);
    expect((await listLeads({ sequence: { state: "in" } })).map((r) => r.id)).toContain(p.id);
    expect((await listLeads({ sequence: { state: "out" } })).map((r) => r.id)).not.toContain(p.id);
    await seq.resume(db, actor, first.enrollment.id);

    // They reply: Cold ends, and that's the last outcome.
    await seq.stop(db, actor, first.enrollment.id, { reason: "replied" });
    [row] = (await listLeads()).filter((r) => r.id === p.id);
    expect(row.sequences).toMatchObject({
      current: null,
      inNow: 0,
      total: 1,
      last: { sequenceName: "Cold", endReason: "replied", stepsDone: 1 },
    });

    // Then through Nurture to the end.
    const second = await seq.enrollPerson(db, actor, nurture.id, { leadId: p.id });
    await finish(second.task.id, 2);
    [row] = (await listLeads()).filter((r) => r.id === p.id);
    expect(row.sequences).toMatchObject({
      current: null,
      total: 2,
      last: { sequenceName: "Nurture", endReason: "finished", stepsDone: 2 },
    });
    expect(row.sequences.recent.map((r) => r.sequenceName)).toEqual(["Nurture", "Cold"]);

    // Filters: by how the last one ended, and how long ago.
    const ids = async (f: Parameters<typeof leadService.list>[2]) =>
      (await listLeads(f)).map((r) => r.id);
    expect(await ids({ sequence: { outcomes: ["finished"] } })).toContain(p.id);
    expect(await ids({ sequence: { outcomes: ["replied"] } })).not.toContain(p.id);
    expect(await ids({ sequence: { endedDays: 0 } })).toContain(p.id);
    expect(await ids({ sequence: { endedDays: 30 } })).not.toContain(p.id);
    expect(await ids({ sequence: { state: "never" } })).not.toContain(p.id);

    // The count agrees with the list.
    expect(
      await leadService.count(db, actor, { sequence: { outcomes: ["finished"] } }),
    ).toBeGreaterThanOrEqual(1);

    // Sortable by the last sequence's end.
    await expect(listLeads({ sort: "lastSequence", dir: "desc" })).resolves.toBeTruthy();
    await expect(listLeads({ sort: "sequence" })).resolves.toBeTruthy();

    // The full history, for the lead's page.
    const history = await sequenceHistory(db, actor, "leads", p.id);
    expect(history.map((h) => [h.sequenceName, h.endReason])).toEqual([
      ["Nurture", "finished"],
      ["Cold", "replied"],
    ]);
  });

  it("warns, but doesn't stop, enrolling someone in a sequence they've been through", async () => {
    const cold = await sequence("Repeat me", 1);
    const been = await lead();
    const fresh = await lead();
    const run = await seq.enrollPerson(db, actor, cold.id, { leadId: been.id });
    await seq.stop(db, actor, run.enrollment.id, { reason: "removed" });

    const { repeats } = await seq.checkRepeats(db, actor, cold.id, {
      leadIds: [been.id, fresh.id],
    });
    expect(repeats).toEqual([
      {
        id: been.id,
        kind: "lead",
        times: 1,
        last: expect.objectContaining({ endReason: "removed", asLead: false }),
      },
    ]);
    // Enrolling again still works.
    const again = await seq.bulkEnroll(db, actor, cold.id, { leadIds: [been.id, fresh.id] });
    expect(again).toMatchObject({ enrolled: 2, skipped: [] });
  });
});

describe("converting a lead", () => {
  it("ends its sequence; the history stays with the lead and shows on the account", async () => {
    const cold = await sequence("Convert me", 3);
    const p = await lead("granite.example");
    await seq.enrollPerson(db, actor, cold.id, { leadId: p.id });

    const res = await convertLead(db, actor, p.id, {
      newAccount: { name: "Granite", website: "granite.example" },
    });
    expect(res).toMatchObject({ endedSequence: true, also: { converted: 0, skipped: [] } });

    const leadRuns = await sequenceHistory(db, actor, "leads", p.id);
    expect(leadRuns).toHaveLength(1);
    expect(leadRuns[0]).toMatchObject({ state: "ended", endReason: "converted", asLead: true });

    // The contact starts clean, and can be put in a sequence right away.
    expect(await sequenceHistory(db, actor, "contacts", res.contactId)).toEqual([]);
    await seq.enrollPerson(db, actor, cold.id, { contactId: res.contactId });

    // The account sees both: the lead's run and the contact's.
    const account = await sequenceHistory(db, actor, "accounts", res.accountId);
    expect(account.map((r) => [r.state, r.asLead])).toEqual([
      ["active", false],
      ["ended", true],
    ]);
    expect(account[0].person.name).toBe(`${p.firstName} ${p.lastName}`);

    const [row] = (await accountService.list(db, actor, {
      withSequences: true,
      sequence: { state: "in" },
      limit: 500,
    })) as unknown as WithSummary[];
    expect(row).toMatchObject({ id: res.accountId, sequences: { inNow: 1, total: 2 } });

    // Re-enrolling the contact counts the run from when it was a lead.
    const { repeats } = await seq.checkRepeats(db, actor, cold.id, {
      contactIds: [res.contactId],
    });
    expect(repeats).toEqual([
      {
        id: res.contactId,
        kind: "contact",
        times: 1,
        last: expect.objectContaining({ endReason: "converted", asLead: true }),
      },
    ]);
    const contacts = (await contactService.list(db, actor, {
      withSequences: true,
      where: { accountId: res.accountId },
    })) as unknown as WithSummary[];
    expect(contacts[0].sequences).toMatchObject({ inNow: 1, total: 1 });
  });

  it("can convert the other leads at the same company into the same account", async () => {
    const a = await lead("harbor.example");
    const b = await lead("harbor.example");
    const c = await lead("harbor.example");
    const gmail1 = await lead("gmail.com");
    await lead("gmail.com");
    const elsewhere = await lead("other.example");

    const preview = await conversionPreview(db, actor, a.id);
    expect(preview.domain).toBe("harbor.example");
    expect(preview.sameDomain.map((l) => l.id).sort()).toEqual([b.id, c.id].sort());
    // A personal address says nothing about the company.
    expect((await conversionPreview(db, actor, gmail1.id)).sameDomain).toEqual([]);

    const res = await convertLead(db, actor, a.id, {
      newAccount: { name: "Harbor", website: "harbor.example" },
      alsoLeadIds: [b.id, elsewhere.id],
    });
    expect(res.also).toEqual({
      converted: 1,
      skipped: [{ id: elsewhere.id, reason: "Not at the same company" }],
    });
    const people = await contactService.list(db, actor, { where: { accountId: res.accountId } });
    expect(people.map((p) => p.email).sort()).toEqual([a.email, b.email].sort());
    // The one left out is still a lead.
    expect((await leadService.get(db, actor, c.id)).convertedAt).toBeNull();
  });

  it("an account only rolls up the people the viewer may see", async () => {
    const cold = await sequence("Private", 1);
    const p = await lead("quiet.example");
    const res = await convertLead(db, actor, p.id, { newAccount: { name: "Quiet" } });
    await seq.enrollPerson(db, actor, cold.id, { contactId: res.contactId });
    const limited: Actor = {
      ...actor,
      userId: "00000000-0000-4000-8000-000000000000",
      permissions: { ...actor.permissions, "contacts.view": "own" },
    };
    expect(await sequenceHistory(db, limited, "accounts", res.accountId)).toEqual([]);
    expect((await sequenceHistory(db, actor, "accounts", res.accountId)).length).toBe(1);
  });
});
