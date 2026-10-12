import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { ACTIVITY_TYPES } from "@/components/ActivityTimeline";
import {
  canUse,
  useApi,
  useMe,
  useOrgUsers,
  useStatuses,
  type Activity,
  type ActivityType,
} from "@/lib/api";
import { Bars, Panel, Stat } from "@/components/ReportBits";
import { formatDateTime, formatMoney } from "@/lib/utils";

interface Dashboard {
  owner: string;
  today: string;
  steps: { dueToday: number; overdue: number };
  todos: { dueToday: number; overdue: number };
  activityThisWeek: Record<ActivityType, number>;
  sequences: {
    inSequence: number;
    last30Days: {
      replied: number;
      meetingBooked: number;
      finished: number;
      optedOut: number;
    };
  };
  pipeline: {
    byStage: { stage: string; count: number; amount: number }[];
    closingThisMonth: { count: number; amount: number };
    wonLast30Days: { count: number; amount: number };
    lostLast30Days: { count: number; amount: number };
  };
  recentActivity: Activity[];
}

const PLURAL: Record<ActivityType, string> = {
  call: "Calls",
  email: "Emails",
  linkedin: "LinkedIn",
  meeting: "Meetings",
  note: "Notes",
};

const selectClass =
  "h-10 rounded-md border border-input bg-background px-3 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function DashboardPage() {
  const api = useApi();
  const { data: me } = useMe();
  const { data: users } = useOrgUsers();
  const { data: statuses } = useStatuses();
  const canSeeOthers = canUse(me, "sequences.manage_others");
  const [owner, setOwner] = useState("me");

  const dash = useQuery({
    queryKey: ["dashboard", owner],
    queryFn: () => api<Dashboard>("GET", `/api/dashboard?owner=${owner}`),
  });
  const d = dash.data;

  // Stages in the order set in Admin; weighted by each stage's win percentage.
  const stages = (statuses ?? []).filter(
    (s) => s.object === "opportunities" && s.effect !== "won" && s.effect !== "lost",
  );
  const stageRows = stages.map((s) => {
    const row = d?.pipeline.byStage.find((b) => b.stage === s.name);
    return {
      stage: s.name,
      probability: s.probability,
      count: row?.count ?? 0,
      amount: row?.amount ?? 0,
    };
  });
  const openTotal = stageRows.reduce((sum, r) => sum + r.amount, 0);
  const openCount = stageRows.reduce((sum, r) => sum + r.count, 0);
  const weighted = stageRows.reduce((sum, r) => sum + (r.amount * (r.probability ?? 0)) / 100, 0);
  const firstName = me?.user.name.split(" ")[0];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-background px-6 py-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {owner === "me" && firstName ? `Good to see you, ${firstName}` : "Dashboard"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Your day at a glance. Activity counts cover the last 7 days; outcomes the last 30.
          </p>
        </div>
        {canSeeOthers && (
          <select
            aria-label="Whose numbers"
            className={selectClass}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          >
            <option value="me">My numbers</option>
            <option value="all">Everyone</option>
            {(users ?? [])
              .filter((u) => u.id !== me?.user.id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        )}
      </div>

      {dash.error ? (
        <p className="p-8 text-center text-sm text-destructive">{dash.error.message}</p>
      ) : !d ? (
        <p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-4 p-6 lg:grid-cols-2">
          <Panel
            title="Your work"
            action={
              owner === "me" && (
                <Link
                  href="/sequences"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  Sequences <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              )
            }
          >
            <dl className="grid grid-cols-3 gap-4">
              <Stat label="Steps due today" value={String(d.steps.dueToday)} />
              <Stat
                label="Overdue steps"
                value={String(d.steps.overdue)}
                tone={d.steps.overdue > 0 ? "alert" : undefined}
              />
              <Stat label="People in a sequence" value={String(d.sequences.inSequence)} />
              <Stat label="To-dos due today" value={String(d.todos.dueToday)} />
              <Stat
                label="Overdue to-dos"
                value={String(d.todos.overdue)}
                tone={d.todos.overdue > 0 ? "alert" : undefined}
              />
              <span aria-hidden />
              <Stat
                label="Replies"
                value={String(d.sequences.last30Days.replied)}
                note="last 30 days"
              />
              <Stat
                label="Meetings booked"
                value={String(d.sequences.last30Days.meetingBooked)}
                note="last 30 days"
              />
              <Stat
                label="Finished, no reply"
                value={String(d.sequences.last30Days.finished)}
                note="last 30 days"
              />
            </dl>
          </Panel>

          <Panel title="Activity, last 7 days">
            <Bars
              empty="Nothing logged in the last 7 days."
              rows={ACTIVITY_TYPES.map((t) => ({
                label: PLURAL[t.value],
                value: d.activityThisWeek[t.value],
                display: String(d.activityThisWeek[t.value]),
                detail: `${t.label}: ${d.activityThisWeek[t.value]}`,
              }))}
            />
          </Panel>

          <Panel
            title="Open pipeline"
            action={
              <Link
                href="/opportunities"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                Board <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            }
          >
            <dl className="mb-5 grid grid-cols-3 gap-4">
              <Stat
                label="Open"
                value={formatMoney(openTotal)}
                note={`${openCount} opportunities`}
              />
              <Stat label="Weighted" value={formatMoney(weighted)} note="by stage %" />
              <Stat
                label="Closing this month"
                value={formatMoney(d.pipeline.closingThisMonth.amount)}
                note={`${d.pipeline.closingThisMonth.count} expected to close`}
              />
            </dl>
            <Bars
              empty="No open opportunities."
              rows={stageRows.map((r) => ({
                label: r.stage,
                value: r.amount,
                display: formatMoney(r.amount),
                detail: `${r.stage}: ${r.count} ${r.count === 1 ? "opportunity" : "opportunities"}, ${formatMoney(r.amount)}`,
              }))}
            />
          </Panel>

          <Panel title="Closed, last 30 days">
            <dl className="grid grid-cols-2 gap-4">
              <Stat
                label="Won"
                value={formatMoney(d.pipeline.wonLast30Days.amount)}
                note={`${d.pipeline.wonLast30Days.count} ${d.pipeline.wonLast30Days.count === 1 ? "deal" : "deals"}`}
              />
              <Stat
                label="Lost"
                value={formatMoney(d.pipeline.lostLast30Days.amount)}
                note={`${d.pipeline.lostLast30Days.count} ${d.pipeline.lostLast30Days.count === 1 ? "deal" : "deals"}`}
              />
            </dl>
            <h3 className="mb-2 mt-6 text-sm font-semibold">Latest activity</h3>
            {d.recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing logged yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {d.recentActivity.map((a) => {
                  const kind = ACTIVITY_TYPES.find((t) => t.value === a.type) ?? ACTIVITY_TYPES[4];
                  const Icon = kind.icon;
                  const who = a.personName ?? a.opportunityName ?? a.accountName;
                  const href = a.contactId
                    ? `/contacts/${a.contactId}`
                    : a.leadId
                      ? `/leads/${a.leadId}`
                      : a.opportunityId
                        ? `/opportunities/${a.opportunityId}`
                        : a.accountId
                          ? `/accounts/${a.accountId}`
                          : null;
                  return (
                    <li key={a.id} className="flex items-start gap-2 py-2">
                      <Icon
                        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                        aria-label={kind.label}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate">
                          {href ? (
                            <Link href={href} className="font-medium hover:underline">
                              {who}
                            </Link>
                          ) : (
                            <span className="font-medium">{who}</span>
                          )}
                          {a.subject && (
                            <span className="text-muted-foreground"> · {a.subject}</span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {owner !== "me" && `${a.ownerName ?? "Someone"} · `}
                          {formatDateTime(a.occurredAt)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
