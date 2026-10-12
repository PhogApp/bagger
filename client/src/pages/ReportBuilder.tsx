import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, Download, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Bars } from "@/components/ReportBits";
import { MultiSelect } from "@/components/RecordPage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { canUse, useApi, useMe, useOrgUsers } from "@/lib/api";
import { cn, formatDateTime, formatDay, formatMoney } from "@/lib/utils";

/**
 * The report builder: choose a record type, columns, filters, groupings and
 * totals; the results update as you go. Save it for yourself or share it
 * with the organization.
 */

type FieldType =
  "text" | "number" | "money" | "date" | "datetime" | "choice" | "multichoice" | "boolean" | "user";
interface ReportField {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
}
type Op = string;
interface Filter {
  field: string;
  op: Op;
  value?: unknown;
}
interface Definition {
  object: ReportObject;
  columns: string[];
  filters: Filter[];
  groupBy: { field: string; by?: "day" | "week" | "month" | "quarter" | "year" }[];
  measures: { fn: "count" | "sum" | "avg" | "min" | "max"; field?: string }[];
  sort?: { column: string; dir: "asc" | "desc" };
  chart: "table" | "bar";
}
type ReportObject = "leads" | "contacts" | "accounts" | "opportunities" | "activities";
interface Result {
  columns: { key: string; label: string; type: FieldType | "group" }[];
  rows: unknown[][];
  total: number;
  truncated: boolean;
}

const OBJECTS: { value: ReportObject; label: string }[] = [
  { value: "leads", label: "Leads" },
  { value: "contacts", label: "Contacts" },
  { value: "accounts", label: "Accounts" },
  { value: "opportunities", label: "Opportunities" },
  { value: "activities", label: "Activities" },
];

const OPS: Record<FieldType, { value: Op; label: string }[]> = {
  text: [
    { value: "contains", label: "contains" },
    { value: "is", label: "is" },
    { value: "isNot", label: "is not" },
    { value: "startsWith", label: "starts with" },
    { value: "notContains", label: "does not contain" },
    { value: "empty", label: "is empty" },
    { value: "notEmpty", label: "is not empty" },
  ],
  number: [
    { value: "eq", label: "=" },
    { value: "ne", label: "≠" },
    { value: "gt", label: ">" },
    { value: "gte", label: "≥" },
    { value: "lt", label: "<" },
    { value: "lte", label: "≤" },
    { value: "empty", label: "is empty" },
    { value: "notEmpty", label: "is not empty" },
  ],
  money: [],
  date: [
    { value: "within", label: "is in" },
    { value: "on", label: "is on" },
    { value: "before", label: "is before" },
    { value: "after", label: "is after" },
    { value: "between", label: "is between" },
    { value: "empty", label: "is empty" },
    { value: "notEmpty", label: "is not empty" },
  ],
  datetime: [],
  choice: [
    { value: "in", label: "is any of" },
    { value: "notIn", label: "is none of" },
    { value: "empty", label: "is empty" },
    { value: "notEmpty", label: "is not empty" },
  ],
  user: [],
  multichoice: [
    { value: "includesAny", label: "includes any of" },
    { value: "empty", label: "is empty" },
    { value: "notEmpty", label: "is not empty" },
  ],
  boolean: [
    { value: "isTrue", label: "is yes" },
    { value: "isFalse", label: "is no" },
  ],
};
OPS.money = OPS.number;
OPS.datetime = OPS.date;
OPS.user = OPS.choice;

const RELATIVE = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["thisWeek", "This week"],
  ["lastWeek", "Last week"],
  ["thisMonth", "This month"],
  ["lastMonth", "Last month"],
  ["thisQuarter", "This quarter"],
  ["lastQuarter", "Last quarter"],
  ["thisYear", "This year"],
  ["lastYear", "Last year"],
  ["last7", "Last 7 days"],
  ["last30", "Last 30 days"],
  ["last90", "Last 90 days"],
  ["next30", "Next 30 days"],
  ["next90", "Next 90 days"],
] as const;
const NO_VALUE = new Set(["empty", "notEmpty", "isTrue", "isFalse"]);
const NUMERIC = new Set<FieldType>(["number", "money"]);
const DATES = new Set<FieldType>(["date", "datetime"]);

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

const blank = (object: ReportObject, columns: string[]): Definition => ({
  object,
  columns,
  filters: [],
  groupBy: [],
  measures: [],
  chart: "table",
});

function show(type: FieldType | "group", value: unknown): string {
  if (value === null || value === undefined || value === "")
    return type === "group" ? "(blank)" : "";
  switch (type) {
    case "money":
      return formatMoney(Number(value));
    case "number":
      return Number(value).toLocaleString();
    case "datetime":
      return formatDateTime(String(value));
    case "date":
      return formatDay(String(value).slice(0, 10));
    case "boolean":
      return value ? "Yes" : "No";
    default:
      return String(value);
  }
}

function Section(props: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="space-y-2 border-b pb-4 last:border-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {props.title}
      </h3>
      {props.note && <p className="text-xs text-muted-foreground">{props.note}</p>}
      {props.children}
    </section>
  );
}

function FilterValue(props: {
  field: ReportField;
  filter: Filter;
  users: { id: string; name: string }[];
  onChange: (value: unknown) => void;
}) {
  const { field, filter } = props;
  if (NO_VALUE.has(filter.op)) return null;
  if (filter.op === "within") {
    return (
      <select
        aria-label="Period"
        className={selectClass}
        value={String(filter.value ?? "thisMonth")}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {RELATIVE.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    );
  }
  if (filter.op === "between") {
    const [a, b] = Array.isArray(filter.value) ? (filter.value as string[]) : ["", ""];
    return (
      <div className="flex gap-1">
        <Input
          type="date"
          aria-label="From"
          className="h-9"
          value={a}
          onChange={(e) => props.onChange([e.target.value, b])}
        />
        <Input
          type="date"
          aria-label="To"
          className="h-9"
          value={b}
          onChange={(e) => props.onChange([a, e.target.value])}
        />
      </div>
    );
  }
  if (DATES.has(field.type)) {
    return (
      <Input
        type="date"
        aria-label="Date"
        className="h-9"
        value={String(filter.value ?? "")}
        onChange={(e) => props.onChange(e.target.value)}
      />
    );
  }
  if (filter.op === "in" || filter.op === "notIn" || filter.op === "includesAny") {
    const options =
      field.type === "user"
        ? [
            { value: "me", label: "Me (whoever runs it)" },
            ...props.users.map((u) => ({ value: u.id, label: u.name })),
          ]
        : (field.options ?? []).map((o) => ({ value: o, label: o }));
    const chosen = Array.isArray(filter.value) ? (filter.value as string[]) : [];
    return (
      <MultiSelect
        id={`filter-${field.key}`}
        options={options}
        value={chosen.join("; ")}
        onChange={(v) =>
          props.onChange(
            v
              .split(";")
              .map((x) => x.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }
  return (
    <Input
      aria-label="Value"
      className="h-9"
      inputMode={NUMERIC.has(field.type) ? "decimal" : undefined}
      value={String(filter.value ?? "")}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

/** A filter is ready to run once it has whatever value its operator needs. */
function complete(f: Filter): boolean {
  if (NO_VALUE.has(f.op)) return true;
  if (Array.isArray(f.value)) return f.value.length > 0 && f.value.every((x) => String(x) !== "");
  return f.value !== undefined && String(f.value).trim() !== "";
}

export function ReportBuilderPage({ params }: { params: { id: string } }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { data: me } = useMe();
  const { data: users } = useOrgUsers();
  const isNew = params.id === "new";

  const catalog = useQuery({
    queryKey: ["reports", "fields"],
    queryFn: () =>
      api<{
        fields: Record<ReportObject, ReportField[]>;
        defaultColumns: Record<ReportObject, string[]>;
      }>("GET", "/api/reports/fields"),
  });
  const saved = useQuery({
    queryKey: ["reports", "saved", params.id],
    queryFn: () =>
      api<{ id: string; name: string; shared: boolean; definition: Definition; canEdit: boolean }>(
        "GET",
        `/api/reports/saved/${params.id}`,
      ),
    enabled: !isNew,
  });

  const [name, setName] = useState("Untitled report");
  const [shared, setShared] = useState(false);
  const [def, setDef] = useState<Definition | null>(null);
  useEffect(() => {
    if (saved.data) {
      setName(saved.data.name);
      setShared(saved.data.shared);
      setDef({ ...blank(saved.data.definition.object, []), ...saved.data.definition });
    } else if (isNew && catalog.data && !def) {
      setDef(blank("opportunities", catalog.data.defaultColumns.opportunities));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.data, catalog.data, isNew]);

  // Run what's ready: filters still missing a value are left out until filled in.
  const runnable = useMemo(
    () => (def ? { ...def, filters: def.filters.filter(complete) } : null),
    [def],
  );
  const [debounced, setDebounced] = useState(runnable);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(runnable), 350);
    return () => clearTimeout(timer);
  }, [runnable]);
  const result = useQuery({
    queryKey: ["reports", "run", JSON.stringify(debounced)],
    queryFn: () => api<Result>("POST", "/api/reports/run", { definition: debounced }),
    enabled: Boolean(debounced),
    placeholderData: (previous) => previous,
  });

  const canEdit = isNew ? canUse(me, "reports.create") : Boolean(saved.data?.canEdit);
  const save = useMutation({
    mutationFn: async () => {
      if (isNew) {
        return api<{ id: string }>("POST", "/api/reports/saved", { name, definition: def, shared });
      }
      await api("PATCH", `/api/reports/saved/${params.id}`, { name, definition: def, shared });
      return { id: params.id };
    },
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: ["reports", "saved"] });
      if (isNew) navigate(`/reports/custom/${id}`, { replace: true });
    },
  });
  const remove = useMutation({
    mutationFn: () => api("DELETE", `/api/reports/saved/${params.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["reports", "saved"] });
      navigate("/reports?tab=custom");
    },
  });
  const exportAll = useMutation({
    mutationFn: () =>
      api<Result>("POST", "/api/reports/run", { definition: runnable, export: true }),
    onSuccess: (r) => {
      const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const csv = [
        r.columns.map((c) => cell(c.label)).join(","),
        ...r.rows.map((row) =>
          row
            .map((v, i) => {
              const t = r.columns[i].type;
              // Numbers stay plain so spreadsheets can add them up.
              return cell(
                t === "money" || t === "number" ? (v === null ? "" : String(v)) : show(t, v),
              );
            })
            .join(","),
        ),
      ].join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name.replace(/[^\w -]/g, "").trim() || "report"}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    },
  });

  if (catalog.error || saved.error) {
    return (
      <p className="p-8 text-sm text-destructive">{(catalog.error ?? saved.error)?.message}</p>
    );
  }
  if (!def || !catalog.data) return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;

  const fields = catalog.data.fields[def.object];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const set = (patch: Partial<Definition>) => setDef({ ...def, ...patch });
  const grouped = def.groupBy.length > 0;
  const numeric = fields.filter((f) => NUMERIC.has(f.type));
  const r = result.data;

  const sortBy = (column: string) =>
    set({
      sort: {
        column,
        dir: def.sort?.column === column && def.sort.dir === "asc" ? "desc" : "asc",
      },
    });

  return (
    <div>
      <div className="border-b bg-background px-6 py-4">
        <Link
          href="/reports?tab=custom"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Reports
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Input
            aria-label="Report name"
            className="h-10 max-w-md text-lg font-semibold"
            value={name}
            disabled={!canEdit}
            onChange={(e) => setName(e.target.value)}
          />
          {canEdit && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
              />
              Shared with everyone in the organization
            </label>
          )}
          <div className="ml-auto flex items-center gap-2">
            {canUse(me, "data.export_lists") && (
              <Button
                variant="outline"
                disabled={exportAll.isPending}
                onClick={() => exportAll.mutate()}
              >
                <Download className="mr-2 h-4 w-4" aria-hidden />
                CSV
              </Button>
            )}
            {!isNew && canEdit && (
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => remove.mutate()}
              >
                Delete
              </Button>
            )}
            {canEdit && (
              <Button disabled={save.isPending || name.trim() === ""} onClick={() => save.mutate()}>
                {isNew ? "Save report" : "Save changes"}
              </Button>
            )}
          </div>
        </div>
        {(save.error || remove.error || exportAll.error) && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {(save.error ?? remove.error ?? exportAll.error)?.message}
          </p>
        )}
        {save.isSuccess && !save.isPending && (
          <p role="status" className="mt-2 text-sm text-brand-teal">
            Saved.
          </p>
        )}
      </div>

      <div className="grid gap-6 p-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="space-y-4 rounded-lg border bg-background p-4">
          <Section title="Report on">
            <select
              aria-label="Record type"
              className={selectClass}
              value={def.object}
              onChange={(e) => {
                const object = e.target.value as ReportObject;
                setDef(blank(object, catalog.data.defaultColumns[object]));
              }}
            >
              {OBJECTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Section>

          <Section
            title="Filters"
            note={def.filters.length === 0 ? "Every record you can see." : undefined}
          >
            {def.filters.map((f, i) => {
              const field = byKey.get(f.field);
              if (!field) return null;
              const update = (patch: Partial<Filter>) =>
                set({ filters: def.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              return (
                <div key={i} className="space-y-1.5 rounded-md border p-2">
                  <div className="flex items-center gap-1">
                    <span className="flex-1 truncate text-sm font-medium">{field.label}</span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Remove the ${field.label} filter`}
                      onClick={() => set({ filters: def.filters.filter((_, j) => j !== i) })}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                  <select
                    aria-label={`How to compare ${field.label}`}
                    className={selectClass}
                    value={f.op}
                    onChange={(e) =>
                      update({
                        op: e.target.value,
                        value: e.target.value === "within" ? "thisMonth" : f.value,
                      })
                    }
                  >
                    {OPS[field.type].map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <FilterValue
                    field={field}
                    filter={f}
                    users={users ?? []}
                    onChange={(value) => update({ value })}
                  />
                </div>
              );
            })}
            <select
              aria-label="Add a filter"
              className={selectClass}
              value=""
              onChange={(e) => {
                const field = byKey.get(e.target.value);
                if (!field) return;
                const op = OPS[field.type][0].value;
                set({
                  filters: [
                    ...def.filters,
                    { field: field.key, op, value: op === "within" ? "thisMonth" : undefined },
                  ],
                });
              }}
            >
              <option value="">+ Add a filter…</option>
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </Section>

          <Section
            title="Group by"
            note="Up to two. Grouped reports show one row per group with totals."
          >
            {[0, 1].map((i) =>
              i > def.groupBy.length ? null : (
                <div key={i} className="flex gap-1">
                  <select
                    aria-label={i === 0 ? "Group by" : "Then group by"}
                    className={selectClass}
                    value={def.groupBy[i]?.field ?? ""}
                    onChange={(e) => {
                      const next = [...def.groupBy];
                      if (e.target.value === "") next.splice(i);
                      else next[i] = { field: e.target.value };
                      set({ groupBy: next, sort: undefined });
                    }}
                  >
                    <option value="">{i === 0 ? "Don't group" : "No second grouping"}</option>
                    {fields
                      .filter((f) => f.type !== "multichoice")
                      .map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                  </select>
                  {def.groupBy[i] && DATES.has(byKey.get(def.groupBy[i].field)?.type ?? "text") && (
                    <select
                      aria-label="Date grouping"
                      className={cn(selectClass, "w-28")}
                      value={def.groupBy[i].by ?? "month"}
                      onChange={(e) =>
                        set({
                          groupBy: def.groupBy.map((g, j) =>
                            j === i
                              ? { ...g, by: e.target.value as Definition["groupBy"][number]["by"] }
                              : g,
                          ),
                        })
                      }
                    >
                      {["day", "week", "month", "quarter", "year"].map((b) => (
                        <option key={b} value={b}>
                          by {b}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ),
            )}
          </Section>

          {grouped ? (
            <Section title="Totals">
              {(def.measures.length ? def.measures : [{ fn: "count" as const }]).map((m, i) => (
                <div key={i} className="flex items-center gap-1 text-sm">
                  {m.fn === "count" ? (
                    <span className="flex-1">Record count</span>
                  ) : (
                    <span className="flex-1">
                      {{ sum: "Sum", avg: "Average", min: "Smallest", max: "Largest" }[m.fn]} of{" "}
                      {byKey.get(m.field ?? "")?.label}
                    </span>
                  )}
                  {def.measures.length > 0 && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label="Remove this total"
                      onClick={() =>
                        set({ measures: def.measures.filter((_, j) => j !== i), sort: undefined })
                      }
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  )}
                </div>
              ))}
              {numeric.length > 0 && (
                <select
                  aria-label="Add a total"
                  className={selectClass}
                  value=""
                  onChange={(e) => {
                    const [fn, field] = e.target.value.split("|") as [
                      Definition["measures"][number]["fn"],
                      string,
                    ];
                    if (!fn) return;
                    const base = def.measures.length ? def.measures : [{ fn: "count" as const }];
                    set({ measures: [...base, fn === "count" ? { fn } : { fn, field }] });
                  }}
                >
                  <option value="">+ Add a total…</option>
                  {numeric.flatMap((f) =>
                    (["sum", "avg", "min", "max"] as const).map((fn) => (
                      <option key={`${fn}|${f.key}`} value={`${fn}|${f.key}`}>
                        {{ sum: "Sum", avg: "Average", min: "Smallest", max: "Largest" }[fn]} of{" "}
                        {f.label}
                      </option>
                    )),
                  )}
                </select>
              )}
              <div className="flex gap-3 pt-1 text-sm">
                {(["table", "bar"] as const).map((c) => (
                  <label key={c} className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="chart"
                      checked={def.chart === c}
                      onChange={() => set({ chart: c })}
                    />
                    {c === "table" ? "Table" : "Bar chart"}
                  </label>
                ))}
              </div>
            </Section>
          ) : (
            <Section title="Columns">
              <ul className="space-y-1">
                {def.columns.map((key, i) => (
                  <li key={key} className="flex items-center gap-1 text-sm">
                    <span className="flex-1 truncate">{byKey.get(key)?.label ?? key}</span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Move ${byKey.get(key)?.label} up`}
                      disabled={i === 0}
                      onClick={() => {
                        const next = [...def.columns];
                        [next[i - 1], next[i]] = [next[i], next[i - 1]];
                        set({ columns: next });
                      }}
                    >
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Move ${byKey.get(key)?.label} down`}
                      disabled={i === def.columns.length - 1}
                      onClick={() => {
                        const next = [...def.columns];
                        [next[i + 1], next[i]] = [next[i], next[i + 1]];
                        set({ columns: next });
                      }}
                    >
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Remove the ${byKey.get(key)?.label} column`}
                      disabled={def.columns.length === 1}
                      onClick={() => set({ columns: def.columns.filter((c) => c !== key) })}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
              <select
                aria-label="Add a column"
                className={selectClass}
                value=""
                onChange={(e) =>
                  e.target.value && set({ columns: [...def.columns, e.target.value] })
                }
              >
                <option value="">+ Add a column…</option>
                {fields
                  .filter((f) => !def.columns.includes(f.key))
                  .map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
              </select>
            </Section>
          )}
        </aside>

        <section className="min-w-0 rounded-lg border bg-background">
          <div className="flex items-center justify-between border-b px-4 py-3 text-sm">
            <span className="font-medium">
              {r
                ? grouped
                  ? `${r.total.toLocaleString()} ${r.total === 1 ? "group" : "groups"}`
                  : `${r.total.toLocaleString()} ${r.total === 1 ? "record" : "records"}`
                : " "}
              {r?.truncated && !grouped && " · showing the first 1,000"}
            </span>
            {result.isFetching && <span className="text-muted-foreground">Updating…</span>}
          </div>
          {result.error ? (
            <p className="p-4 text-sm text-destructive">{result.error.message}</p>
          ) : !r ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : r.rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Nothing matches these filters.
            </p>
          ) : grouped && def.chart === "bar" ? (
            <div className="p-4">
              {(() => {
                // Chart the first total other than the count, if there is one.
                const groupCount = def.groupBy.length;
                const measureCols = r.columns.slice(groupCount);
                const pick = Math.max(
                  0,
                  measureCols.findIndex((c) => c.key !== "count"),
                );
                const at = groupCount + pick;
                const measure = r.columns[at];
                return (
                  <>
                    <p className="mb-3 text-xs text-muted-foreground">Showing {measure.label}.</p>
                    <Bars
                      empty="Nothing to chart."
                      rows={r.rows.map((row) => {
                        const label = row
                          .slice(0, groupCount)
                          .map((v) => show("group", v))
                          .join(" · ");
                        return {
                          label,
                          value: Number(row[at] ?? 0),
                          display: show(measure.type, row[at]),
                          detail: `${label}: ${show(measure.type, row[at])}`,
                        };
                      })}
                    />
                  </>
                );
              })()}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {r.columns.map((c) => {
                      const right = c.type === "number" || c.type === "money";
                      return (
                        <TableHead key={c.key} className={cn(right && "text-right")}>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 hover:text-foreground"
                            onClick={() => sortBy(c.key)}
                          >
                            {c.label}
                            {def.sort?.column === c.key && (def.sort.dir === "asc" ? " ↑" : " ↓")}
                          </button>
                        </TableHead>
                      );
                    })}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.rows.map((row, i) => (
                    <TableRow key={i}>
                      {row.map((v, j) => {
                        const t = r.columns[j].type;
                        return (
                          <TableCell
                            key={j}
                            className={cn(
                              (t === "number" || t === "money") && "text-right tabular-nums",
                            )}
                          >
                            {show(t, v)}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** The Custom reports tab of the Reports page: saved reports and a way to start one. */
export function SavedReports() {
  const api = useApi();
  const { data: me } = useMe();
  const { data: users } = useOrgUsers();
  const list = useQuery({
    queryKey: ["reports", "saved"],
    queryFn: () =>
      api<
        {
          id: string;
          name: string;
          ownerId: string;
          shared: boolean;
          object: string;
          updatedAt: string;
        }[]
      >("GET", "/api/reports/saved"),
  });
  const label = (o: string) => OBJECTS.find((x) => x.value === o)?.label ?? o;
  return (
    <div className="rounded-lg border bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Custom reports</h2>
        {canUse(me, "reports.create") && (
          <Link href="/reports/custom/new">
            <Button size="sm">
              <Plus className="mr-1.5 h-4 w-4" aria-hidden />
              New report
            </Button>
          </Link>
        )}
      </div>
      {list.error ? (
        <p className="p-4 text-sm text-destructive">{list.error.message}</p>
      ) : !list.data ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : list.data.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">
          No saved reports yet. Build one with New report: pick a record type, filter it, group it
          and add totals.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Report on</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Visible to</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link
                    href={`/reports/custom/${r.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell>{label(r.object)}</TableCell>
                <TableCell>{users?.find((u) => u.id === r.ownerId)?.name ?? "—"}</TableCell>
                <TableCell>{r.shared ? "Everyone" : "Only the owner"}</TableCell>
                <TableCell>{formatDateTime(r.updatedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
