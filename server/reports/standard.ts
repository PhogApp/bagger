import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  activities,
  enrollments,
  leads,
  opportunities,
  opportunityStageHistory,
  orgSettings,
  sequenceSteps,
  sequences,
  statusOptions,
  stepTasks,
} from "../../shared/schema";
import { isMember, type Actor } from "../auth/actor";
import { canUse, PermissionError, requireTool } from "../auth/permissions";
import type { Db } from "../db/types";
import { ValidationError } from "../errors";

/**
 * The standard reports: sequence performance, rep activity, pipeline and
 * lead conversion.
 *
 * Every report takes a date range of calendar days in the organization's
 * time zone (both ends included) and a rep. Everyone sees their own numbers;
 * seeing another rep's, or everyone's, takes the same permission as the
 * dashboard (Managers and Admins). Converted leads are counted only where the
 * report is about conversion.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use dates such as 2026-10-01");
export const reportQuery = z
  .object({
    from: day,
    to: day,
    /** "me" (the default), "all", or a user's id. */
    owner: z.union([z.literal("me"), z.literal("all"), z.uuid()]).optional(),
    /** Activity only: how to bucket the counts over time. */
    interval: z.enum(["day", "week", "month"]).optional(),
  })
  .refine((q) => q.from <= q.to, { message: "The start date is after the end date" });

interface Scope {
  orgId: string;
  ownerId: string | null;
  from: string;
  to: string;
  tz: string;
  interval: "day" | "week" | "month";
  /** Conditions limiting a column to the chosen rep, if one is chosen. */
  mine: (column: AnyPgColumn) => SQL[];
  /** Conditions keeping a timestamp column inside the date range. */
  within: (column: AnyPgColumn) => SQL[];
}

async function scope(db: Db, actor: Actor, raw: unknown): Promise<Scope> {
  requireTool(actor.permissions, "reports.view");
  const q = reportQuery.parse(raw);
  const owner = q.owner ?? "me";
  const ownerId = owner === "me" ? actor.userId : owner === "all" ? null : owner;
  if (ownerId !== actor.userId && !canUse(actor.permissions, "sequences.manage_others")) {
    throw new PermissionError("sequences.manage_others");
  }
  if (ownerId && ownerId !== actor.userId && !(await isMember(db, actor.orgId, ownerId))) {
    throw new ValidationError("That user is not in this organization");
  }
  const [org] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, actor.orgId));
  const tz = org?.timezone ?? "America/Chicago";
  const localDay = (column: AnyPgColumn) => sql`(${column} at time zone ${tz})::date`;
  return {
    orgId: actor.orgId,
    ownerId,
    from: q.from,
    to: q.to,
    tz,
    interval: q.interval ?? "week",
    mine: (column) => (ownerId ? [eq(column, ownerId)] : []),
    within: (column) => [
      sql`${localDay(column)} >= ${q.from}::date`,
      sql`${localDay(column)} <= ${q.to}::date`,
    ],
  };
}

const n = (v: unknown) => Number(v ?? 0);

// ---------------------------------------------------------- sequences

/**
 * For each sequence: people enrolled in the range, and how enrollments that
 * ended in the range ended. For each step: how often it was completed or
 * skipped in the range.
 */
export async function sequenceReport(db: Db, actor: Actor, raw: unknown) {
  const s = await scope(db, actor, raw);

  const enrolled = await db
    .select({ sequenceId: enrollments.sequenceId, count: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.orgId, s.orgId),
        ...s.mine(enrollments.ownerId),
        ...s.within(enrollments.enrolledAt),
      ),
    )
    .groupBy(enrollments.sequenceId);
  const ended = await db
    .select({
      sequenceId: enrollments.sequenceId,
      reason: enrollments.endReason,
      count: sql<number>`count(*)::int`,
    })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.orgId, s.orgId),
        eq(enrollments.state, "ended"),
        ...s.mine(enrollments.ownerId),
        ...s.within(enrollments.endedAt),
      ),
    )
    .groupBy(enrollments.sequenceId, enrollments.endReason);
  const active = await db
    .select({ sequenceId: enrollments.sequenceId, count: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.orgId, s.orgId),
        inArray(enrollments.state, ["active", "paused"]),
        ...s.mine(enrollments.ownerId),
      ),
    )
    .groupBy(enrollments.sequenceId);
  const stepCounts = await db
    .select({
      stepId: stepTasks.stepId,
      completed: sql<number>`count(*) filter (where ${stepTasks.state} = 'completed')::int`,
      skipped: sql<number>`count(*) filter (where ${stepTasks.state} = 'skipped')::int`,
    })
    .from(stepTasks)
    .where(
      and(
        eq(stepTasks.orgId, s.orgId),
        inArray(stepTasks.state, ["completed", "skipped"]),
        ...s.mine(stepTasks.ownerId),
        ...s.within(stepTasks.closedAt),
      ),
    )
    .groupBy(stepTasks.stepId);

  const seqs = await db
    .select({ id: sequences.id, name: sequences.name, isActive: sequences.isActive })
    .from(sequences)
    .where(and(eq(sequences.orgId, s.orgId), isNull(sequences.deletedAt)))
    .orderBy(asc(sequences.name));
  const steps = await db
    .select({
      id: sequenceSteps.id,
      sequenceId: sequenceSteps.sequenceId,
      position: sequenceSteps.position,
      title: sequenceSteps.title,
      type: sequenceSteps.type,
    })
    .from(sequenceSteps)
    .where(and(eq(sequenceSteps.orgId, s.orgId), isNull(sequenceSteps.deletedAt)))
    .orderBy(asc(sequenceSteps.position));

  const rows = seqs.map((q) => {
    const endedHere = ended.filter((e) => e.sequenceId === q.id);
    const by = (reason: string) => n(endedHere.find((e) => e.reason === reason)?.count);
    const enrolledCount = n(enrolled.find((e) => e.sequenceId === q.id)?.count);
    const replied = by("replied");
    const meetings = by("meeting_booked");
    return {
      id: q.id,
      name: q.name,
      isActive: q.isActive,
      enrolled: enrolledCount,
      active: n(active.find((a) => a.sequenceId === q.id)?.count),
      finished: by("finished"),
      replied,
      meetingBooked: meetings,
      optedOut: by("opted_out") + by("bounced"),
      stopped: by("status_change") + by("removed"),
      /** Replies and meetings as a share of everyone whose sequence ended in the range. */
      responseRate: endedHere.length
        ? (replied + meetings) / endedHere.reduce((sum, e) => sum + n(e.count), 0)
        : null,
      steps: steps
        .filter((st) => st.sequenceId === q.id)
        .map((st) => {
          const c = stepCounts.find((x) => x.stepId === st.id);
          return {
            id: st.id,
            position: st.position,
            title: st.title,
            type: st.type,
            completed: n(c?.completed),
            skipped: n(c?.skipped),
          };
        }),
    };
  });
  // Sequences with nothing in the range are left out unless they are running now.
  return {
    sequences: rows.filter(
      (r) =>
        r.enrolled + r.active + r.finished + r.replied + r.meetingBooked + r.optedOut + r.stopped >
          0 || r.isActive,
    ),
  };
}

// ------------------------------------------------------------ activity

/** Activities in the range by rep and type, and over time. */
export async function activityReport(db: Db, actor: Actor, raw: unknown) {
  const s = await scope(db, actor, raw);
  const where = and(
    eq(activities.orgId, s.orgId),
    isNull(activities.deletedAt),
    eq(activities.status, "completed"),
    ...s.mine(activities.ownerId),
    ...s.within(activities.occurredAt),
  );
  const byRep = await db
    .select({
      ownerId: activities.ownerId,
      type: activities.type,
      count: sql<number>`count(*)::int`,
    })
    .from(activities)
    .where(where)
    .groupBy(activities.ownerId, activities.type);
  const bucket = sql<string>`to_char(date_trunc(${s.interval}, ${activities.occurredAt} at time zone ${s.tz}), 'YYYY-MM-DD')`;
  const overTime = await db
    .select({ period: bucket, type: activities.type, count: sql<number>`count(*)::int` })
    .from(activities)
    .where(where)
    // Grouped by position: the bucket is written with parameters, so naming it again would not match.
    .groupBy(sql`1`, sql`2`)
    .orderBy(sql`1`);

  const reps = new Map<string, Record<string, number>>();
  for (const r of byRep) {
    const row = reps.get(r.ownerId) ?? {};
    row[r.type] = n(r.count);
    reps.set(r.ownerId, row);
  }
  const periods = new Map<string, Record<string, number>>();
  for (const r of overTime) {
    const row = periods.get(r.period) ?? {};
    row[r.type] = n(r.count);
    periods.set(r.period, row);
  }
  return {
    interval: s.interval,
    byRep: [...reps].map(([ownerId, counts]) => ({ ownerId, ...counts })),
    overTime: [...periods].map(([period, counts]) => ({ period, ...counts })),
  };
}

// ------------------------------------------------------------ pipeline

/**
 * Open deals now, by stage and rep; deals closed in the range, won and lost;
 * and how long deals spend in each stage, from the stage log.
 */
export async function pipelineReport(db: Db, actor: Actor, raw: unknown) {
  const s = await scope(db, actor, raw);
  const live = and(
    eq(opportunities.orgId, s.orgId),
    isNull(opportunities.deletedAt),
    ...s.mine(opportunities.ownerId),
  );

  const open = await db
    .select({
      stage: opportunities.status,
      ownerId: opportunities.ownerId,
      count: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${opportunities.amount}), 0)`,
    })
    .from(opportunities)
    .where(and(live, isNull(opportunities.closedAt)))
    .groupBy(opportunities.status, opportunities.ownerId);

  const stageOf = and(
    eq(statusOptions.orgId, opportunities.orgId),
    eq(statusOptions.object, "opportunities"),
    eq(statusOptions.name, opportunities.status),
  );
  const closed = await db
    .select({
      effect: statusOptions.effect,
      ownerId: opportunities.ownerId,
      count: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${opportunities.amount}), 0)`,
      days: sql<string>`coalesce(sum(extract(epoch from (${opportunities.closedAt} - ${opportunities.createdAt})) / 86400), 0)`,
    })
    .from(opportunities)
    .innerJoin(statusOptions, stageOf)
    .where(
      and(
        live,
        isNotNull(opportunities.closedAt),
        inArray(statusOptions.effect, ["won", "lost"]),
        ...s.within(opportunities.closedAt),
      ),
    )
    .groupBy(statusOptions.effect, opportunities.ownerId);

  // Each entry into a stage lasts until the next move (or until now).
  const stays = db.$with("stays").as(
    db
      .select({
        stage: opportunityStageHistory.toStage,
        enteredAt: opportunityStageHistory.changedAt,
        days: sql<number>`extract(epoch from (coalesce(lead(${opportunityStageHistory.changedAt}) over (partition by ${opportunityStageHistory.opportunityId} order by ${opportunityStageHistory.changedAt}), now()) - ${opportunityStageHistory.changedAt})) / 86400`.as(
          "days",
        ),
        ownerId: opportunities.ownerId,
      })
      .from(opportunityStageHistory)
      .innerJoin(opportunities, eq(opportunityStageHistory.opportunityId, opportunities.id))
      .where(and(eq(opportunityStageHistory.orgId, s.orgId), isNull(opportunities.deletedAt))),
  );
  const timeInStage = await db
    .with(stays)
    .select({
      stage: stays.stage,
      entries: sql<number>`count(*)::int`,
      avgDays: sql<string>`avg(${stays.days})`,
    })
    .from(stays)
    .where(and(...(s.ownerId ? [eq(stays.ownerId, s.ownerId)] : []), ...s.within(stays.enteredAt)))
    .groupBy(stays.stage);

  const sum = (rows: typeof closed, effect: string, key: "count" | "amount" | "days") =>
    rows.filter((r) => r.effect === effect).reduce((t, r) => t + n(r[key]), 0);
  const won = sum(closed, "won", "count");
  const lost = sum(closed, "lost", "count");
  const wonAmount = sum(closed, "won", "amount");
  const repIds = [...new Set([...open.map((o) => o.ownerId), ...closed.map((c) => c.ownerId)])];

  return {
    open: open.map((o) => ({
      stage: o.stage,
      ownerId: o.ownerId,
      count: n(o.count),
      amount: n(o.amount),
    })),
    closed: {
      won,
      lost,
      wonAmount,
      lostAmount: sum(closed, "lost", "amount"),
      /** Won as a share of deals closed in the range, won or lost. */
      winRate: won + lost > 0 ? won / (won + lost) : null,
      averageWon: won > 0 ? wonAmount / won : null,
      averageDaysToWin: won > 0 ? sum(closed, "won", "days") / won : null,
    },
    byRep: repIds.map((ownerId) => {
      const mine = closed.filter((c) => c.ownerId === ownerId);
      const w = sum(mine, "won", "count");
      const l = sum(mine, "lost", "count");
      const openMine = open.filter((o) => o.ownerId === ownerId);
      return {
        ownerId,
        openCount: openMine.reduce((t, o) => t + n(o.count), 0),
        openAmount: openMine.reduce((t, o) => t + n(o.amount), 0),
        won: w,
        lost: l,
        wonAmount: sum(mine, "won", "amount"),
        winRate: w + l > 0 ? w / (w + l) : null,
      };
    }),
    timeInStage: timeInStage.map((t) => ({
      stage: t.stage,
      entries: n(t.entries),
      averageDays: n(t.avgDays),
    })),
  };
}

// ---------------------------------------------------------- conversion

/** Leads created and converted in the range, by rep, and how long conversion took. */
export async function conversionReport(db: Db, actor: Actor, raw: unknown) {
  const s = await scope(db, actor, raw);
  const base = and(eq(leads.orgId, s.orgId), isNull(leads.deletedAt), ...s.mine(leads.ownerId));
  const created = await db
    .select({
      ownerId: leads.ownerId,
      count: sql<number>`count(*)::int`,
      convertedSince: sql<number>`count(*) filter (where ${leads.convertedAt} is not null)::int`,
    })
    .from(leads)
    .where(and(base, ...s.within(leads.createdAt)))
    .groupBy(leads.ownerId);
  const converted = await db
    .select({
      ownerId: leads.ownerId,
      count: sql<number>`count(*)::int`,
      days: sql<string>`coalesce(sum(extract(epoch from (${leads.convertedAt} - ${leads.createdAt})) / 86400), 0)`,
    })
    .from(leads)
    .where(and(base, isNotNull(leads.convertedAt), ...s.within(leads.convertedAt)))
    .groupBy(leads.ownerId);

  const ids = [...new Set([...created.map((c) => c.ownerId), ...converted.map((c) => c.ownerId)])];
  const total = (rows: { count: number }[]) => rows.reduce((t, r) => t + n(r.count), 0);
  const createdTotal = total(created);
  const convertedFromCreated = created.reduce((t, r) => t + n(r.convertedSince), 0);
  const convertedTotal = total(converted);
  return {
    created: createdTotal,
    converted: convertedTotal,
    /** Of the leads created in the range, the share converted so far. */
    conversionRate: createdTotal > 0 ? convertedFromCreated / createdTotal : null,
    averageDaysToConvert:
      convertedTotal > 0 ? converted.reduce((t, r) => t + n(r.days), 0) / convertedTotal : null,
    byRep: ids.map((ownerId) => {
      const c = created.find((r) => r.ownerId === ownerId);
      const v = converted.find((r) => r.ownerId === ownerId);
      return {
        ownerId,
        created: n(c?.count),
        converted: n(v?.count),
        conversionRate: c && n(c.count) > 0 ? n(c.convertedSince) / n(c.count) : null,
        averageDaysToConvert: v && n(v.count) > 0 ? n(v.days) / n(v.count) : null,
      };
    }),
  };
}
