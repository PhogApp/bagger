import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { enrollmentEndReasonEnum } from "../../shared/schema";
import type { Actor } from "../auth/actor";
import { scopeFor } from "../auth/permissions";
import type { Db } from "../db/types";

/**
 * Where a person is in their sequences, and where they have been, for lists
 * and record pages. Read-only: the engine is still the only code that changes
 * enrollments.
 *
 * Leads and contacts show their own enrollments. A lead's history stays with
 * the lead when it is converted (converting ends its sequence). An account
 * shows everyone at it: its contacts, and the leads that became them.
 */

export type SequenceKind = "leads" | "contacts" | "accounts";

export const END_REASONS = enrollmentEndReasonEnum.enumValues;
export type EndReason = (typeof END_REASONS)[number];

/** Filters a list can apply. */
export const sequenceFilterInput = z.object({
  /** in: in a sequence now (paused counts); out: not in one now; never: never been in one. */
  state: z.enum(["in", "out", "never"]).optional(),
  /** How the most recent sequence that ended, ended. */
  outcomes: z.array(z.enum(END_REASONS)).optional(),
  /** The most recent sequence ended at least this many days ago. */
  endedDays: z.number().int().min(0).max(3650).optional(),
});
export type SequenceFilter = z.infer<typeof sequenceFilterInput>;

/**
 * The condition that an enrollment (aliased `e`) belongs to the record whose
 * id is `id`. For accounts, only people the actor may see count.
 */
function belongsTo(kind: SequenceKind, actor: Actor, id: AnyPgColumn | SQL): SQL {
  if (kind === "leads") return sql`e.lead_id = ${id}`;
  if (kind === "contacts") return sql`e.contact_id = ${id}`;
  const scope = scopeFor(actor.permissions, "contacts", "view");
  if (scope === "none") return sql`false`;
  const own = scope === "own" ? sql` and c.owner_id = ${actor.userId}` : sql``;
  return sql`(e.contact_id in (select c.id from contacts c where c.account_id = ${id} and c.deleted_at is null${own})
    or e.lead_id in (select l.id from leads l join contacts c on c.id = l.converted_contact_id
      where c.account_id = ${id} and c.deleted_at is null${own}))`;
}

const ofRecord = (kind: SequenceKind, actor: Actor, id: AnyPgColumn | SQL) =>
  sql`e.org_id = ${actor.orgId} and ${belongsTo(kind, actor, id)}`;
const LIVE = sql`e.state in ('active', 'paused')`;

/** List conditions for the sequence filters. */
export function sequenceWhere(
  kind: SequenceKind,
  actor: Actor,
  id: AnyPgColumn,
  filter: SequenceFilter,
): SQL[] {
  const of = ofRecord(kind, actor, id);
  const where: SQL[] = [];
  const live = sql`exists (select 1 from enrollments e where ${of} and ${LIVE})`;
  if (filter.state === "in") where.push(live);
  if (filter.state === "out") where.push(sql`not ${live}`);
  if (filter.state === "never") {
    where.push(sql`not exists (select 1 from enrollments e where ${of})`);
  }
  if (filter.outcomes?.length) {
    const reasons = sql.join(
      filter.outcomes.map((r) => sql`${r}`),
      sql`, `,
    );
    where.push(sql`(select e.end_reason::text from enrollments e where ${of} and e.state = 'ended'
      order by e.ended_at desc limit 1) in (${reasons})`);
  }
  if (filter.endedDays !== undefined) {
    where.push(sql`(select max(e.ended_at) from enrollments e where ${of} and e.state = 'ended')
      <= now() - (${filter.endedDays} * interval '1 day')`);
  }
  return where;
}

/** Sort expressions: the current sequence, and when the last one ended. */
export function sequenceSorts(kind: SequenceKind, id: AnyPgColumn): Record<string, SQL> {
  // Sorting can't see the actor, so accounts count everyone at them here.
  const of = (alias: string) =>
    kind === "leads"
      ? sql.raw(`${alias}.lead_id`)
      : kind === "contacts"
        ? sql.raw(`${alias}.contact_id`)
        : null;
  const col = of("e");
  if (!col) {
    const atAccount = sql`(e.contact_id in (select c.id from contacts c where c.account_id = ${id} and c.deleted_at is null)
      or e.lead_id in (select l.id from leads l join contacts c on c.id = l.converted_contact_id where c.account_id = ${id}))`;
    return {
      sequence: sql`(select count(*) from enrollments e where ${atAccount} and ${LIVE})`,
      lastSequence: sql`(select max(e.ended_at) from enrollments e where ${atAccount} and e.state = 'ended')`,
    };
  }
  return {
    sequence: sql`(select lower(s.name) from enrollments e join sequences s on s.id = e.sequence_id
      where ${col} = ${id} and ${LIVE} limit 1)`,
    lastSequence: sql`(select max(e.ended_at) from enrollments e where ${col} = ${id} and e.state = 'ended')`,
  };
}

/** One time someone went through a sequence. */
export interface SequenceRun {
  enrollmentId: string;
  sequenceId: string;
  sequenceName: string;
  state: "active" | "paused" | "ended";
  endReason: EndReason | null;
  enrolledAt: string;
  endedAt: string | null;
  ownerId: string;
  /** The step they are on now, counted from 1, while the run is live. */
  step: number | null;
  steps: number;
  /** Steps done (completed or skipped). */
  stepsDone: number;
  nextDueOn: string | null;
  /** Who it was, for an account's rollup. */
  person: { leadId: string | null; contactId: string | null; name: string };
  /** It ran while the person was a lead (an account shows these for its converted leads). */
  asLead: boolean;
}

export interface SequenceSummary {
  /** The person's live run, or for an account the first of its people's. */
  current: SequenceRun | null;
  /** How many people are in a sequence now (0 or 1 for a person). */
  inNow: number;
  /** The most recent run that ended. */
  last: SequenceRun | null;
  /** Every run, ever. */
  total: number;
  /** The most recent runs, newest first, for a hover list. */
  recent: SequenceRun[];
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const day = (v: unknown) =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

/** Every run for these records, newest first, keyed by the record's id. */
async function runsFor(
  db: Db,
  actor: Actor,
  kind: SequenceKind,
  ids: string[],
): Promise<Map<string, SequenceRun[]>> {
  const out = new Map<string, SequenceRun[]>();
  if (ids.length === 0) return out;
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  let key: SQL;
  let match: SQL;
  if (kind === "leads") {
    key = sql`e.lead_id`;
    match = sql`e.lead_id in (${list})`;
  } else if (kind === "contacts") {
    key = sql`e.contact_id`;
    match = sql`e.contact_id in (${list})`;
  } else {
    const scope = scopeFor(actor.permissions, "contacts", "view");
    if (scope === "none") return out;
    const own = (alias: string) =>
      scope === "own" ? sql` and ${sql.raw(alias)}.owner_id = ${actor.userId}` : sql``;
    key = sql`coalesce(c.account_id, lc.account_id)`;
    match = sql`((c.account_id in (${list}) and c.deleted_at is null${own("c")})
      or (lc.account_id in (${list}) and lc.deleted_at is null${own("lc")}))`;
  }
  const result = await db.execute(sql`
    select e.id, e.sequence_id, s.name as sequence_name, e.state, e.end_reason,
      e.enrolled_at, e.ended_at, e.owner_id, e.lead_id, e.contact_id,
      coalesce(c.first_name, l.first_name) as first_name,
      coalesce(c.last_name, l.last_name) as last_name,
      ${key} as key,
      (select t.due_on from step_tasks t where t.enrollment_id = e.id and t.state = 'open' limit 1) as next_due_on,
      (select count(*)::int from sequence_steps ss
        where ss.sequence_id = e.sequence_id and ss.deleted_at is null) as steps,
      (select count(*)::int from sequence_steps ss join sequence_steps cur on cur.id = e.current_step_id
        where ss.sequence_id = e.sequence_id and ss.deleted_at is null and ss.position <= cur.position) as step,
      (select count(*)::int from step_tasks t
        where t.enrollment_id = e.id and t.state in ('completed', 'skipped')) as steps_done
    from enrollments e
    join sequences s on s.id = e.sequence_id
    left join contacts c on c.id = e.contact_id
    left join leads l on l.id = e.lead_id
    left join contacts lc on lc.id = l.converted_contact_id
    where e.org_id = ${actor.orgId} and ${match}
    order by (e.state <> 'ended') desc, coalesce(e.ended_at, e.enrolled_at) desc, e.id`);
  for (const r of result.rows as Record<string, unknown>[]) {
    const live = r.state !== "ended";
    const run: SequenceRun = {
      enrollmentId: r.id as string,
      sequenceId: r.sequence_id as string,
      sequenceName: r.sequence_name as string,
      state: r.state as SequenceRun["state"],
      endReason: (r.end_reason as EndReason | null) ?? null,
      enrolledAt: iso(r.enrolled_at)!,
      endedAt: iso(r.ended_at),
      ownerId: r.owner_id as string,
      step: live && Number(r.step) > 0 ? Number(r.step) : null,
      steps: Number(r.steps),
      stepsDone: Number(r.steps_done),
      nextDueOn: day(r.next_due_on),
      person: {
        leadId: (r.lead_id as string | null) ?? null,
        contactId: (r.contact_id as string | null) ?? null,
        name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
      },
      asLead: r.lead_id != null,
    };
    const k = r.key as string;
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(run);
  }
  return out;
}

const RECENT = 10;

/** A summary for each record on a page of a list. */
export async function summarize(
  db: Db,
  actor: Actor,
  kind: SequenceKind,
  ids: string[],
): Promise<Map<string, SequenceSummary>> {
  const runs = await runsFor(db, actor, kind, ids);
  const out = new Map<string, SequenceSummary>();
  for (const id of ids) {
    const all = runs.get(id) ?? [];
    const live = all.filter((r) => r.state !== "ended");
    out.set(id, {
      current: live[0] ?? null,
      inNow: live.length,
      last: all.find((r) => r.state === "ended") ?? null,
      total: all.length,
      recent: all.slice(0, RECENT),
    });
  }
  return out;
}

/** Every run for one record, newest first, for its page. */
export async function sequenceHistory(
  db: Db,
  actor: Actor,
  kind: SequenceKind,
  id: string,
): Promise<SequenceRun[]> {
  return (await runsFor(db, actor, kind, [id])).get(id) ?? [];
}

/** Each person who has been through this sequence before, with their latest run. */
export interface RepeatRun {
  id: string;
  kind: "lead" | "contact";
  times: number;
  last: { endReason: EndReason | null; endedAt: string | null; asLead: boolean };
}

/**
 * Of these people, who has already been through `sequenceId` and finished
 * (for whatever reason). A contact counts runs from when they were a lead.
 * Used to warn before enrolling them again; it never stops anyone.
 */
export async function previousRuns(
  db: Db,
  actor: Actor,
  sequenceId: string,
  people: { leadIds: string[]; contactIds: string[] },
): Promise<RepeatRun[]> {
  const out: RepeatRun[] = [];
  const pick = async (kind: "lead" | "contact", ids: string[]) => {
    if (ids.length === 0) return;
    const list = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    // For contacts, the person is the contact itself or the lead it came from.
    const who =
      kind === "lead"
        ? sql`e.lead_id`
        : sql`coalesce(e.contact_id, (select l.converted_contact_id from leads l where l.id = e.lead_id))`;
    const result = await db.execute(sql`
      select who, count(*)::int as times,
        (array_agg(e.end_reason::text order by e.ended_at desc))[1] as end_reason,
        max(e.ended_at) as ended_at,
        (array_agg(e.lead_id is not null order by e.ended_at desc))[1] as as_lead
      from (select e.*, ${who} as who from enrollments e
            where e.org_id = ${actor.orgId} and e.sequence_id = ${sequenceId} and e.state = 'ended') e
      where e.who in (${list})
      group by who`);
    for (const r of result.rows as Record<string, unknown>[]) {
      out.push({
        id: r.who as string,
        kind,
        times: Number(r.times),
        last: {
          endReason: (r.end_reason as EndReason | null) ?? null,
          endedAt: iso(r.ended_at),
          asLead: kind === "contact" && Boolean(r.as_lead),
        },
      });
    }
  };
  await pick("lead", people.leadIds);
  await pick("contact", people.contactIds);
  return out;
}
