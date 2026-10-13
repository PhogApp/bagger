import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useSearch } from "wouter";
import { SavedReports } from "./ReportBuilder";
import { ACTIVITY_TYPES } from "@/components/ActivityTimeline";
import { Bars, Panel, Stat } from "@/components/ReportBits";
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
import { canUse, useApi, useMe, useOrgUsers, useStatuses, type ActivityType } from "@/lib/api";
import { cn, formatDay, formatMoney } from "@/lib/utils";

/**
 * Reports: sequence performance, rep activity, pipeline and lead conversion,
 * for a date range and a rep. Every table can be downloaded as a CSV file by
 * roles allowed to export.
 */

type Tab = "sequences" | "activity" | "pipeline" | "conversion" | "custom";
const TABS: { value: Tab; label: string }[] = [
  { value: "custom", label: "Custom reports" },
  { value: "sequences", label: "Sequences" },
  { value: "activity", label: "Activity" },
  { value: "pipeline", label: "Pipeline" },
  { value: "conversion", label: "Lead conversion" },
];

const selectClass =
  "h-10 rounded-md border border-input bg-background px-3 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Date ranges people usually want, as [from, to] calendar days. */
function preset(name: string): [string, string] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const daysAgo = (n: number) => new Date(y, m, now.getDate() - n);
  switch (name) {
    case "last30":
      return [iso(daysAgo(29)), iso(now)];
    case "last90":
      return [iso(daysAgo(89)), iso(now)];
    case "lastMonth":
      return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case "quarter":
      return [iso(new Date(y, m - (m % 3), 1)), iso(now)];
    case "year":
      return [iso(new Date(y, 0, 1)), iso(now)];
    default:
      return [iso(new Date(y, m, 1)), iso(now)];
  }
}
const PRESETS = [
  { value: "month", label: "This month" },
  { value: "lastMonth", label: "Last month" },
  { value: "last30", label: "Last 30 days" },
  { value: "quarter", label: "This quarter" },
  { value: "last90", label: "Last 90 days" },
  { value: "year", label: "This year" },
  { value: "custom", label: "Custom dates" },
];

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const days = (v: number | null) =>
  v === null ? "—" : v < 1 ? "under a day" : `${v.toFixed(v < 10 ? 1 : 0)} days`;

/** Save rows as a CSV file the browser downloads. */
function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const cell = (v: string | number | null) => {
    const text = v === null ? "" : String(v);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = rows.map((r) => r.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function SimpleTable(props: {
  headers: string[];
  rows: ReactNode[][];
  empty: string;
  numeric?: number[];
}) {
  if (props.rows.length === 0)
    return <p className="text-sm text-muted-foreground">{props.empty}</p>;
  const right = new Set(props.numeric ?? []);
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {props.headers.map((h, i) => (
              <TableHead key={h} className={cn(right.has(i) && "text-right")}>
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.rows.map((r, i) => (
            <TableRow key={i}>
              {r.map((c, j) => (
                <TableCell key={j} className={cn(right.has(j) && "text-right tabular-nums")}>
                  {c}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function ReportsPage() {
  const api = useApi();
  const { data: me } = useMe();
  const { data: users } = useOrgUsers();
  const { data: statuses } = useStatuses();
  // ?tab=custom opens straight onto the saved reports.
  const [tab, setTab] = useState<Tab>(
    new URLSearchParams(useSearch()).get("tab") === "custom" ? "custom" : "sequences",
  );
  const [range, setRange] = useState("month");
  const [[from, to], setDates] = useState(preset("month"));
  const [owner, setOwner] = useState("me");
  const [interval, setBucket] = useState<"day" | "week" | "month">("week");
  const canSeeOthers = canUse(me, "sequences.manage_others");
  const canExport = canUse(me, "data.export_lists");
  const nameOf = (id: string) => users?.find((u) => u.id === id)?.name ?? "Former user";

  const query = `from=${from}&to=${to}&owner=${owner}${tab === "activity" ? `&interval=${interval}` : ""}`;
  const report = useQuery({
    queryKey: ["reports", tab, query],
    queryFn: () => api<unknown>("GET", `/api/reports/${tab}?${query}`),
    enabled: from <= to && tab !== "custom",
  });
  const fileName = `bagger-${tab}-${from}-to-${to}`;

  const exportButton = (rows: () => (string | number | null)[][]) =>
    canExport ? (
      <Button type="button" size="sm" variant="ghost" onClick={() => downloadCsv(fileName, rows())}>
        <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        CSV
      </Button>
    ) : undefined;

  let body: ReactNode = null;
  if (report.data && tab === "sequences") {
    const d = report.data as SequenceData;
    body = (
      <Panel
        title="Sequence performance"
        action={exportButton(() => [
          [
            "Sequence",
            "Step",
            "Enrolled",
            "In sequence now",
            "Replied",
            "Meetings",
            "Finished",
            "Opted out",
            "Stopped",
            "Response rate",
            "Completed",
            "Skipped",
          ],
          ...d.sequences.flatMap((q) => [
            [
              q.name,
              "",
              q.enrolled,
              q.active,
              q.replied,
              q.meetingBooked,
              q.finished,
              q.optedOut,
              q.stopped,
              q.responseRate === null ? null : Math.round(q.responseRate * 100) / 100,
              null,
              null,
            ],
            ...q.steps.map((st) => [
              q.name,
              `${st.position}. ${st.title}`,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              st.completed,
              st.skipped,
            ]),
          ]),
        ])}
      >
        {d.sequences.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sequence activity in this range.</p>
        ) : (
          <div className="space-y-6">
            {d.sequences.map((q) => (
              <div key={q.id}>
                <h3 className="text-sm font-semibold">
                  {q.name}
                  {!q.isActive && (
                    <span className="ml-2 font-normal text-muted-foreground">inactive</span>
                  )}
                </h3>
                <dl className="mt-2 grid grid-cols-3 gap-4 sm:grid-cols-6">
                  <Stat label="Enrolled" value={String(q.enrolled)} />
                  <Stat label="In it now" value={String(q.active)} />
                  <Stat label="Replied" value={String(q.replied)} />
                  <Stat label="Meetings" value={String(q.meetingBooked)} />
                  <Stat label="Finished" value={String(q.finished)} note="no reply" />
                  <Stat
                    label="Response rate"
                    value={pct(q.responseRate)}
                    note="of those who ended"
                  />
                </dl>
                <div className="mt-3">
                  <SimpleTable
                    headers={["Step", "Completed", "Skipped", "Skipped share"]}
                    numeric={[1, 2, 3]}
                    empty="This sequence has no steps."
                    rows={q.steps.map((st) => [
                      `${st.position}. ${st.title}`,
                      st.completed,
                      st.skipped,
                      st.completed + st.skipped > 0
                        ? pct(st.skipped / (st.completed + st.skipped))
                        : "—",
                    ])}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    );
  } else if (report.data && tab === "activity") {
    const d = report.data as ActivityData;
    const total = (r: Partial<Record<ActivityType, number>>) =>
      ACTIVITY_TYPES.reduce((t, a) => t + (r[a.value] ?? 0), 0);
    const periodLabel = (p: string) =>
      interval === "month"
        ? new Date(`${p}T12:00:00`).toLocaleDateString(undefined, {
            month: "short",
            year: "numeric",
          })
        : interval === "week"
          ? `Week of ${new Date(`${p}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
          : formatDay(p);
    body = (
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="By rep"
          action={exportButton(() => [
            ["Rep", ...ACTIVITY_TYPES.map((a) => a.label), "Total"],
            ...d.byRep.map((r) => [
              nameOf(r.ownerId),
              ...ACTIVITY_TYPES.map((a) => r[a.value] ?? 0),
              total(r),
            ]),
          ])}
        >
          <SimpleTable
            headers={["Rep", ...ACTIVITY_TYPES.map((a) => a.label), "Total"]}
            numeric={[1, 2, 3, 4, 5, 6]}
            empty="Nothing logged in this range."
            rows={d.byRep
              .sort((a, b) => total(b) - total(a))
              .map((r) => [
                nameOf(r.ownerId),
                ...ACTIVITY_TYPES.map((a) => r[a.value] ?? 0),
                <strong key="t">{total(r)}</strong>,
              ])}
          />
        </Panel>
        <Panel
          title="Over time"
          action={
            <div className="flex items-center gap-2">
              <select
                aria-label="Group by"
                className={cn(selectClass, "h-8")}
                value={interval}
                onChange={(e) => setBucket(e.target.value as typeof interval)}
              >
                <option value="day">By day</option>
                <option value="week">By week</option>
                <option value="month">By month</option>
              </select>
              {exportButton(() => [
                ["Period", ...ACTIVITY_TYPES.map((a) => a.label), "Total"],
                ...d.overTime.map((r) => [
                  r.period,
                  ...ACTIVITY_TYPES.map((a) => r[a.value] ?? 0),
                  total(r),
                ]),
              ])}
            </div>
          }
        >
          <Bars
            empty="Nothing logged in this range."
            rows={d.overTime.map((r) => ({
              label: periodLabel(r.period),
              value: total(r),
              display: String(total(r)),
              detail: ACTIVITY_TYPES.map((a) => `${a.label}: ${r[a.value] ?? 0}`).join(", "),
            }))}
          />
        </Panel>
      </div>
    );
  } else if (report.data && tab === "pipeline") {
    const d = report.data as PipelineData;
    const stages = (statuses ?? []).filter(
      (s) => s.object === "opportunities" && s.effect !== "won" && s.effect !== "lost",
    );
    const byStage = stages.map((s) => {
      const rows = d.open.filter((o) => o.stage === s.name);
      const amount = rows.reduce((t, r) => t + r.amount, 0);
      return {
        stage: s.name,
        count: rows.reduce((t, r) => t + r.count, 0),
        amount,
        weighted: (amount * (s.probability ?? 0)) / 100,
      };
    });
    const openTotal = byStage.reduce((t, r) => t + r.amount, 0);
    const weighted = byStage.reduce((t, r) => t + r.weighted, 0);
    body = (
      <div className="space-y-4">
        <Panel title="Summary">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Open pipeline" value={formatMoney(openTotal)} note="right now" />
            <Stat label="Weighted" value={formatMoney(weighted)} note="by stage %" />
            <Stat
              label="Won"
              value={formatMoney(d.closed.wonAmount)}
              note={`${d.closed.won} in range`}
            />
            <Stat
              label="Win rate"
              value={pct(d.closed.winRate)}
              note={`${d.closed.won} won, ${d.closed.lost} lost`}
            />
            <Stat
              label="Average won deal"
              value={d.closed.averageWon === null ? "—" : formatMoney(d.closed.averageWon)}
            />
            <Stat
              label="Time to win"
              value={days(d.closed.averageDaysToWin)}
              note="created to won"
            />
          </dl>
        </Panel>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Open deals by stage"
            action={exportButton(() => [
              ["Stage", "Deals", "Amount", "Weighted"],
              ...byStage.map((r) => [r.stage, r.count, r.amount, Math.round(r.weighted)]),
            ])}
          >
            <Bars
              empty="No open deals."
              rows={byStage.map((r) => ({
                label: r.stage,
                value: r.amount,
                display: formatMoney(r.amount),
                detail: `${r.stage}: ${r.count} ${r.count === 1 ? "deal" : "deals"}, ${formatMoney(r.amount)}, weighted ${formatMoney(r.weighted)}`,
              }))}
            />
          </Panel>
          <Panel
            title="Average time in each stage"
            action={exportButton(() => [
              ["Stage", "Entries in range", "Average days"],
              ...d.timeInStage.map((t) => [
                t.stage,
                t.entries,
                Math.round(t.averageDays * 10) / 10,
              ]),
            ])}
          >
            <SimpleTable
              headers={["Stage", "Entered", "Average stay"]}
              numeric={[1, 2]}
              empty="No stage moves in this range."
              // Closed stages are where deals end up, so a "stay" there isn't meaningful.
              rows={stages
                .map((s) => d.timeInStage.find((t) => t.stage === s.name))
                .filter((t): t is PipelineData["timeInStage"][number] => Boolean(t))
                .map((t) => [t.stage, t.entries, days(t.averageDays)])}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              For deals that entered a stage in this range. A deal still in its stage counts up to
              today.
            </p>
          </Panel>
        </div>
        {owner === "all" && (
          <Panel
            title="By rep"
            action={exportButton(() => [
              ["Rep", "Open deals", "Open amount", "Won", "Lost", "Won amount", "Win rate"],
              ...d.byRep.map((r) => [
                nameOf(r.ownerId),
                r.openCount,
                r.openAmount,
                r.won,
                r.lost,
                r.wonAmount,
                r.winRate === null ? null : Math.round(r.winRate * 100) / 100,
              ]),
            ])}
          >
            <SimpleTable
              headers={[
                "Rep",
                "Open deals",
                "Open amount",
                "Won",
                "Lost",
                "Won amount",
                "Win rate",
              ]}
              numeric={[1, 2, 3, 4, 5, 6]}
              empty="No deals."
              rows={d.byRep.map((r) => [
                nameOf(r.ownerId),
                r.openCount,
                formatMoney(r.openAmount),
                r.won,
                r.lost,
                formatMoney(r.wonAmount),
                pct(r.winRate),
              ])}
            />
          </Panel>
        )}
      </div>
    );
  } else if (report.data && tab === "conversion") {
    const d = report.data as ConversionData;
    body = (
      <div className="space-y-4">
        <Panel title="Summary">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Leads created" value={String(d.created)} />
            <Stat label="Leads converted" value={String(d.converted)} note="in range" />
            <Stat
              label="Conversion rate"
              value={pct(d.conversionRate)}
              note="of leads created in range"
            />
            <Stat
              label="Time to convert"
              value={days(d.averageDaysToConvert)}
              note="created to converted"
            />
          </dl>
        </Panel>
        <Panel
          title="By rep"
          action={exportButton(() => [
            ["Rep", "Created", "Converted", "Conversion rate", "Average days to convert"],
            ...d.byRep.map((r) => [
              nameOf(r.ownerId),
              r.created,
              r.converted,
              r.conversionRate === null ? null : Math.round(r.conversionRate * 100) / 100,
              r.averageDaysToConvert === null ? null : Math.round(r.averageDaysToConvert * 10) / 10,
            ]),
          ])}
        >
          <SimpleTable
            headers={["Rep", "Created", "Converted", "Conversion rate", "Time to convert"]}
            numeric={[1, 2, 3, 4]}
            empty="No leads created or converted in this range."
            rows={d.byRep.map((r) => [
              nameOf(r.ownerId),
              r.created,
              r.converted,
              pct(r.conversionRate),
              days(r.averageDaysToConvert),
            ])}
          />
        </Panel>
      </div>
    );
  }

  return (
    <div>
      <div className="border-b bg-background px-6 py-4">
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        {tab !== "custom" && (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label htmlFor="report-range" className="text-xs font-medium text-muted-foreground">
                Dates
              </label>
              <select
                id="report-range"
                className={cn(selectClass, "block")}
                value={range}
                onChange={(e) => {
                  setRange(e.target.value);
                  if (e.target.value !== "custom") setDates(preset(e.target.value));
                }}
              >
                {PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor="report-from" className="text-xs font-medium text-muted-foreground">
                From
              </label>
              <Input
                id="report-from"
                type="date"
                className="w-40"
                value={from}
                onChange={(e) => {
                  setRange("custom");
                  setDates([e.target.value, to]);
                }}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="report-to" className="text-xs font-medium text-muted-foreground">
                To
              </label>
              <Input
                id="report-to"
                type="date"
                className="w-40"
                value={to}
                onChange={(e) => {
                  setRange("custom");
                  setDates([from, e.target.value]);
                }}
              />
            </div>
            {canSeeOthers && (
              <div className="space-y-1">
                <label htmlFor="report-owner" className="text-xs font-medium text-muted-foreground">
                  Whose numbers
                </label>
                <select
                  id="report-owner"
                  className={cn(selectClass, "block")}
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                >
                  <option value="me">Mine</option>
                  <option value="all">Everyone</option>
                  {(users ?? [])
                    .filter((u) => u.id !== me?.user.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                </select>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b bg-background px-6" role="tablist" aria-label="Report">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setTab(t.value)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2.5 text-sm font-medium",
              tab === t.value
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-6">
        {tab === "custom" ? (
          <SavedReports />
        ) : from > to ? (
          <p className="text-sm text-destructive">The start date is after the end date.</p>
        ) : report.error ? (
          <p className="text-sm text-destructive">{report.error.message}</p>
        ) : report.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          body
        )}
      </div>
    </div>
  );
}

interface SequenceData {
  sequences: {
    id: string;
    name: string;
    isActive: boolean;
    enrolled: number;
    active: number;
    finished: number;
    replied: number;
    meetingBooked: number;
    optedOut: number;
    stopped: number;
    responseRate: number | null;
    steps: { id: string; position: number; title: string; completed: number; skipped: number }[];
  }[];
}
type Counts = Partial<Record<ActivityType, number>>;
interface ActivityData {
  byRep: ({ ownerId: string } & Counts)[];
  overTime: ({ period: string } & Counts)[];
}
interface PipelineData {
  open: { stage: string; ownerId: string; count: number; amount: number }[];
  closed: {
    won: number;
    lost: number;
    wonAmount: number;
    lostAmount: number;
    winRate: number | null;
    averageWon: number | null;
    averageDaysToWin: number | null;
  };
  byRep: {
    ownerId: string;
    openCount: number;
    openAmount: number;
    won: number;
    lost: number;
    wonAmount: number;
    winRate: number | null;
  }[];
  timeInStage: { stage: string; entries: number; averageDays: number }[];
}
interface ConversionData {
  created: number;
  converted: number;
  conversionRate: number | null;
  averageDaysToConvert: number | null;
  byRep: {
    ownerId: string;
    created: number;
    converted: number;
    conversionRate: number | null;
    averageDaysToConvert: number | null;
  }[];
}
