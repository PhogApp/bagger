import { and, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  orgSettings,
  savedReports,
  statusOptions,
  type CustomFieldObject,
} from "../../shared/schema";
import { recordLifecycle, recordUpdate, diffFields } from "../audit/history";
import type { Actor } from "../auth/actor";
import {
  canUse,
  PermissionError,
  requireTool,
  scopeFor,
  type ObjectName,
} from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";
import { loadDefs, type FieldDef } from "../fields/service";
import { localDate } from "../sequences/dates";

/**
 * The report builder: pick a record type, columns, filters, up to two
 * groupings and totals, and get a table back.
 *
 * Every field a report can use comes from a fixed catalog (or the
 * organization's custom fields), so nothing a person types ever becomes SQL.
 * Reports respect record permissions, leave out deleted records, and leave
 * out converted leads unless the report filters on "Converted".
 */

export const REPORT_OBJECTS = [
  "leads",
  "contacts",
  "accounts",
  "opportunities",
  "activities",
] as const;
export type ReportObject = (typeof REPORT_OBJECTS)[number];

export type ReportFieldType =
  "text" | "number" | "money" | "date" | "datetime" | "choice" | "multichoice" | "boolean" | "user";

interface CatalogField {
  key: string;
  label: string;
  type: ReportFieldType;
  /** The value, for filters and sums. */
  value: SQL;
  /** What a person reads, when it differs (a user's name rather than their id). */
  display?: SQL;
  /** Choices for picklist-like fields, for the filter picker. */
  options?: string[];
}

const raw = (s: string) => sql.raw(s);
const userName = (idExpr: string) => raw(`(select u.name from users u where u.id = ${idExpr})`);
const personName = (alias: string) =>
  raw(`nullif(trim(${alias}.first_name || ' ' || ${alias}.last_name), '')`);

/** FROM and JOINs for each record type; the record itself is always "t". */
const SOURCES: Record<ReportObject, string> = {
  leads: "leads t",
  contacts: "contacts t left join accounts a on a.id = t.account_id",
  accounts: "accounts t",
  opportunities:
    "opportunities t left join accounts a on a.id = t.account_id left join contacts c on c.id = t.contact_id",
  activities:
    "activities t left join leads l on l.id = t.lead_id left join contacts c on c.id = t.contact_id " +
    "left join accounts a on a.id = t.account_id left join opportunities o on o.id = t.opportunity_id",
};

const ACTIVITY_TYPES = ["call", "email", "linkedin", "meeting", "note"];

function personFields(): CatalogField[] {
  return [
    { key: "name", label: "Name", type: "text", value: personName("t") },
    { key: "firstName", label: "First Name", type: "text", value: raw("t.first_name") },
    { key: "lastName", label: "Last Name", type: "text", value: raw("t.last_name") },
    { key: "title", label: "Title", type: "text", value: raw("t.title") },
    { key: "email", label: "Email", type: "text", value: raw("t.email") },
    { key: "cellPhone", label: "Cell Phone", type: "text", value: raw("t.cell_phone") },
    { key: "directPhone", label: "Direct Phone", type: "text", value: raw("t.direct_phone") },
    { key: "hqPhone", label: "HQ Phone", type: "text", value: raw("t.hq_phone") },
    { key: "linkedin", label: "LinkedIn", type: "text", value: raw("t.linkedin") },
  ];
}
const owned = (): CatalogField[] => [
  {
    key: "ownerId",
    label: "Owner",
    type: "user",
    value: raw("t.owner_id"),
    display: userName("t.owner_id"),
  },
  { key: "createdAt", label: "Created", type: "datetime", value: raw("t.created_at") },
  { key: "updatedAt", label: "Last Modified", type: "datetime", value: raw("t.updated_at") },
];

/** Bagger's own fields for each record type. Status choices are filled in per organization. */
function builtIn(object: ReportObject): CatalogField[] {
  switch (object) {
    case "leads":
      return [
        ...personFields(),
        { key: "company", label: "Company", type: "text", value: raw("t.company") },
        { key: "status", label: "Status", type: "choice", value: raw("t.status") },
        ...owned(),
        {
          key: "converted",
          label: "Converted",
          type: "boolean",
          value: raw("(t.converted_at is not null)"),
        },
        {
          key: "convertedAt",
          label: "Converted On",
          type: "datetime",
          value: raw("t.converted_at"),
        },
      ];
    case "contacts":
      return [
        ...personFields(),
        { key: "account", label: "Account", type: "text", value: raw("a.name") },
        { key: "status", label: "Status", type: "choice", value: raw("t.status") },
        ...owned(),
      ];
    case "accounts":
      return [
        { key: "name", label: "Account Name", type: "text", value: raw("t.name") },
        { key: "website", label: "Website", type: "text", value: raw("t.website") },
        { key: "linkedin", label: "LinkedIn", type: "text", value: raw("t.linkedin") },
        { key: "hqPhone", label: "HQ Phone", type: "text", value: raw("t.hq_phone") },
        { key: "status", label: "Status", type: "choice", value: raw("t.status") },
        ...owned(),
        {
          key: "contactCount",
          label: "Number of Contacts",
          type: "number",
          value: raw(
            "(select count(*) from contacts x where x.account_id = t.id and x.deleted_at is null)",
          ),
        },
        {
          key: "openPipeline",
          label: "Open Pipeline",
          type: "money",
          value: raw(
            "(select coalesce(sum(x.amount), 0) from opportunities x where x.account_id = t.id and x.deleted_at is null and x.closed_at is null)",
          ),
        },
      ];
    case "opportunities":
      return [
        { key: "name", label: "Opportunity Name", type: "text", value: raw("t.name") },
        { key: "account", label: "Account", type: "text", value: raw("a.name") },
        { key: "contact", label: "Main Contact", type: "text", value: personName("c") },
        { key: "amount", label: "Amount", type: "money", value: raw("t.amount") },
        { key: "closeDate", label: "Expected Close", type: "date", value: raw("t.close_date") },
        { key: "status", label: "Stage", type: "choice", value: raw("t.status") },
        {
          key: "outcome",
          label: "Outcome",
          type: "choice",
          options: ["Open", "Won", "Lost"],
          value: raw(
            "(case (select s.effect from status_options s where s.org_id = t.org_id and s.object = 'opportunities' and s.name = t.status) when 'won' then 'Won' when 'lost' then 'Lost' else 'Open' end)",
          ),
        },
        { key: "closedAt", label: "Closed On", type: "datetime", value: raw("t.closed_at") },
        ...owned(),
      ];
    case "activities":
      return [
        {
          key: "type",
          label: "Type",
          type: "choice",
          options: ACTIVITY_TYPES,
          value: raw("t.type"),
        },
        { key: "subject", label: "Subject", type: "text", value: raw("t.subject") },
        {
          key: "status",
          label: "Status",
          type: "choice",
          options: ["Open", "Completed"],
          value: raw("initcap(t.status)"),
        },
        { key: "occurredAt", label: "Date", type: "datetime", value: raw("t.occurred_at") },
        { key: "dueOn", label: "Due Date", type: "date", value: raw("t.due_on") },
        {
          key: "ownerId",
          label: "Owner",
          type: "user",
          value: raw("t.owner_id"),
          display: userName("t.owner_id"),
        },
        {
          key: "person",
          label: "Person",
          type: "text",
          value: raw(
            `coalesce(${"nullif(trim(c.first_name || ' ' || c.last_name), '')"}, nullif(trim(l.first_name || ' ' || l.last_name), ''))`,
          ),
        },
        { key: "account", label: "Account", type: "text", value: raw("a.name") },
        { key: "opportunity", label: "Opportunity", type: "text", value: raw("o.name") },
        {
          key: "fromSequence",
          label: "From a Sequence Step",
          type: "boolean",
          value: raw("(t.step_task_id is not null)"),
        },
      ];
  }
}

const CUSTOM_TYPE: Record<FieldDef["type"], ReportFieldType> = {
  text: "text",
  longtext: "text",
  phone: "text",
  url: "text",
  email: "text",
  number: "number",
  currency: "money",
  date: "date",
  checkbox: "boolean",
  picklist: "choice",
  multipicklist: "multichoice",
  user: "user",
};

function customField(def: FieldDef): CatalogField {
  const k = sql`${def.key}::text`;
  const text = sql`(t.custom ->> ${k})`;
  const type = CUSTOM_TYPE[def.type];
  const base = {
    key: `custom.${def.key}`,
    label: def.label,
    type,
    options: def.options.length ? def.options : undefined,
  };
  switch (type) {
    case "number":
    case "money":
      return { ...base, value: sql`(${text})::numeric` };
    case "date":
      return { ...base, value: sql`(${text})::date` };
    case "boolean":
      return { ...base, value: sql`(${text})::boolean` };
    case "multichoice":
      return {
        ...base,
        value: sql`(t.custom -> ${k})`,
        display: sql`(select string_agg(x, '; ') from jsonb_array_elements_text(case when jsonb_typeof(t.custom -> ${k}) = 'array' then t.custom -> ${k} else '[]'::jsonb end) x)`,
      };
    case "user":
      return {
        ...base,
        value: text,
        display: sql`(select u.name from users u where u.id::text = ${text})`,
      };
    default:
      return { ...base, value: text };
  }
}

/** Every field a report on this record type can use, for this organization. */
export async function catalog(
  db: Db,
  orgId: string,
  object: ReportObject,
): Promise<CatalogField[]> {
  const fields = builtIn(object);
  if (object !== "activities") {
    const stages = await db
      .select({ name: statusOptions.name })
      .from(statusOptions)
      .where(and(eq(statusOptions.orgId, orgId), eq(statusOptions.object, object)))
      .orderBy(statusOptions.position);
    const status = fields.find((f) => f.key === "status");
    if (status) status.options = stages.map((s) => s.name);
    for (const def of await loadDefs(db, orgId, object as CustomFieldObject))
      fields.push(customField(def));
  }
  return fields;
}

// ------------------------------------------------------------ definitions

const RELATIVE = [
  "today",
  "yesterday",
  "thisWeek",
  "lastWeek",
  "thisMonth",
  "lastMonth",
  "thisQuarter",
  "lastQuarter",
  "thisYear",
  "lastYear",
  "last7",
  "last30",
  "last90",
  "next30",
  "next90",
] as const;

const filterInput = z.object({
  field: z.string(),
  op: z.enum([
    "is",
    "isNot",
    "contains",
    "notContains",
    "startsWith",
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "on",
    "before",
    "after",
    "between",
    "within",
    "in",
    "notIn",
    "includesAny",
    "isTrue",
    "isFalse",
    "empty",
    "notEmpty",
  ]),
  value: z.unknown().optional(),
});

export const definitionInput = z.object({
  object: z.enum(REPORT_OBJECTS),
  columns: z.array(z.string()).max(40).default([]),
  filters: z.array(filterInput).max(20).default([]),
  groupBy: z
    .array(
      z.object({
        field: z.string(),
        by: z.enum(["day", "week", "month", "quarter", "year"]).optional(),
      }),
    )
    .max(2)
    .default([]),
  measures: z
    .array(
      z.object({ fn: z.enum(["count", "sum", "avg", "min", "max"]), field: z.string().optional() }),
    )
    .max(6)
    .default([]),
  sort: z.object({ column: z.string(), dir: z.enum(["asc", "desc"]) }).optional(),
  chart: z.enum(["table", "bar"]).default("table"),
});
export type ReportDefinition = z.infer<typeof definitionInput>;

const day = /^\d{4}-\d{2}-\d{2}$/;

/** [first, last] calendar day of a relative range, from today in the organization's time zone. */
export function relativeRange(name: (typeof RELATIVE)[number], today: string): [string, string] {
  const [y, m, d] = today.split("-").map(Number);
  const at = (yy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  const q = Math.floor((m - 1) / 3) * 3;
  switch (name) {
    case "today":
      return [today, today];
    case "yesterday":
      return [at(y, m - 1, d - 1), at(y, m - 1, d - 1)];
    case "thisWeek":
      return [at(y, m - 1, d - weekday), at(y, m - 1, d - weekday + 6)];
    case "lastWeek":
      return [at(y, m - 1, d - weekday - 7), at(y, m - 1, d - weekday - 1)];
    case "thisMonth":
      return [at(y, m - 1, 1), at(y, m, 0)];
    case "lastMonth":
      return [at(y, m - 2, 1), at(y, m - 1, 0)];
    case "thisQuarter":
      return [at(y, q, 1), at(y, q + 3, 0)];
    case "lastQuarter":
      return [at(y, q - 3, 1), at(y, q, 0)];
    case "thisYear":
      return [at(y, 0, 1), at(y, 11, 31)];
    case "lastYear":
      return [at(y - 1, 0, 1), at(y - 1, 11, 31)];
    case "last7":
      return [at(y, m - 1, d - 6), today];
    case "last30":
      return [at(y, m - 1, d - 29), today];
    case "last90":
      return [at(y, m - 1, d - 89), today];
    case "next30":
      return [today, at(y, m - 1, d + 29)];
    case "next90":
      return [today, at(y, m - 1, d + 89)];
  }
}

interface Context {
  fields: Map<string, CatalogField>;
  tz: string;
  today: string;
  userId: string;
}

function field(ctx: Context, key: string): CatalogField {
  const f = ctx.fields.get(key);
  if (!f) throw new ValidationError(`This report can't use "${key}"`);
  return f;
}

/** The value to compare: a calendar day for dates and timestamps. */
function comparable(ctx: Context, f: CatalogField): SQL {
  return f.type === "datetime" ? sql`((${f.value}) at time zone ${ctx.tz})::date` : f.value;
}

function condition(ctx: Context, input: z.infer<typeof filterInput>): SQL {
  const f = field(ctx, input.field);
  const v = input.value;
  const expr = comparable(ctx, f);
  const bad = () => new ValidationError(`The filter on ${f.label} is missing a value`);
  const str = () => {
    if (typeof v !== "string" || v.trim() === "") throw bad();
    return v.trim();
  };
  const num = () => {
    const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, ""));
    if (v === undefined || v === "" || !Number.isFinite(n)) throw bad();
    return n;
  };
  const date = (x: unknown) => {
    if (typeof x !== "string" || !day.test(x)) throw bad();
    return x;
  };
  const list = () => {
    const items = Array.isArray(v) ? v.map(String) : [];
    if (items.length === 0) throw bad();
    // "me" stands for whoever runs the report.
    return items.map((i) => (i === "me" && f.type === "user" ? ctx.userId : i));
  };
  const empty =
    f.type === "multichoice"
      ? sql`(${f.value} is null or jsonb_typeof(${f.value}) <> 'array' or jsonb_array_length(${f.value}) = 0)`
      : f.type === "text" || f.type === "choice"
        ? sql`coalesce(${f.value}::text, '') = ''`
        : sql`${f.value} is null`;
  const like = (pattern: string) => pattern.replace(/[\\%_]/g, "\\$&");

  switch (input.op) {
    case "empty":
      return empty;
    case "notEmpty":
      return sql`not ${empty}`;
    case "is":
      return sql`lower(${expr}::text) = lower(${str()})`;
    case "isNot":
      return sql`coalesce(lower(${expr}::text), '') <> lower(${str()})`;
    case "contains":
      return sql`${expr}::text ilike ${`%${like(str())}%`}`;
    case "notContains":
      return sql`coalesce(${expr}::text, '') not ilike ${`%${like(str())}%`}`;
    case "startsWith":
      return sql`${expr}::text ilike ${`${like(str())}%`}`;
    case "eq":
      return sql`${expr} = ${num()}`;
    case "ne":
      return sql`${expr} is distinct from ${num()}`;
    case "gt":
      return sql`${expr} > ${num()}`;
    case "gte":
      return sql`${expr} >= ${num()}`;
    case "lt":
      return sql`${expr} < ${num()}`;
    case "lte":
      return sql`${expr} <= ${num()}`;
    case "on":
      return sql`${expr} = ${date(v)}::date`;
    case "before":
      return sql`${expr} < ${date(v)}::date`;
    case "after":
      return sql`${expr} > ${date(v)}::date`;
    case "between": {
      const [a, b] = Array.isArray(v) ? v : [];
      return sql`${expr} between ${date(a)}::date and ${date(b)}::date`;
    }
    case "within": {
      if (!RELATIVE.includes(v as (typeof RELATIVE)[number])) throw bad();
      const [a, b] = relativeRange(v as (typeof RELATIVE)[number], ctx.today);
      return sql`${expr} between ${a}::date and ${b}::date`;
    }
    case "in":
    case "notIn": {
      const items = list();
      const match = sql`${f.value}::text in (${sql.join(
        items.map((i) => sql`${i}`),
        sql`, `,
      )})`;
      return input.op === "in" ? match : sql`(${f.value} is null or not ${match})`;
    }
    case "includesAny":
      return sql`(jsonb_typeof(${f.value}) = 'array' and ${f.value} ?| array[${sql.join(
        list().map((i) => sql`${i}::text`),
        sql`, `,
      )}])`;
    case "isTrue":
      return sql`${f.value} is true`;
    case "isFalse":
      return sql`${f.value} is not true`;
  }
}

/** A grouping's value: dates are bucketed (by month unless told otherwise). */
function grouping(
  ctx: Context,
  g: ReportDefinition["groupBy"][number],
): { expr: SQL; label: string } {
  const f = field(ctx, g.field);
  if (f.type === "date" || f.type === "datetime") {
    const by = g.by ?? "month";
    const format = {
      day: "YYYY-MM-DD",
      week: "YYYY-MM-DD",
      month: "YYYY-MM",
      quarter: 'YYYY-"Q"Q',
      year: "YYYY",
    }[by];
    return {
      expr: sql`to_char(date_trunc(${by}, ${comparable(ctx, f)}), ${format})`,
      label: `${f.label} (${by === "week" ? "week of" : `by ${by}`})`,
    };
  }
  return { expr: f.display ?? f.value, label: f.label };
}

export interface ReportResult {
  columns: { key: string; label: string; type: ReportFieldType | "group" }[];
  rows: unknown[][];
  /** Records matched (detail reports), or groups (grouped reports). */
  total: number;
  /** More rows matched than were returned. */
  truncated: boolean;
}

/** Run a report definition as the actor. */
export async function runReport(
  db: Db,
  actor: Actor,
  raw: unknown,
  options: { limit?: number } = {},
): Promise<ReportResult> {
  requireTool(actor.permissions, "reports.view");
  const def = definitionInput.parse(raw);
  const object = def.object;
  const scope = scopeFor(actor.permissions, object as ObjectName, "view");
  if (scope === "none") throw new PermissionError(`${object}.view`);

  const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, actor.orgId));
  const tz = settings?.timezone ?? "America/Chicago";
  const ctx: Context = {
    fields: new Map((await catalog(db, actor.orgId, object)).map((f) => [f.key, f])),
    tz,
    today: localDate(new Date(), tz),
    userId: actor.userId,
  };

  const where: SQL[] = [sql`t.org_id = ${actor.orgId}`, sql`t.deleted_at is null`];
  if (scope === "own") where.push(sql`t.owner_id = ${actor.userId}`);
  // A converted lead lives on as its contact; only a report about conversion wants it.
  if (
    object === "leads" &&
    !def.filters.some((f) => f.field === "converted" || f.field === "convertedAt")
  ) {
    where.push(sql`t.converted_at is null`);
  }
  // Open activities haven't happened yet; only a report that asks about status includes them.
  if (object === "activities" && !def.filters.some((f) => f.field === "status")) {
    where.push(sql`t.status = 'completed'`);
  }
  for (const f of def.filters) where.push(condition(ctx, f));
  const whereSql = sql.join(where, sql` and `);
  const from = sql.raw(SOURCES[object]);
  const limit = Math.min(options.limit ?? 1000, 50000);

  if (def.groupBy.length === 0) {
    const keys = def.columns.length > 0 ? def.columns : defaultColumns(object);
    const cols = keys.map((k) => field(ctx, k));
    const sortCol = def.sort ? cols.find((c) => c.key === def.sort!.column) : undefined;
    const order = sortCol
      ? sql`${sortCol.value} ${sql.raw(def.sort!.dir)} nulls last`
      : sql`t.created_at desc`;
    // Every column gets its own name, so two fields both called "name" don't collide.
    const select = sql.join(
      cols.map((c, i) => sql`${c.display ?? c.value} as ${sql.raw(`"c${i}"`)}`),
      sql`, `,
    );
    const rows = await db.execute(
      sql`select ${select} from ${from} where ${whereSql} order by ${order} limit ${limit + 1}`,
    );
    const [{ n }] = (
      await db.execute(sql`select count(*)::int as n from ${from} where ${whereSql}`)
    ).rows as { n: number }[];
    const data = (rows.rows as Record<string, unknown>[]).map((r) => Object.values(r));
    return {
      columns: cols.map((c) => ({ key: c.key, label: c.label, type: c.type })),
      rows: data.slice(0, limit),
      total: n,
      truncated: data.length > limit,
    };
  }

  // Grouped: one row per group with its totals. Grouped by position, because
  // the same expression written twice with parameters would not match.
  const groups = def.groupBy.map((g) => ({ key: g.field, ...grouping(ctx, g) }));
  const measures = (def.measures.length > 0 ? def.measures : [{ fn: "count" as const }]).map(
    (m) => {
      if (m.fn === "count")
        return {
          key: "count",
          label: "Record Count",
          type: "number" as const,
          expr: sql`count(*)::int`,
        };
      const f = field(ctx, m.field ?? "");
      if (f.type !== "number" && f.type !== "money") {
        throw new ValidationError(`${f.label} isn't a number, so it can't be totaled`);
      }
      const names = { sum: "Sum", avg: "Average", min: "Smallest", max: "Largest" } as const;
      return {
        key: `${m.fn}:${f.key}`,
        label: `${names[m.fn]} of ${f.label}`,
        type: f.type,
        expr: sql`${sql.raw(m.fn)}(${f.value})`,
      };
    },
  );
  const select = sql.join(
    [...groups.map((g) => g.expr), ...measures.map((m) => m.expr)].map(
      (e, i) => sql`${e} as ${sql.raw(`"c${i}"`)}`,
    ),
    sql`, `,
  );
  const positionList = groups.map((_, i) => String(i + 1)).join(", ");
  const positions = sql.raw(positionList);
  const all = [...groups.map((g) => g.key), ...measures.map((m) => m.key)];
  const sortAt = def.sort ? all.indexOf(def.sort.column) : -1;
  const order =
    sortAt >= 0
      ? sql.raw(`${sortAt + 1} ${def.sort!.dir} nulls last`)
      : sql.raw(`${positionList} nulls last`);
  const rows = await db.execute(
    sql`select ${select} from ${from} where ${whereSql} group by ${positions} order by ${order} limit ${limit + 1}`,
  );
  const data = (rows.rows as Record<string, unknown>[]).map((r) => Object.values(r));
  return {
    columns: [
      ...groups.map((g) => ({ key: g.key, label: g.label, type: "group" as const })),
      ...measures.map((m) => ({ key: m.key, label: m.label, type: m.type })),
    ],
    rows: data.slice(0, limit),
    total: Math.min(data.length, limit),
    truncated: data.length > limit,
  };
}

function defaultColumns(object: ReportObject): string[] {
  switch (object) {
    case "leads":
      return ["name", "title", "company", "email", "status", "ownerId"];
    case "contacts":
      return ["name", "title", "account", "email", "status", "ownerId"];
    case "accounts":
      return ["name", "website", "status", "ownerId"];
    case "opportunities":
      return ["name", "account", "amount", "closeDate", "status", "ownerId"];
    case "activities":
      return ["occurredAt", "type", "subject", "person", "account", "ownerId"];
  }
}

/** The fields the builder offers, for every record type. */
export async function reportFields(db: Db, actor: Actor) {
  requireTool(actor.permissions, "reports.view");
  const out: Record<
    string,
    { key: string; label: string; type: ReportFieldType; options?: string[] }[]
  > = {};
  for (const object of REPORT_OBJECTS) {
    out[object] = (await catalog(db, actor.orgId, object)).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      ...(f.options ? { options: f.options } : {}),
    }));
  }
  return {
    fields: out,
    defaultColumns: Object.fromEntries(REPORT_OBJECTS.map((o) => [o, defaultColumns(o)])),
  };
}

// ------------------------------------------------------------ saved reports

const savedInput = z.object({
  name: z.string().trim().min(1).max(120),
  definition: definitionInput,
  shared: z.boolean().optional(),
});

/** Reports this person can open: their own and everything shared. */
export async function listSaved(db: Db, actor: Actor) {
  requireTool(actor.permissions, "reports.view");
  return db
    .select({
      id: savedReports.id,
      name: savedReports.name,
      ownerId: savedReports.ownerId,
      shared: savedReports.shared,
      object: sql<string>`${savedReports.definition} ->> 'object'`,
      updatedAt: savedReports.updatedAt,
    })
    .from(savedReports)
    .where(
      and(
        eq(savedReports.orgId, actor.orgId),
        isNull(savedReports.deletedAt),
        or(eq(savedReports.ownerId, actor.userId), eq(savedReports.shared, true)),
      ),
    )
    .orderBy(desc(savedReports.updatedAt));
}

async function loadSaved(db: Db, actor: Actor, id: string, lock = false) {
  const query = db
    .select()
    .from(savedReports)
    .where(
      and(
        eq(savedReports.id, id),
        eq(savedReports.orgId, actor.orgId),
        isNull(savedReports.deletedAt),
      ),
    );
  const [row] = lock ? await query.for("update") : await query;
  if (!row || (!row.shared && row.ownerId !== actor.userId)) throw new NotFoundError("report");
  return row;
}

/** Your own reports you may change; anyone's shared one only with "manage all reports". */
function requireEditable(actor: Actor, row: { ownerId: string }) {
  if (row.ownerId !== actor.userId && !canUse(actor.permissions, "reports.manage_all")) {
    throw new PermissionError("reports.manage_all");
  }
}

export async function getSaved(db: Db, actor: Actor, id: string) {
  requireTool(actor.permissions, "reports.view");
  const row = await loadSaved(db, actor, id);
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    shared: row.shared,
    definition: row.definition,
    canEdit: row.ownerId === actor.userId || canUse(actor.permissions, "reports.manage_all"),
  };
}

export async function createSaved(db: Db, actor: Actor, raw: unknown) {
  requireTool(actor.permissions, "reports.create");
  const input = savedInput.parse(raw);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(savedReports)
      .values({
        orgId: actor.orgId,
        ownerId: actor.userId,
        name: input.name,
        definition: input.definition,
        shared: input.shared ?? false,
      })
      .returning();
    await recordLifecycle(tx, actor, "report", row.id, "create");
    return { id: row.id };
  });
}

export async function updateSaved(db: Db, actor: Actor, id: string, raw: unknown) {
  requireTool(actor.permissions, "reports.view");
  const patch = savedInput.partial().parse(raw);
  await db.transaction(async (tx) => {
    const before = await loadSaved(tx, actor, id, true);
    requireEditable(actor, before);
    const changes = diffFields(before, patch);
    if (changes.length === 0) return;
    await tx
      .update(savedReports)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(savedReports.id, id));
    await recordUpdate(tx, actor, "report", id, changes);
  });
}

export async function deleteSaved(db: Db, actor: Actor, id: string) {
  requireTool(actor.permissions, "reports.view");
  await db.transaction(async (tx) => {
    const row = await loadSaved(tx, actor, id, true);
    requireEditable(actor, row);
    await tx.update(savedReports).set({ deletedAt: new Date() }).where(eq(savedReports.id, id));
    await recordLifecycle(tx, actor, "report", id, "delete");
  });
}
