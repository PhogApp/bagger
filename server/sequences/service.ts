import { and, asc, desc, eq, isNull, max } from "drizzle-orm";
import { z } from "zod";
import {
  contacts,
  enrollments,
  leads,
  sequenceSteps,
  sequences,
  stepTasks,
  stepTypeEnum,
  templates,
} from "../../shared/schema";
import { diffFields, recordLifecycle, recordUpdate } from "../audit/history";
import { isMember, type Actor } from "../auth/actor";
import {
  canUse,
  PermissionError,
  requireRecord,
  requireTool,
  scopeFor,
} from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";
import * as engine from "./engine";

/**
 * Permission-checked operations on sequences. The engine (engine.ts) knows
 * the rules of how sequences run; this file decides who may ask it to.
 */

const optionalText = z
  .string()
  .transform((v) => (v.trim() === "" ? null : v))
  .nullable()
  .optional();

export const stepInput = z.object({
  type: z.enum(stepTypeEnum.enumValues),
  title: z.string().trim().min(1),
  waitDays: z.number().int().min(0).max(365).default(0),
  templateId: z.uuid().nullable().optional(),
  subject: optionalText,
  body: optionalText,
  callScript: optionalText,
  callObjectives: optionalText,
});

type Step = typeof sequenceSteps.$inferSelect;

const TEMPLATE_TYPE_FOR_STEP: Record<Step["type"], "email" | "linkedin" | null> = {
  email: "email",
  linkedin_connect: "linkedin",
  linkedin_message: "linkedin",
  phone_call: null,
};

async function loadSequence(tx: Db, actor: Actor, sequenceId: string, forUpdate = false) {
  const query = tx
    .select()
    .from(sequences)
    .where(
      and(
        eq(sequences.id, sequenceId),
        eq(sequences.orgId, actor.orgId),
        isNull(sequences.deletedAt),
      ),
    );
  const [sequence] = forUpdate ? await query.for("update") : await query;
  if (!sequence) throw new NotFoundError("sequence");
  return sequence;
}

async function checkTemplate(
  tx: Db,
  actor: Actor,
  type: Step["type"],
  templateId: string | null | undefined,
) {
  if (!templateId) return;
  const [template] = await tx
    .select({ type: templates.type })
    .from(templates)
    .where(
      and(
        eq(templates.id, templateId),
        eq(templates.orgId, actor.orgId),
        isNull(templates.deletedAt),
      ),
    );
  if (!template) throw new ValidationError("Template not found");
  if (template.type !== TEMPLATE_TYPE_FOR_STEP[type]) {
    throw new ValidationError(`A ${type} step cannot use a ${template.type} template`);
  }
}

// --------------------------------------------------------------- steps

export async function listSteps(db: Db, actor: Actor, sequenceId: string): Promise<Step[]> {
  const sequence = await loadSequence(db, actor, sequenceId);
  requireRecord(actor.permissions, "sequences", "view", sequence, actor.userId);
  return db
    .select()
    .from(sequenceSteps)
    .where(and(eq(sequenceSteps.sequenceId, sequenceId), isNull(sequenceSteps.deletedAt)))
    .orderBy(asc(sequenceSteps.position), asc(sequenceSteps.createdAt));
}

/** New steps go on the end. Use reorderSteps to move them. */
export async function addStep(
  db: Db,
  actor: Actor,
  sequenceId: string,
  raw: unknown,
): Promise<Step> {
  const values = stepInput.parse(raw);
  return db.transaction(async (tx) => {
    const sequence = await loadSequence(tx, actor, sequenceId, true);
    requireRecord(actor.permissions, "sequences", "edit", sequence, actor.userId);
    await checkTemplate(tx, actor, values.type, values.templateId);
    const [{ last }] = await tx
      .select({ last: max(sequenceSteps.position) })
      .from(sequenceSteps)
      .where(and(eq(sequenceSteps.sequenceId, sequenceId), isNull(sequenceSteps.deletedAt)));
    const [step] = await tx
      .insert(sequenceSteps)
      .values({ ...values, orgId: actor.orgId, sequenceId, position: (last ?? 0) + 1 })
      .returning();
    await recordLifecycle(tx, actor, "sequence_step", step.id, "create");
    return step;
  });
}

async function loadStepForEdit(tx: Db, actor: Actor, stepId: string): Promise<Step> {
  const [step] = await tx
    .select()
    .from(sequenceSteps)
    .where(
      and(
        eq(sequenceSteps.id, stepId),
        eq(sequenceSteps.orgId, actor.orgId),
        isNull(sequenceSteps.deletedAt),
      ),
    )
    .for("update");
  if (!step) throw new NotFoundError("step");
  const sequence = await loadSequence(tx, actor, step.sequenceId);
  requireRecord(actor.permissions, "sequences", "edit", sequence, actor.userId);
  return step;
}

/**
 * Changing a step never touches existing tasks. Open tasks read the step and
 * its template live, so content edits show up immediately; a new wait applies
 * to tasks created from now on.
 */
export async function updateStep(db: Db, actor: Actor, stepId: string, raw: unknown) {
  // No defaults on update: only the fields that were sent may change.
  const patch = stepInput.partial().omit({ waitDays: true }).parse(raw);
  const waitDays = z
    .object({ waitDays: z.number().int().min(0).max(365).optional() })
    .parse(raw).waitDays;
  const full = waitDays === undefined ? patch : { ...patch, waitDays };

  return db.transaction(async (tx) => {
    const before = await loadStepForEdit(tx, actor, stepId);
    const changes = diffFields(before, full);
    if (changes.length === 0) return before;
    const nextType = full.type ?? before.type;
    const nextTemplate = full.templateId === undefined ? before.templateId : full.templateId;
    await checkTemplate(tx, actor, nextType, nextTemplate);
    const [after] = await tx
      .update(sequenceSteps)
      .set({ ...full, updatedAt: new Date() })
      .where(eq(sequenceSteps.id, stepId))
      .returning();
    await recordUpdate(tx, actor, "sequence_step", stepId, changes);
    return after;
  });
}

export async function deleteStep(db: Db, actor: Actor, stepId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await loadStepForEdit(tx, actor, stepId);
    await engine.removeStep(tx, actor, stepId);
    await recordLifecycle(tx, actor, "sequence_step", stepId, "delete");
  });
}

/** Put the sequence's steps in the given order. Every live step must be listed once. */
export async function reorderSteps(
  db: Db,
  actor: Actor,
  sequenceId: string,
  stepIds: string[],
): Promise<Step[]> {
  await db.transaction(async (tx) => {
    const sequence = await loadSequence(tx, actor, sequenceId, true);
    requireRecord(actor.permissions, "sequences", "edit", sequence, actor.userId);
    const current = await tx
      .select({ id: sequenceSteps.id, position: sequenceSteps.position })
      .from(sequenceSteps)
      .where(and(eq(sequenceSteps.sequenceId, sequenceId), isNull(sequenceSteps.deletedAt)))
      .orderBy(asc(sequenceSteps.position));
    const known = new Set(current.map((c) => c.id));
    if (
      stepIds.length !== known.size ||
      new Set(stepIds).size !== stepIds.length ||
      !stepIds.every((id) => known.has(id))
    ) {
      throw new ValidationError("The new order must list every step in the sequence exactly once");
    }
    const before = current.map((c) => c.id).join(",");
    for (const [i, id] of stepIds.entries()) {
      await tx.update(sequenceSteps).set({ position: i + 1 }).where(eq(sequenceSteps.id, id));
    }
    if (before !== stepIds.join(",")) {
      await recordUpdate(tx, actor, "sequence", sequenceId, [
        { field: "stepOrder", oldValue: before, newValue: stepIds.join(",") },
      ]);
    }
  });
  return listSteps(db, actor, sequenceId);
}

// ---------------------------------------------------------- enrollment

export const enrollInput = z
  .object({
    leadId: z.uuid().optional(),
    contactId: z.uuid().optional(),
    ownerId: z.uuid().optional(),
  })
  .refine((v) => Boolean(v.leadId) !== Boolean(v.contactId), {
    message: "Provide exactly one of leadId or contactId",
  });

export async function enrollPerson(db: Db, actor: Actor, sequenceId: string, raw: unknown) {
  requireTool(actor.permissions, "sequences.enroll");
  const input = enrollInput.parse(raw);
  const sequence = await loadSequence(db, actor, sequenceId);
  requireRecord(actor.permissions, "sequences", "view", sequence, actor.userId);

  const ownerId = input.ownerId ?? actor.userId;
  if (ownerId !== actor.userId) {
    // Putting work in someone else's queue is a manager action.
    requireTool(actor.permissions, "sequences.manage_others");
    if (!(await isMember(db, actor.orgId, ownerId))) {
      throw new ValidationError("Owner is not a user in this organization");
    }
  }
  const person = input.leadId ? { leadId: input.leadId } : { contactId: input.contactId! };
  return engine.enroll(db, actor, { sequenceId, person, ownerId });
}

export async function listEnrollments(db: Db, actor: Actor, sequenceId: string) {
  const sequence = await loadSequence(db, actor, sequenceId);
  requireRecord(actor.permissions, "sequences", "view", sequence, actor.userId);
  return db
    .select({
      id: enrollments.id,
      state: enrollments.state,
      endReason: enrollments.endReason,
      ownerId: enrollments.ownerId,
      currentStepId: enrollments.currentStepId,
      enrolledAt: enrollments.enrolledAt,
      endedAt: enrollments.endedAt,
      leadId: enrollments.leadId,
      contactId: enrollments.contactId,
      leadFirstName: leads.firstName,
      leadLastName: leads.lastName,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      nextDueOn: stepTasks.dueOn,
    })
    .from(enrollments)
    .leftJoin(leads, eq(enrollments.leadId, leads.id))
    .leftJoin(contacts, eq(enrollments.contactId, contacts.id))
    .leftJoin(
      stepTasks,
      and(eq(stepTasks.enrollmentId, enrollments.id), eq(stepTasks.state, "open")),
    )
    .where(and(eq(enrollments.orgId, actor.orgId), eq(enrollments.sequenceId, sequenceId)))
    .orderBy(desc(enrollments.enrolledAt));
}

/** Reps work their own queue; acting on someone else's needs manage_others. */
function requireQueueAccess(actor: Actor, ownerId: string) {
  requireTool(actor.permissions, "sequences.enroll");
  if (ownerId !== actor.userId && !canUse(actor.permissions, "sequences.manage_others")) {
    throw new PermissionError("sequences.manage_others");
  }
}

async function enrollmentOwner(db: Db, actor: Actor, enrollmentId: string): Promise<string> {
  const [row] = await db
    .select({ ownerId: enrollments.ownerId })
    .from(enrollments)
    .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.orgId, actor.orgId)));
  if (!row) throw new NotFoundError("enrollment");
  return row.ownerId;
}

async function taskOwner(db: Db, actor: Actor, taskId: string): Promise<string> {
  const [row] = await db
    .select({ ownerId: stepTasks.ownerId })
    .from(stepTasks)
    .where(and(eq(stepTasks.id, taskId), eq(stepTasks.orgId, actor.orgId)));
  if (!row) throw new NotFoundError("task");
  return row.ownerId;
}

export async function pause(db: Db, actor: Actor, enrollmentId: string) {
  requireQueueAccess(actor, await enrollmentOwner(db, actor, enrollmentId));
  await engine.pauseEnrollment(db, actor, enrollmentId);
}

export async function resume(db: Db, actor: Actor, enrollmentId: string) {
  requireQueueAccess(actor, await enrollmentOwner(db, actor, enrollmentId));
  await engine.resumeEnrollment(db, actor, enrollmentId);
}

export const stopInput = z.object({
  reason: z.enum(["replied", "meeting_booked", "opted_out", "bounced", "removed"]),
});

export async function stop(db: Db, actor: Actor, enrollmentId: string, raw: unknown) {
  const { reason } = stopInput.parse(raw);
  requireQueueAccess(actor, await enrollmentOwner(db, actor, enrollmentId));
  await engine.stopEnrollment(db, actor, enrollmentId, reason);
}

// --------------------------------------------------------------- tasks

/** The Run Steps queue. Defaults to the actor's own tasks. */
export async function dueTasks(db: Db, actor: Actor, options: { ownerId?: string | "all" } = {}) {
  const ownerId = options.ownerId ?? actor.userId;
  if (ownerId !== actor.userId) requireTool(actor.permissions, "sequences.manage_others");
  return engine.getDueTasks(db, actor, { ownerId: ownerId === "all" ? undefined : ownerId });
}

export async function getTask(db: Db, actor: Actor, taskId: string) {
  // Anyone who can see sequences may look; only the queue owner may act.
  if (scopeFor(actor.permissions, "sequences", "view") === "none") {
    throw new PermissionError("sequences.view");
  }
  return engine.getTask(db, actor, taskId);
}

export const closeInput = z.object({ note: z.string().max(5000).optional() });
export const snoozeInput = z.object({ dueOn: z.string() });
export const overrideInput = z.object({
  subject: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
});

export async function complete(db: Db, actor: Actor, taskId: string, raw: unknown) {
  const input = closeInput.parse(raw ?? {});
  requireQueueAccess(actor, await taskOwner(db, actor, taskId));
  return engine.completeTask(db, actor, taskId, input);
}

export async function skip(db: Db, actor: Actor, taskId: string, raw: unknown) {
  const input = closeInput.parse(raw ?? {});
  requireQueueAccess(actor, await taskOwner(db, actor, taskId));
  return engine.skipTask(db, actor, taskId, input);
}

export async function snooze(db: Db, actor: Actor, taskId: string, raw: unknown) {
  const { dueOn } = snoozeInput.parse(raw);
  requireQueueAccess(actor, await taskOwner(db, actor, taskId));
  await engine.snoozeTask(db, actor, taskId, dueOn);
}

export async function editMessage(db: Db, actor: Actor, taskId: string, raw: unknown) {
  const override = overrideInput.parse(raw);
  requireQueueAccess(actor, await taskOwner(db, actor, taskId));
  await engine.setTaskOverride(db, actor, taskId, override);
  return engine.getTask(db, actor, taskId);
}
