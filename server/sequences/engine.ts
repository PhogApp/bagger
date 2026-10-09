import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import {
  accounts,
  contacts,
  doNotContact,
  enrollments,
  events,
  leads,
  orgSettings,
  sequenceSteps,
  sequences,
  stepTasks,
  templates,
} from "../../shared/schema";
import type { Ctx, Db } from "../db/types";
import { resolveContent, type MergePerson, type ResolvedContent } from "./content";
import { addWaitDays, localDate, type WaitDayMode } from "./dates";

/**
 * The sequence engine.
 *
 * Rules (see the build spec, section 5):
 *  - An enrollment has at most one open task. Later steps are not created
 *    ahead of time.
 *  - The first task is due at enrollment + the first step's wait. Each later
 *    task is due at the previous task's completion + that step's wait.
 *  - Editing a sequence never rebuilds tasks. Each enrollment reads the
 *    current step order when it next advances.
 *  - Every state change happens inside one database transaction.
 */

export type SequenceErrorCode =
  | "sequence_not_found"
  | "sequence_inactive"
  | "sequence_has_no_steps"
  | "person_not_found"
  | "person_converted"
  | "do_not_contact"
  | "already_enrolled"
  | "task_not_found"
  | "task_not_open"
  | "enrollment_not_found"
  | "enrollment_not_active"
  | "enrollment_not_paused"
  | "enrollment_ended"
  | "step_not_found"
  | "invalid_date";

export class SequenceError extends Error {
  constructor(
    public readonly code: SequenceErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SequenceError";
  }
}

export type PersonRef = { leadId: string } | { contactId: string };
export type EndReason =
  | "finished"
  | "replied"
  | "meeting_booked"
  | "opted_out"
  | "bounced"
  | "status_change"
  | "removed";

type Enrollment = typeof enrollments.$inferSelect;
type StepTask = typeof stepTasks.$inferSelect;
type Step = typeof sequenceSteps.$inferSelect;

interface Clock {
  /** Overridable so tests can control "now". */
  now?: Date;
}

// ------------------------------------------------------------- helpers

async function loadSettings(tx: Db, orgId: string): Promise<{ mode: WaitDayMode; tz: string }> {
  const [row] = await tx.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
  return { mode: row?.waitDayMode ?? "business", tz: row?.timezone ?? "America/Chicago" };
}

interface Person extends MergePerson {
  status: string;
  ownerId: string;
}

async function loadPerson(tx: Db, ctx: Ctx, ref: PersonRef): Promise<Person> {
  if ("leadId" in ref) {
    const [lead] = await tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, ref.leadId), eq(leads.orgId, ctx.orgId), isNull(leads.deletedAt)));
    if (!lead) throw new SequenceError("person_not_found");
    if (lead.convertedContactId) throw new SequenceError("person_converted");
    return lead;
  }
  const [row] = await tx
    .select({ contact: contacts, accountName: accounts.name })
    .from(contacts)
    .innerJoin(accounts, eq(contacts.accountId, accounts.id))
    .where(
      and(
        eq(contacts.id, ref.contactId),
        eq(contacts.orgId, ctx.orgId),
        isNull(contacts.deletedAt),
      ),
    );
  if (!row) throw new SequenceError("person_not_found");
  return { ...row.contact, company: row.accountName };
}

async function isDoNotContact(tx: Db, ctx: Ctx, person: Person): Promise<boolean> {
  if (person.status === "Do Not Contact") return true;
  const email = person.email.trim().toLowerCase();
  const domain = email.split("@")[1] ?? "";
  const [hit] = await tx
    .select({ id: doNotContact.id })
    .from(doNotContact)
    .where(
      and(
        eq(doNotContact.orgId, ctx.orgId),
        or(
          and(eq(doNotContact.kind, "email"), eq(doNotContact.value, email)),
          and(eq(doNotContact.kind, "domain"), eq(doNotContact.value, domain)),
        ),
      ),
    )
    .limit(1);
  return Boolean(hit);
}

function liveSteps(tx: Db, sequenceId: string): Promise<Step[]> {
  return tx
    .select()
    .from(sequenceSteps)
    .where(and(eq(sequenceSteps.sequenceId, sequenceId), isNull(sequenceSteps.deletedAt)))
    .orderBy(asc(sequenceSteps.position), asc(sequenceSteps.createdAt));
}

async function logEvent(
  tx: Db,
  ctx: Ctx,
  type: string,
  e: Pick<Enrollment, "id" | "sequenceId" | "leadId" | "contactId">,
  extra: { stepId?: string; data?: Record<string, unknown>; at?: Date } = {},
): Promise<void> {
  await tx.insert(events).values({
    orgId: ctx.orgId,
    type,
    actorId: ctx.userId,
    enrollmentId: e.id,
    sequenceId: e.sequenceId,
    leadId: e.leadId,
    contactId: e.contactId,
    stepId: extra.stepId,
    data: extra.data,
    occurredAt: extra.at ?? new Date(),
  });
}

async function lockEnrollment(tx: Db, ctx: Ctx, enrollmentId: string): Promise<Enrollment> {
  const [row] = await tx
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.orgId, ctx.orgId)))
    .for("update");
  if (!row) throw new SequenceError("enrollment_not_found");
  return row;
}

async function lockTask(tx: Db, ctx: Ctx, taskId: string): Promise<StepTask> {
  const [row] = await tx
    .select()
    .from(stepTasks)
    .where(and(eq(stepTasks.id, taskId), eq(stepTasks.orgId, ctx.orgId)))
    .for("update");
  if (!row) throw new SequenceError("task_not_found");
  return row;
}

async function endEnrollment(
  tx: Db,
  ctx: Ctx,
  enrollment: Enrollment,
  reason: EndReason,
  at: Date,
): Promise<void> {
  await tx
    .update(enrollments)
    .set({ state: "ended", endReason: reason, endedAt: at, currentStepId: null })
    .where(eq(enrollments.id, enrollment.id));
  await logEvent(tx, ctx, "enrollment.ended", enrollment, { data: { reason }, at });
}

/**
 * Move an enrollment past `fromStepId`: create the task for the next step
 * that has not been done yet, or finish the enrollment if there is none.
 */
async function advance(
  tx: Db,
  ctx: Ctx,
  enrollment: Enrollment,
  fromStepId: string,
  at: Date,
): Promise<StepTask | null> {
  const { mode, tz } = await loadSettings(tx, ctx.orgId);
  // Includes soft-deleted steps: we still need the position of a removed one.
  const [from] = await tx.select().from(sequenceSteps).where(eq(sequenceSteps.id, fromStepId));
  if (!from) throw new SequenceError("step_not_found");

  const steps = await liveSteps(tx, enrollment.sequenceId);
  const done = await tx
    .select({ stepId: stepTasks.stepId })
    .from(stepTasks)
    .where(eq(stepTasks.enrollmentId, enrollment.id));
  const doneIds = new Set(done.map((d) => d.stepId));
  const next = steps.find((s) => s.position > from.position && !doneIds.has(s.id));

  if (!next) {
    await endEnrollment(tx, ctx, enrollment, "finished", at);
    return null;
  }

  const [task] = await tx
    .insert(stepTasks)
    .values({
      orgId: ctx.orgId,
      enrollmentId: enrollment.id,
      stepId: next.id,
      ownerId: enrollment.ownerId,
      dueOn: addWaitDays(localDate(at, tz), next.waitDays, mode),
    })
    .returning();
  await tx
    .update(enrollments)
    .set({ currentStepId: next.id })
    .where(eq(enrollments.id, enrollment.id));
  return task;
}

// ---------------------------------------------------------- enrollment

export interface EnrollInput extends Clock {
  sequenceId: string;
  person: PersonRef;
  /** Who will work the tasks. Defaults to the acting user. */
  ownerId?: string;
}

export async function enroll(
  db: Db,
  ctx: Ctx,
  input: EnrollInput,
): Promise<{ enrollment: Enrollment; task: StepTask }> {
  const at = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [sequence] = await tx
      .select()
      .from(sequences)
      .where(
        and(
          eq(sequences.id, input.sequenceId),
          eq(sequences.orgId, ctx.orgId),
          isNull(sequences.deletedAt),
        ),
      );
    if (!sequence) throw new SequenceError("sequence_not_found");
    if (!sequence.isActive) throw new SequenceError("sequence_inactive");

    const person = await loadPerson(tx, ctx, input.person);
    if (await isDoNotContact(tx, ctx, person)) throw new SequenceError("do_not_contact");

    const personFilter =
      "leadId" in input.person
        ? eq(enrollments.leadId, input.person.leadId)
        : eq(enrollments.contactId, input.person.contactId);
    const [live] = await tx
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(and(personFilter, inArray(enrollments.state, ["active", "paused"])))
      .limit(1);
    if (live) throw new SequenceError("already_enrolled");

    const steps = await liveSteps(tx, sequence.id);
    if (steps.length === 0) throw new SequenceError("sequence_has_no_steps");
    const first = steps[0];

    const { mode, tz } = await loadSettings(tx, ctx.orgId);
    const ownerId = input.ownerId ?? ctx.userId;

    const [enrollment] = await tx
      .insert(enrollments)
      .values({
        orgId: ctx.orgId,
        sequenceId: sequence.id,
        leadId: "leadId" in input.person ? input.person.leadId : null,
        contactId: "contactId" in input.person ? input.person.contactId : null,
        ownerId,
        currentStepId: first.id,
        enrolledAt: at,
      })
      .returning();

    const [task] = await tx
      .insert(stepTasks)
      .values({
        orgId: ctx.orgId,
        enrollmentId: enrollment.id,
        stepId: first.id,
        ownerId,
        dueOn: addWaitDays(localDate(at, tz), first.waitDays, mode),
      })
      .returning();

    await logEvent(tx, ctx, "enrollment.started", enrollment, { at });
    return { enrollment, task };
  });
}

// --------------------------------------------------------------- tasks

export interface CloseTaskInput extends Clock {
  note?: string;
}

async function closeTask(
  db: Db,
  ctx: Ctx,
  taskId: string,
  outcome: "completed" | "skipped",
  input: CloseTaskInput,
): Promise<{ nextTask: StepTask | null }> {
  const at = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, ctx, taskId);
    if (task.state !== "open") throw new SequenceError("task_not_open");
    const enrollment = await lockEnrollment(tx, ctx, task.enrollmentId);
    if (enrollment.state !== "active") throw new SequenceError("enrollment_not_active");

    // Save what was actually used, so history survives later template edits.
    const content =
      outcome === "completed" ? (await loadTaskViews(tx, ctx, { taskId }))[0]?.content : undefined;

    await tx
      .update(stepTasks)
      .set({
        state: outcome,
        closedAt: at,
        closedBy: ctx.userId,
        note: input.note ?? task.note,
        finalSubject: content?.subject ?? null,
        finalBody: content?.body ?? null,
      })
      .where(eq(stepTasks.id, task.id));
    await logEvent(tx, ctx, `step.${outcome}`, enrollment, { stepId: task.stepId, at });

    const nextTask = await advance(tx, ctx, enrollment, task.stepId, at);
    return { nextTask };
  });
}

export function completeTask(db: Db, ctx: Ctx, taskId: string, input: CloseTaskInput = {}) {
  return closeTask(db, ctx, taskId, "completed", input);
}

/** Skipped tasks are kept (not deleted) so reports can count them. */
export function skipTask(db: Db, ctx: Ctx, taskId: string, input: CloseTaskInput = {}) {
  return closeTask(db, ctx, taskId, "skipped", input);
}

/** Move the due date and nothing else. */
export async function snoozeTask(db: Db, ctx: Ctx, taskId: string, dueOn: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn) || Number.isNaN(Date.parse(dueOn))) {
    throw new SequenceError("invalid_date");
  }
  await db.transaction(async (tx) => {
    const task = await lockTask(tx, ctx, taskId);
    if (task.state !== "open") throw new SequenceError("task_not_open");
    await tx.update(stepTasks).set({ dueOn }).where(eq(stepTasks.id, task.id));
  });
}

/**
 * The rep's edit for this one person. Pass null to go back to the template.
 */
export async function setTaskOverride(
  db: Db,
  ctx: Ctx,
  taskId: string,
  override: { subject?: string | null; body?: string | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    const task = await lockTask(tx, ctx, taskId);
    if (task.state !== "open") throw new SequenceError("task_not_open");
    await tx
      .update(stepTasks)
      .set({
        overrideSubject: override.subject === undefined ? task.overrideSubject : override.subject,
        overrideBody: override.body === undefined ? task.overrideBody : override.body,
      })
      .where(eq(stepTasks.id, task.id));
  });
}

// ------------------------------------------------- pause, resume, stop

export async function pauseEnrollment(
  db: Db,
  ctx: Ctx,
  enrollmentId: string,
  clock: Clock = {},
): Promise<void> {
  const at = clock.now ?? new Date();
  await db.transaction(async (tx) => {
    const enrollment = await lockEnrollment(tx, ctx, enrollmentId);
    if (enrollment.state !== "active") throw new SequenceError("enrollment_not_active");
    await tx
      .update(enrollments)
      .set({ state: "paused", pausedAt: at })
      .where(eq(enrollments.id, enrollment.id));
    await logEvent(tx, ctx, "enrollment.paused", enrollment, { at });
  });
}

/** Resuming makes the open task due today. */
export async function resumeEnrollment(
  db: Db,
  ctx: Ctx,
  enrollmentId: string,
  clock: Clock = {},
): Promise<void> {
  const at = clock.now ?? new Date();
  await db.transaction(async (tx) => {
    const enrollment = await lockEnrollment(tx, ctx, enrollmentId);
    if (enrollment.state !== "paused") throw new SequenceError("enrollment_not_paused");
    const { mode, tz } = await loadSettings(tx, ctx.orgId);
    await tx
      .update(enrollments)
      .set({ state: "active", pausedAt: null })
      .where(eq(enrollments.id, enrollment.id));
    await tx
      .update(stepTasks)
      .set({ dueOn: addWaitDays(localDate(at, tz), 0, mode) })
      .where(and(eq(stepTasks.enrollmentId, enrollment.id), eq(stepTasks.state, "open")));
    await logEvent(tx, ctx, "enrollment.resumed", enrollment, { at });
  });
}

async function stopLocked(
  tx: Db,
  ctx: Ctx,
  enrollment: Enrollment,
  reason: EndReason,
  at: Date,
): Promise<void> {
  await tx
    .update(stepTasks)
    .set({ state: "cancelled", closedAt: at, closedBy: ctx.userId })
    .where(and(eq(stepTasks.enrollmentId, enrollment.id), eq(stepTasks.state, "open")));
  await endEnrollment(tx, ctx, enrollment, reason, at);
}

/** End an enrollment early: reply, meeting booked, opt-out, manual removal. */
export async function stopEnrollment(
  db: Db,
  ctx: Ctx,
  enrollmentId: string,
  reason: Exclude<EndReason, "finished">,
  clock: Clock = {},
): Promise<void> {
  const at = clock.now ?? new Date();
  await db.transaction(async (tx) => {
    const enrollment = await lockEnrollment(tx, ctx, enrollmentId);
    if (enrollment.state === "ended") throw new SequenceError("enrollment_ended");
    await stopLocked(tx, ctx, enrollment, reason, at);
  });
}

/**
 * End whatever sequence a person is in. Call this when their status becomes
 * "Not Interested" or "Do Not Contact". Returns true if one was stopped.
 */
export async function stopForPerson(
  db: Db,
  ctx: Ctx,
  person: PersonRef,
  reason: Exclude<EndReason, "finished">,
  clock: Clock = {},
): Promise<boolean> {
  const at = clock.now ?? new Date();
  return db.transaction(async (tx) => {
    const personFilter =
      "leadId" in person
        ? eq(enrollments.leadId, person.leadId)
        : eq(enrollments.contactId, person.contactId);
    const [enrollment] = await tx
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.orgId, ctx.orgId),
          personFilter,
          inArray(enrollments.state, ["active", "paused"]),
        ),
      )
      .for("update");
    if (!enrollment) return false;
    await stopLocked(tx, ctx, enrollment, reason, at);
    return true;
  });
}

// ------------------------------------------------------- step removal

/**
 * Remove a step from a sequence. Anyone currently waiting on that step moves
 * to the next one (due from today), or finishes if it was the last.
 */
export async function removeStep(
  db: Db,
  ctx: Ctx,
  stepId: string,
  clock: Clock = {},
): Promise<void> {
  const at = clock.now ?? new Date();
  await db.transaction(async (tx) => {
    const [step] = await tx
      .select()
      .from(sequenceSteps)
      .where(
        and(
          eq(sequenceSteps.id, stepId),
          eq(sequenceSteps.orgId, ctx.orgId),
          isNull(sequenceSteps.deletedAt),
        ),
      )
      .for("update");
    if (!step) throw new SequenceError("step_not_found");
    await tx.update(sequenceSteps).set({ deletedAt: at }).where(eq(sequenceSteps.id, step.id));

    const waiting = await tx
      .select()
      .from(stepTasks)
      .where(and(eq(stepTasks.stepId, step.id), eq(stepTasks.state, "open")))
      .for("update");
    for (const task of waiting) {
      const enrollment = await lockEnrollment(tx, ctx, task.enrollmentId);
      await tx
        .update(stepTasks)
        .set({ state: "cancelled", closedAt: at, closedBy: ctx.userId })
        .where(eq(stepTasks.id, task.id));
      await advance(tx, ctx, enrollment, step.id, at);
    }
  });
}

// ---------------------------------------------------- reading the queue

export interface TaskView {
  taskId: string;
  enrollmentId: string;
  sequenceId: string;
  sequenceName: string;
  ownerId: string;
  dueOn: string;
  state: StepTask["state"];
  step: { id: string; type: Step["type"]; title: string; position: number };
  person: MergePerson & { leadId: string | null; contactId: string | null };
  callScript: string | null;
  callObjectives: string | null;
  content: ResolvedContent;
}

async function loadTaskViews(
  tx: Db,
  ctx: Ctx,
  filter: { taskId?: string; ownerId?: string; dueOnOrBefore?: string },
): Promise<TaskView[]> {
  const where = [eq(stepTasks.orgId, ctx.orgId)];
  if (filter.taskId) where.push(eq(stepTasks.id, filter.taskId));
  if (filter.ownerId) where.push(eq(stepTasks.ownerId, filter.ownerId));
  if (filter.dueOnOrBefore) {
    where.push(
      eq(stepTasks.state, "open"),
      eq(enrollments.state, "active"),
      lte(stepTasks.dueOn, filter.dueOnOrBefore),
    );
  }

  const rows = await tx
    .select({
      task: stepTasks,
      enrollment: enrollments,
      step: sequenceSteps,
      sequenceName: sequences.name,
      template: templates,
      lead: leads,
      contact: contacts,
      accountName: accounts.name,
    })
    .from(stepTasks)
    .innerJoin(enrollments, eq(stepTasks.enrollmentId, enrollments.id))
    .innerJoin(sequenceSteps, eq(stepTasks.stepId, sequenceSteps.id))
    .innerJoin(sequences, eq(enrollments.sequenceId, sequences.id))
    .leftJoin(
      templates,
      and(eq(sequenceSteps.templateId, templates.id), isNull(templates.deletedAt)),
    )
    .leftJoin(leads, eq(enrollments.leadId, leads.id))
    .leftJoin(contacts, eq(enrollments.contactId, contacts.id))
    .leftJoin(accounts, eq(contacts.accountId, accounts.id))
    .where(and(...where))
    .orderBy(asc(stepTasks.dueOn), asc(stepTasks.createdAt));

  return rows.map((r) => {
    const source = r.lead ?? r.contact;
    if (!source) throw new SequenceError("person_not_found");
    const person: MergePerson = {
      firstName: source.firstName,
      lastName: source.lastName,
      email: source.email,
      title: source.title,
      company: r.lead ? r.lead.company : r.accountName,
    };
    return {
      taskId: r.task.id,
      enrollmentId: r.enrollment.id,
      sequenceId: r.enrollment.sequenceId,
      sequenceName: r.sequenceName,
      ownerId: r.task.ownerId,
      dueOn: r.task.dueOn,
      state: r.task.state,
      step: {
        id: r.step.id,
        type: r.step.type,
        title: r.step.title,
        position: r.step.position,
      },
      person: {
        ...person,
        leadId: r.enrollment.leadId,
        contactId: r.enrollment.contactId,
      },
      callScript: r.step.callScript,
      callObjectives: r.step.callObjectives,
      content: resolveContent(
        {
          task: r.task,
          step: r.step,
          template: r.template,
        },
        person,
      ),
    };
  });
}

/**
 * The Run Steps queue: open tasks due today or earlier, for active
 * enrollments. Nothing is scheduled; a task is due when its date has passed.
 */
export async function getDueTasks(
  db: Db,
  ctx: Ctx,
  options: Clock & { ownerId?: string } = {},
): Promise<TaskView[]> {
  const { tz } = await loadSettings(db, ctx.orgId);
  return loadTaskViews(db, ctx, {
    ownerId: options.ownerId,
    dueOnOrBefore: localDate(options.now ?? new Date(), tz),
  });
}

export async function getTask(db: Db, ctx: Ctx, taskId: string): Promise<TaskView> {
  const [view] = await loadTaskViews(db, ctx, { taskId });
  if (!view) throw new SequenceError("task_not_found");
  return view;
}
