import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Ctx, Db } from "../server/db/types";
import {
  completeTask,
  enroll,
  getDueTasks,
  getTask,
  pauseEnrollment,
  removeStep,
  resumeEnrollment,
  SequenceError,
  setTaskOverride,
  skipTask,
  snoozeTask,
  stopEnrollment,
  stopForPerson,
} from "../server/sequences/engine";
import * as s from "../shared/schema";
import {
  at,
  createContact,
  createLead,
  createOrg,
  createSequence,
  createTestDb,
  createUser,
} from "./helpers";

// 2026-10-05 is a Monday.
const MON = "2026-10-05";

let db: Db;
let ctx: Ctx;

beforeEach(async () => {
  db = await createTestDb();
  ctx = await createOrg(db);
});

const tasksFor = (enrollmentId: string) =>
  db
    .select()
    .from(s.stepTasks)
    .where(eq(s.stepTasks.enrollmentId, enrollmentId))
    .orderBy(s.stepTasks.createdAt);

const enrollmentOf = async (id: string) =>
  (await db.select().from(s.enrollments).where(eq(s.enrollments.id, id)))[0];

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof SequenceError && e.code === code,
  );
}

describe("enrolling", () => {
  it("creates exactly one task, for the first step", async () => {
    const lead = await createLead(db, ctx);
    const { sequence, steps } = await createSequence(db, ctx, [
      { waitDays: 0 },
      { waitDays: 1 },
      { waitDays: 2 },
    ]);
    const { enrollment, task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at(MON),
    });
    const tasks = await tasksFor(enrollment.id);
    expect(tasks).toHaveLength(1);
    expect(task.stepId).toBe(steps[0].id);
    expect(task.dueOn).toBe(MON);
    expect(enrollment.currentStepId).toBe(steps[0].id);
  });

  it("applies the first step's wait from the enrollment date", async () => {
    const lead = await createLead(db, ctx);
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 2 }]);
    const { task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at("2026-10-08"), // Thursday
    });
    expect(task.dueOn).toBe("2026-10-12"); // Monday, business days
  });

  it("refuses a sequence with no steps", async () => {
    const lead = await createLead(db, ctx);
    const { sequence } = await createSequence(db, ctx, []);
    await expectCode(
      enroll(db, ctx, { sequenceId: sequence.id, person: { leadId: lead.id } }),
      "sequence_has_no_steps",
    );
  });

  it("allows only one sequence at a time per person", async () => {
    const lead = await createLead(db, ctx);
    const a = await createSequence(db, ctx, [{ waitDays: 0 }]);
    const b = await createSequence(db, ctx, [{ waitDays: 0 }]);
    const first = await enroll(db, ctx, { sequenceId: a.sequence.id, person: { leadId: lead.id } });
    await expectCode(
      enroll(db, ctx, { sequenceId: b.sequence.id, person: { leadId: lead.id } }),
      "already_enrolled",
    );
    // Paused still counts as enrolled.
    await pauseEnrollment(db, ctx, first.enrollment.id);
    await expectCode(
      enroll(db, ctx, { sequenceId: b.sequence.id, person: { leadId: lead.id } }),
      "already_enrolled",
    );
  });

  it("allows re-enrolling once the previous enrollment has ended", async () => {
    const contact = await createContact(db, ctx);
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }]);
    const first = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { contactId: contact.id },
    });
    await completeTask(db, ctx, first.task.id);
    expect((await enrollmentOf(first.enrollment.id)).state).toBe("ended");
    const second = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { contactId: contact.id },
    });
    expect(second.enrollment.id).not.toBe(first.enrollment.id);
  });

  it("blocks Do Not Contact by status, by email, and by domain", async () => {
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }]);
    const byStatus = await createLead(db, ctx, { status: "Do Not Contact" });
    const byEmail = await createLead(db, ctx, { email: "Blocked@Example.com" });
    const byDomain = await createLead(db, ctx, { email: "anyone@blocked.example" });
    await db.insert(s.doNotContact).values([
      { orgId: ctx.orgId, kind: "email", value: "blocked@example.com" },
      { orgId: ctx.orgId, kind: "domain", value: "blocked.example" },
    ]);
    for (const lead of [byStatus, byEmail, byDomain]) {
      await expectCode(
        enroll(db, ctx, { sequenceId: sequence.id, person: { leadId: lead.id } }),
        "do_not_contact",
      );
    }
  });
});

describe("completing steps", () => {
  it("counts wait days from when the previous step was completed, not when it was due", async () => {
    const lead = await createLead(db, ctx);
    const { sequence, steps } = await createSequence(db, ctx, [{ waitDays: 0 }, { waitDays: 2 }]);
    const { enrollment, task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at(MON),
    });
    // The rep gets to it a week late, on Monday the 12th.
    const { nextTask } = await completeTask(db, ctx, task.id, { now: at("2026-10-12") });
    expect(nextTask?.stepId).toBe(steps[1].id);
    expect(nextTask?.dueOn).toBe("2026-10-14"); // Wednesday: 2 business days after completion
    expect(await tasksFor(enrollment.id)).toHaveLength(2);
    expect((await enrollmentOf(enrollment.id)).currentStepId).toBe(steps[1].id);
  });

  it("uses business days by default and skips the weekend", async () => {
    const lead = await createLead(db, ctx);
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }, { waitDays: 2 }]);
    const { task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at("2026-10-08"),
    });
    const { nextTask } = await completeTask(db, ctx, task.id, { now: at("2026-10-08") }); // Thu
    expect(nextTask?.dueOn).toBe("2026-10-12"); // Mon
  });

  it("uses calendar days when the organization's admin chooses that", async () => {
    const calendarCtx = await createOrg(db, { waitDayMode: "calendar" });
    const lead = await createLead(db, calendarCtx);
    const { sequence } = await createSequence(db, calendarCtx, [{ waitDays: 0 }, { waitDays: 2 }]);
    const { task } = await enroll(db, calendarCtx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at("2026-10-08"),
    });
    const { nextTask } = await completeTask(db, calendarCtx, task.id, { now: at("2026-10-08") });
    expect(nextTask?.dueOn).toBe("2026-10-10"); // Saturday
  });

  it("finishes the enrollment after the last step", async () => {
    const lead = await createLead(db, ctx);
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }, { waitDays: 1 }]);
    const { enrollment, task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at(MON),
    });
    const { nextTask } = await completeTask(db, ctx, task.id, { now: at(MON) });
    const result = await completeTask(db, ctx, nextTask!.id, { now: at("2026-10-06") });
    expect(result.nextTask).toBeNull();
    const ended = await enrollmentOf(enrollment.id);
    expect(ended.state).toBe("ended");
    expect(ended.endReason).toBe("finished");
    expect(ended.currentStepId).toBeNull();
  });

  it("will not complete the same task twice", async () => {
    const lead = await createLead(db, ctx);
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }, { waitDays: 1 }]);
    const { enrollment, task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
    });
    await completeTask(db, ctx, task.id);
    await expectCode(completeTask(db, ctx, task.id), "task_not_open");
    expect(await tasksFor(enrollment.id)).toHaveLength(2);
  });

  it("keeps a skipped task on record and still advances", async () => {
    const lead = await createLead(db, ctx);
    const { sequence, steps } = await createSequence(db, ctx, [{ waitDays: 0 }, { waitDays: 1 }]);
    const { enrollment, task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at(MON),
    });
    const { nextTask } = await skipTask(db, ctx, task.id, { now: at(MON) });
    const tasks = await tasksFor(enrollment.id);
    expect(tasks.map((t) => t.state)).toEqual(["skipped", "open"]);
    expect(nextTask?.stepId).toBe(steps[1].id);
    expect(nextTask?.dueOn).toBe("2026-10-06");
  });

  it("snooze moves the due date and nothing else", async () => {
    const lead = await createLead(db, ctx);
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }, { waitDays: 1 }]);
    const { enrollment, task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at(MON),
    });
    await snoozeTask(db, ctx, task.id, "2026-10-09");
    const tasks = await tasksFor(enrollment.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].dueOn).toBe("2026-10-09");
    expect(tasks[0].state).toBe("open");
    await expectCode(snoozeTask(db, ctx, task.id, "next week"), "invalid_date");
  });

  it("keeps contacts attached through every step", async () => {
    const contact = await createContact(db, ctx, "Phog, Inc.");
    const { sequence } = await createSequence(db, ctx, [
      { waitDays: 0, body: "Hi {firstName} at {company}" },
      { waitDays: 1, body: "Following up, {firstName}" },
    ]);
    const { task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { contactId: contact.id },
      now: at(MON),
    });
    expect((await getTask(db, ctx, task.id)).content.body).toBe("Hi Dan at Phog, Inc.");
    const { nextTask } = await completeTask(db, ctx, task.id, { now: at(MON) });
    const view = await getTask(db, ctx, nextTask!.id);
    expect(view.person.contactId).toBe(contact.id);
    expect(view.person.leadId).toBeNull();
    expect(view.content.body).toBe("Following up, Dan");
  });
});

describe("templates and per-person edits", () => {
  async function setup() {
    const [template] = await db
      .insert(s.templates)
      .values({
        orgId: ctx.orgId,
        ownerId: ctx.userId,
        name: "Intro",
        subject: "Hello {firstName}",
        body: "Original body for {company}",
      })
      .returning();
    const lead = await createLead(db, ctx);
    const { sequence } = await createSequence(db, ctx, [
      { waitDays: 0, templateId: template.id, subject: "ignored", body: "ignored" },
      { waitDays: 1 },
    ]);
    const { task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at(MON),
    });
    return { template, task };
  }

  it("a template edit shows up on tasks that are already open", async () => {
    const { template, task } = await setup();
    expect((await getTask(db, ctx, task.id)).content.body).toBe(
      "Original body for Redfield Energy",
    );
    await db
      .update(s.templates)
      .set({ body: "Updated body for {company}" })
      .where(eq(s.templates.id, template.id));
    expect((await getTask(db, ctx, task.id)).content.body).toBe("Updated body for Redfield Energy");
  });

  it("the rep's edit for one person wins over the template", async () => {
    const { task } = await setup();
    await setTaskOverride(db, ctx, task.id, { body: "Saw your note, {firstName}." });
    const view = await getTask(db, ctx, task.id);
    expect(view.content.body).toBe("Saw your note, Jill.");
    expect(view.content.subject).toBe("Hello Jill"); // subject still from the template
    expect(view.content.edited).toBe(true);
    // Clearing the edit goes back to the template.
    await setTaskOverride(db, ctx, task.id, { body: null });
    expect((await getTask(db, ctx, task.id)).content.edited).toBe(false);
  });

  it("saves what was sent, so later template edits do not rewrite history", async () => {
    const { template, task } = await setup();
    await completeTask(db, ctx, task.id, { now: at(MON), note: "Sent from Outlook" });
    await db
      .update(s.templates)
      .set({ subject: "Changed", body: "Changed" })
      .where(eq(s.templates.id, template.id));
    const [saved] = await db.select().from(s.stepTasks).where(eq(s.stepTasks.id, task.id));
    expect(saved.finalSubject).toBe("Hello Jill");
    expect(saved.finalBody).toBe("Original body for Redfield Energy");
    expect(saved.note).toBe("Sent from Outlook");
    expect(saved.closedBy).toBe(ctx.userId);
  });
});

describe("editing a sequence while people are enrolled", () => {
  it("never rebuilds tasks: a new step is picked up at the next advance", async () => {
    const lead = await createLead(db, ctx);
    const { sequence, steps } = await createSequence(db, ctx, [{ waitDays: 0 }, { waitDays: 1 }]);
    const { enrollment, task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at(MON),
    });
    // Insert a new step between the two existing ones.
    await db
      .update(s.sequenceSteps)
      .set({ position: 3 })
      .where(eq(s.sequenceSteps.id, steps[1].id));
    const [inserted] = await db
      .insert(s.sequenceSteps)
      .values({
        orgId: ctx.orgId,
        sequenceId: sequence.id,
        position: 2,
        type: "phone_call",
        title: "New call step",
        waitDays: 1,
      })
      .returning();
    expect(await tasksFor(enrollment.id)).toHaveLength(1); // untouched

    const { nextTask } = await completeTask(db, ctx, task.id, { now: at(MON) });
    expect(nextTask?.stepId).toBe(inserted.id);
  });

  it("does not repeat a step that was already done after a reorder", async () => {
    const lead = await createLead(db, ctx);
    const { sequence, steps } = await createSequence(db, ctx, [
      { waitDays: 0 },
      { waitDays: 0 },
      { waitDays: 0 },
    ]);
    const { task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at(MON),
    });
    const second = await completeTask(db, ctx, task.id, { now: at(MON) });
    // Move step 1 to the end: new order is 2, 3, 1.
    await db.update(s.sequenceSteps).set({ position: 1 }).where(eq(s.sequenceSteps.id, steps[1].id));
    await db.update(s.sequenceSteps).set({ position: 2 }).where(eq(s.sequenceSteps.id, steps[2].id));
    await db.update(s.sequenceSteps).set({ position: 3 }).where(eq(s.sequenceSteps.id, steps[0].id));

    const third = await completeTask(db, ctx, second.nextTask!.id, { now: at(MON) });
    expect(third.nextTask?.stepId).toBe(steps[2].id);
    const last = await completeTask(db, ctx, third.nextTask!.id, { now: at(MON) });
    expect(last.nextTask).toBeNull(); // step 1 is not sent a second time
  });

  it("moves people on when the step they are waiting on is removed", async () => {
    const lead = await createLead(db, ctx);
    const { sequence, steps } = await createSequence(db, ctx, [
      { waitDays: 0 },
      { waitDays: 3 },
      { waitDays: 1 },
    ]);
    const { enrollment, task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at(MON),
    });
    await removeStep(db, ctx, steps[0].id, { now: at("2026-10-06") });
    const tasks = await tasksFor(enrollment.id);
    expect(tasks.find((t) => t.id === task.id)?.state).toBe("cancelled");
    const open = tasks.filter((t) => t.state === "open");
    expect(open).toHaveLength(1);
    expect(open[0].stepId).toBe(steps[1].id);
    expect(open[0].dueOn).toBe("2026-10-09"); // 3 business days from the removal
  });

  it("finishes the enrollment when the removed step was the last one", async () => {
    const lead = await createLead(db, ctx);
    const { sequence, steps } = await createSequence(db, ctx, [{ waitDays: 0 }]);
    const { enrollment } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
    });
    await removeStep(db, ctx, steps[0].id);
    expect((await enrollmentOf(enrollment.id)).endReason).toBe("finished");
  });
});

describe("pausing and stopping", () => {
  it("hides a paused person's task, and resume makes it due today", async () => {
    const lead = await createLead(db, ctx);
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }, { waitDays: 1 }]);
    const { enrollment, task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at(MON),
    });
    await pauseEnrollment(db, ctx, enrollment.id, { now: at(MON) });
    expect(await getDueTasks(db, ctx, { now: at("2026-10-07") })).toHaveLength(0);
    await expectCode(completeTask(db, ctx, task.id), "enrollment_not_active");

    await resumeEnrollment(db, ctx, enrollment.id, { now: at("2026-10-14") });
    const due = await getDueTasks(db, ctx, { now: at("2026-10-14") });
    expect(due).toHaveLength(1);
    expect(due[0].dueOn).toBe("2026-10-14");
    expect(await tasksFor(enrollment.id)).toHaveLength(1);
  });

  it("stopping cancels the open task and records why", async () => {
    const lead = await createLead(db, ctx);
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }, { waitDays: 1 }]);
    const { enrollment, task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
    });
    await stopEnrollment(db, ctx, enrollment.id, "replied");
    const ended = await enrollmentOf(enrollment.id);
    expect(ended.state).toBe("ended");
    expect(ended.endReason).toBe("replied");
    expect((await tasksFor(enrollment.id))[0].state).toBe("cancelled");
    await expectCode(completeTask(db, ctx, task.id), "task_not_open");
    await expectCode(stopEnrollment(db, ctx, enrollment.id, "removed"), "enrollment_ended");
  });

  it("stops whatever sequence a person is in when their status changes", async () => {
    const contact = await createContact(db, ctx);
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }]);
    const { enrollment } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { contactId: contact.id },
    });
    expect(await stopForPerson(db, ctx, { contactId: contact.id }, "status_change")).toBe(true);
    expect((await enrollmentOf(enrollment.id)).endReason).toBe("status_change");
    expect(await stopForPerson(db, ctx, { contactId: contact.id }, "status_change")).toBe(false);
  });
});

describe("the Run Steps queue", () => {
  it("shows only tasks that are due, and can be filtered by owner", async () => {
    const otherRep = await createUser(db, "Other Rep");
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }, { waitDays: 3 }]);
    const mine = await createLead(db, ctx);
    const theirs = await createLead(db, ctx);
    const later = await createLead(db, ctx);
    await enroll(db, ctx, { sequenceId: sequence.id, person: { leadId: mine.id }, now: at(MON) });
    await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: theirs.id },
      ownerId: otherRep,
      now: at(MON),
    });
    const future = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: later.id },
      now: at(MON),
    });
    await completeTask(db, ctx, future.task.id, { now: at(MON) }); // next due Thursday

    expect(await getDueTasks(db, ctx, { now: at(MON) })).toHaveLength(2);
    const onlyMine = await getDueTasks(db, ctx, { now: at(MON), ownerId: ctx.userId });
    expect(onlyMine.map((t) => t.person.leadId)).toEqual([mine.id]);
    expect(await getDueTasks(db, ctx, { now: at("2026-10-08") })).toHaveLength(3);
  });

  it("stays overdue until done: nothing is due later just because time passed", async () => {
    const lead = await createLead(db, ctx);
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }, { waitDays: 1 }]);
    const { enrollment } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at(MON),
    });
    const due = await getDueTasks(db, ctx, { now: at("2026-10-19") });
    expect(due).toHaveLength(1);
    expect(due[0].dueOn).toBe(MON);
    expect(await tasksFor(enrollment.id)).toHaveLength(1);
  });
});

describe("organizations are isolated", () => {
  it("one organization cannot see or act on another's sequences", async () => {
    const other = await createOrg(db);
    const lead = await createLead(db, ctx);
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }]);
    const { enrollment, task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
      now: at(MON),
    });

    expect(await getDueTasks(db, other, { now: at(MON) })).toHaveLength(0);
    await expectCode(getTask(db, other, task.id), "task_not_found");
    await expectCode(completeTask(db, other, task.id), "task_not_found");
    await expectCode(stopEnrollment(db, other, enrollment.id, "removed"), "enrollment_not_found");
    await expectCode(
      enroll(db, other, { sequenceId: sequence.id, person: { leadId: lead.id } }),
      "sequence_not_found",
    );
    const otherLead = await createLead(db, other);
    await expectCode(
      enroll(db, ctx, { sequenceId: sequence.id, person: { leadId: otherLead.id } }),
      "person_not_found",
    );
  });
});

describe("the database itself enforces the rules", () => {
  it("rejects a second open task for the same enrollment", async () => {
    const lead = await createLead(db, ctx);
    const { sequence, steps } = await createSequence(db, ctx, [{ waitDays: 0 }, { waitDays: 0 }]);
    const { enrollment } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
    });
    await expect(
      db.insert(s.stepTasks).values({
        orgId: ctx.orgId,
        enrollmentId: enrollment.id,
        stepId: steps[1].id,
        ownerId: ctx.userId,
        dueOn: MON,
      }),
    ).rejects.toThrow();
  });

  it("records an event for each thing that happens", async () => {
    const lead = await createLead(db, ctx);
    const { sequence } = await createSequence(db, ctx, [{ waitDays: 0 }]);
    const { enrollment, task } = await enroll(db, ctx, {
      sequenceId: sequence.id,
      person: { leadId: lead.id },
    });
    await completeTask(db, ctx, task.id);
    const log = await db
      .select()
      .from(s.events)
      .where(and(eq(s.events.orgId, ctx.orgId), eq(s.events.enrollmentId, enrollment.id)));
    expect(log.map((e) => e.type).sort()).toEqual([
      "enrollment.ended",
      "enrollment.started",
      "step.completed",
    ]);
  });
});
