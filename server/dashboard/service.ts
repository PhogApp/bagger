import { and, desc, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  activities,
  enrollments,
  opportunities,
  orgSettings,
  statusOptions,
  stepTasks,
  todos,
  users,
} from "../../shared/schema";
import { isMember, type Actor } from "../auth/actor";
import { canUse, PermissionError } from "../auth/permissions";
import type { Db } from "../db/types";
import { ValidationError } from "../errors";
import { activityQuery } from "../activities/service";
import { localDate } from "../sequences/dates";

/**
 * The home screen's numbers, for one rep or the whole organization.
 *
 * Everyone sees their own. Seeing someone else's, or everyone's, takes the
 * same permission as working other reps' sequences (Managers and Admins).
 *
 * "Today" is a calendar date in the rep's time zone, as for due steps; for
 * the whole organization it is the organization's default time zone.
 */

export const dashboardQuery = z.object({
  /** "me" (the default), "all", or a user's id. */
  owner: z.union([z.literal("me"), z.literal("all"), z.uuid()]).optional(),
});

const DAY = 24 * 60 * 60 * 1000;

export async function getDashboard(db: Db, actor: Actor, raw: unknown, now = new Date()) {
  const { owner = "me" } = dashboardQuery.parse(raw);
  const ownerId = owner === "me" ? actor.userId : owner === "all" ? null : owner;
  if (ownerId !== actor.userId && !canUse(actor.permissions, "sequences.manage_others")) {
    throw new PermissionError("sequences.manage_others");
  }
  if (ownerId && ownerId !== actor.userId && !(await isMember(db, actor.orgId, ownerId))) {
    throw new ValidationError("That user is not in this organization");
  }
  const mine = (column: AnyPgColumn): SQL[] => (ownerId ? [eq(column, ownerId)] : []);

  const [org] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, actor.orgId));
  let timeZone = org?.timezone ?? "America/Chicago";
  if (ownerId) {
    const [user] = await db.select({ tz: users.timezone }).from(users).where(eq(users.id, ownerId));
    timeZone = user?.tz ?? timeZone;
  }
  const today = localDate(now, timeZone);
  const monthStart = `${today.slice(0, 8)}01`;
  const [y, m] = today.split("-").map(Number);
  const monthEnd = `${today.slice(0, 8)}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const monthAgo = new Date(now.getTime() - 30 * DAY);

  // ---- steps waiting in Run Steps
  const [steps] = await db
    .select({
      dueToday: sql<number>`count(*) filter (where ${stepTasks.dueOn} = ${today})::int`,
      overdue: sql<number>`count(*) filter (where ${stepTasks.dueOn} < ${today})::int`,
    })
    .from(stepTasks)
    .innerJoin(enrollments, eq(stepTasks.enrollmentId, enrollments.id))
    .where(
      and(
        eq(stepTasks.orgId, actor.orgId),
        eq(stepTasks.state, "open"),
        eq(enrollments.state, "active"),
        ...mine(stepTasks.ownerId),
      ),
    );

  // ---- to-dos waiting
  const [todoCounts] = await db
    .select({
      dueToday: sql<number>`count(*) filter (where ${todos.dueOn} = ${today})::int`,
      overdue: sql<number>`count(*) filter (where ${todos.dueOn} < ${today})::int`,
    })
    .from(todos)
    .where(
      and(
        eq(todos.orgId, actor.orgId),
        isNull(todos.deletedAt),
        eq(todos.state, "open"),
        ...mine(todos.ownerId),
      ),
    );

  // ---- activity in the last 7 days, by type
  const activityRows = await db
    .select({ type: activities.type, n: sql<number>`count(*)::int` })
    .from(activities)
    .where(
      and(
        eq(activities.orgId, actor.orgId),
        isNull(activities.deletedAt),
        gte(activities.occurredAt, weekAgo),
        ...mine(activities.ownerId),
      ),
    )
    .groupBy(activities.type);
  const activityThisWeek = Object.fromEntries(activityRows.map((r) => [r.type, r.n]));

  // ---- sequences: who is in one now, and how the last 30 days ended
  const [inSequence] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.orgId, actor.orgId),
        inArray(enrollments.state, ["active", "paused"]),
        ...mine(enrollments.ownerId),
      ),
    );
  const endedRows = await db
    .select({ reason: enrollments.endReason, n: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.orgId, actor.orgId),
        eq(enrollments.state, "ended"),
        gte(enrollments.endedAt, monthAgo),
        ...mine(enrollments.ownerId),
      ),
    )
    .groupBy(enrollments.endReason);
  const ended = Object.fromEntries(endedRows.map((r) => [r.reason, r.n]));

  // ---- pipeline
  const openDeals = and(
    eq(opportunities.orgId, actor.orgId),
    isNull(opportunities.deletedAt),
    isNull(opportunities.closedAt),
    ...mine(opportunities.ownerId),
  );
  const byStage = await db
    .select({
      stage: opportunities.status,
      count: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${opportunities.amount}), 0)`,
    })
    .from(opportunities)
    .where(openDeals)
    .groupBy(opportunities.status);
  const [closingThisMonth] = await db
    .select({
      count: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${opportunities.amount}), 0)`,
    })
    .from(opportunities)
    .where(
      and(
        openDeals,
        gte(opportunities.closeDate, monthStart),
        sql`${opportunities.closeDate} <= ${monthEnd}`,
      ),
    );
  const closedRows = await db
    .select({
      effect: statusOptions.effect,
      count: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${opportunities.amount}), 0)`,
    })
    .from(opportunities)
    .innerJoin(
      statusOptions,
      and(
        eq(statusOptions.orgId, opportunities.orgId),
        eq(statusOptions.object, "opportunities"),
        eq(statusOptions.name, opportunities.status),
      ),
    )
    .where(
      and(
        eq(opportunities.orgId, actor.orgId),
        isNull(opportunities.deletedAt),
        gte(opportunities.closedAt, monthAgo),
        inArray(statusOptions.effect, ["won", "lost"]),
        ...mine(opportunities.ownerId),
      ),
    )
    .groupBy(statusOptions.effect);
  const closed = (effect: string) => {
    const row = closedRows.find((r) => r.effect === effect);
    return { count: row?.count ?? 0, amount: Number(row?.amount ?? 0) };
  };

  // ---- the latest activity
  const recent = await activityQuery(db)
    .where(
      and(
        eq(activities.orgId, actor.orgId),
        isNull(activities.deletedAt),
        ...mine(activities.ownerId),
      ),
    )
    .orderBy(desc(activities.occurredAt))
    .limit(8);

  return {
    owner: ownerId ?? "all",
    today,
    steps: { dueToday: steps?.dueToday ?? 0, overdue: steps?.overdue ?? 0 },
    todos: { dueToday: todoCounts?.dueToday ?? 0, overdue: todoCounts?.overdue ?? 0 },
    activityThisWeek: {
      call: activityThisWeek.call ?? 0,
      email: activityThisWeek.email ?? 0,
      linkedin: activityThisWeek.linkedin ?? 0,
      meeting: activityThisWeek.meeting ?? 0,
      note: activityThisWeek.note ?? 0,
    },
    sequences: {
      inSequence: inSequence?.n ?? 0,
      last30Days: {
        replied: ended.replied ?? 0,
        meetingBooked: ended.meeting_booked ?? 0,
        finished: ended.finished ?? 0,
        optedOut: ended.opted_out ?? 0,
      },
    },
    pipeline: {
      byStage: byStage.map((r) => ({
        stage: r.stage,
        count: r.count,
        amount: Number(r.amount),
      })),
      closingThisMonth: {
        count: closingThisMonth?.count ?? 0,
        amount: Number(closingThisMonth?.amount ?? 0),
      },
      wonLast30Days: closed("won"),
      lostLast30Days: closed("lost"),
    },
    recentActivity: recent,
  };
}
