import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import type { Column } from "@/components/RecordPage";
import { useApi } from "@/lib/api";
import { cn, formatDate, formatDay } from "@/lib/utils";

/**
 * Where people are in their sequences and where they've been: the list
 * columns, the list filter, and the Sequences section on a record's page.
 */

export interface SequenceRun {
  enrollmentId: string;
  sequenceId: string;
  sequenceName: string;
  state: "active" | "paused" | "ended";
  endReason: EndReason | null;
  enrolledAt: string;
  endedAt: string | null;
  ownerId: string;
  step: number | null;
  steps: number;
  stepsDone: number;
  nextDueOn: string | null;
  person: { leadId: string | null; contactId: string | null; name: string };
  asLead: boolean;
}

export interface SequenceSummary {
  current: SequenceRun | null;
  inNow: number;
  last: SequenceRun | null;
  total: number;
  recent: SequenceRun[];
}

export type EndReason =
  | "finished"
  | "replied"
  | "meeting_booked"
  | "opted_out"
  | "bounced"
  | "status_change"
  | "removed"
  | "converted";

type Tone = "good" | "neutral" | "stop";

/** How each ending reads, and whether it's good news, neutral, or a reason to stop. */
export const OUTCOMES: Record<EndReason, { label: string; tone: Tone }> = {
  replied: { label: "Replied", tone: "good" },
  meeting_booked: { label: "Meeting booked", tone: "good" },
  converted: { label: "Converted", tone: "good" },
  finished: { label: "Finished all steps", tone: "neutral" },
  removed: { label: "Removed", tone: "neutral" },
  status_change: { label: "Status changed", tone: "stop" },
  opted_out: { label: "Opted out", tone: "stop" },
  bounced: { label: "Bounced", tone: "stop" },
};

/** The order the filter offers them in. */
export const OUTCOME_ORDER: EndReason[] = [
  "finished",
  "replied",
  "meeting_booked",
  "converted",
  "removed",
  "status_change",
  "opted_out",
  "bounced",
];

const TONES: Record<Tone | "live" | "paused", string> = {
  live: "bg-brand-ocean/15 text-brand-deep",
  paused: "bg-brand-mauve/25 text-[#4d3f48]",
  good: "bg-brand-teal/20 text-brand-deep",
  neutral: "bg-slate-100 text-slate-700",
  stop: "bg-brand-rose/30 text-[#6e3536]",
};

function Chip({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export const outcomeLabel = (r: EndReason | null) => (r ? OUTCOMES[r].label : "Ended");

/** "Step 3 of 7" for a live run. */
const stepText = (r: SequenceRun) => (r.step ? `Step ${r.step} of ${r.steps}` : "");

/** One line for a run: where it stands now, or how it ended. */
export function runText(r: SequenceRun): string {
  if (r.state === "paused")
    return `${r.sequenceName} · Paused${r.step ? ` at step ${r.step}` : ""}`;
  if (r.state === "active") return [r.sequenceName, stepText(r)].filter(Boolean).join(" · ");
  return `${r.sequenceName} · ${outcomeLabel(r.endReason)} · ${formatDate(r.endedAt!)}`;
}

const Muted = () => <span className="text-muted-foreground">—</span>;

/** The "Sequence" column on Leads and Contacts: the one they're in now. */
export function CurrentSequenceCell({ summary }: { summary?: SequenceSummary }) {
  const r = summary?.current;
  if (!r) return <Muted />;
  return (
    <div className="min-w-0 max-w-[13rem]">
      <div className="flex items-center gap-1.5">
        <span className="truncate font-medium" title={r.sequenceName}>
          {r.sequenceName}
        </span>
        {r.state === "paused" && <Chip tone="paused">Paused</Chip>}
      </div>
      <div className="text-xs text-muted-foreground">
        {[stepText(r), r.state === "active" && r.nextDueOn && `due ${formatDay(r.nextDueOn)}`]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </div>
  );
}

/** The "Last sequence" column: the most recent one that ended, and how. */
export function LastSequenceCell({ summary }: { summary?: SequenceSummary }) {
  const r = summary?.last;
  if (!r) return <Muted />;
  const tone = r.endReason ? OUTCOMES[r.endReason].tone : "neutral";
  return (
    <div className="min-w-0 max-w-[13rem]">
      <div className="truncate" title={r.sequenceName}>
        {r.sequenceName}
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Chip tone={tone}>{outcomeLabel(r.endReason)}</Chip>
        {formatDate(r.endedAt!)}
      </div>
    </div>
  );
}

/**
 * How many sequences, with the most recent ones listed on hover or focus.
 * For an account, also how many of its people are in one now.
 */
export function SequenceCountCell({
  summary,
  account = false,
}: {
  summary?: SequenceSummary;
  account?: boolean;
}) {
  // Placed against the window, so the table's scrolling edge can't cut it off.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  if (!summary || summary.total === 0) return <Muted />;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const label = account
    ? summary.inNow > 0
      ? `${plural(summary.inNow, "person", "people")} in one now`
      : plural(summary.total, "sequence", "sequences")
    : `${summary.total}`;
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 344)) });
  };
  return (
    <span
      className="inline-block"
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setAt(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setAt(null)}
    >
      <button
        type="button"
        className="rounded text-left underline decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={(e) => e.stopPropagation()}
        aria-label={`${plural(summary.total, "sequence", "sequences")}: ${label}`}
      >
        {label}
      </button>
      {at && (
        <span
          role="tooltip"
          style={{ top: at.top, left: at.left }}
          className="fixed z-50 w-[21rem] rounded-md border bg-background p-2 text-xs shadow-lg"
        >
          <span className="mb-1 block font-medium">
            {plural(summary.total, "sequence", "sequences")}
            {summary.total > summary.recent.length && `, latest ${summary.recent.length}`}
          </span>
          {summary.recent.map((r) => (
            <span key={r.enrollmentId} className="block py-0.5">
              {account && <span className="font-medium">{r.person.name}: </span>}
              {runText(r)}
              {account && r.asLead && <span className="text-muted-foreground"> (as a lead)</span>}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** Text for a CSV export. */
export const csvCurrent = (s?: SequenceSummary) => (s?.current ? runText(s.current) : "");
export const csvLast = (s?: SequenceSummary) => (s?.last ? runText(s.last) : "");

/** The sequence columns on Leads and Contacts. */
export function sequenceColumns<T extends object>(): Column<T>[] {
  const of = (row: T) => (row as { sequences?: SequenceSummary }).sequences;
  return [
    {
      key: "sequence",
      header: "Sequence",
      sort: "sequence",
      fresh: true,
      csv: (row) => csvCurrent(of(row)),
      cell: (row) => <CurrentSequenceCell summary={of(row)} />,
    },
    {
      key: "lastSequence",
      header: "Last sequence",
      sort: "lastSequence",
      fresh: true,
      csv: (row) => csvLast(of(row)),
      cell: (row) => <LastSequenceCell summary={of(row)} />,
    },
    {
      key: "sequenceCount",
      header: "Sequences",
      hidden: true,
      csv: (row) => of(row)?.total ?? 0,
      cell: (row) => <SequenceCountCell summary={of(row)} />,
    },
  ];
}

/** The Sequences section on a lead's, contact's or account's page. */
export function SequenceHistory({
  kind,
  id,
}: {
  kind: "leads" | "contacts" | "accounts";
  id: string;
}) {
  const api = useApi();
  const runs = useQuery({
    queryKey: ["sequence-history", kind, id],
    queryFn: () => api<SequenceRun[]>("GET", `/api/${kind}/${id}/sequences`),
  });
  const account = kind === "accounts";
  return (
    <section className="rounded-lg border bg-background p-5">
      <h2 className="mb-3 text-sm font-semibold">Sequences</h2>
      {runs.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : runs.error ? (
        <p className="text-sm text-destructive">{runs.error.message}</p>
      ) : !runs.data?.length ? (
        <p className="text-sm text-muted-foreground">
          {account ? "Nobody at this account has been in a sequence." : "Never been in a sequence."}
        </p>
      ) : (
        <ol className="space-y-3">
          {runs.data.map((r) => (
            <li key={r.enrollmentId} className="flex gap-3">
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  r.state === "active"
                    ? "bg-brand-ocean"
                    : r.state === "paused"
                      ? "bg-brand-mauve"
                      : r.endReason && OUTCOMES[r.endReason].tone === "good"
                        ? "bg-brand-teal"
                        : r.endReason && OUTCOMES[r.endReason].tone === "stop"
                          ? "bg-brand-rose"
                          : "bg-slate-300",
                )}
              />
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link href={`/sequences/${r.sequenceId}`} className="font-medium hover:underline">
                    {r.sequenceName}
                  </Link>
                  {r.state === "active" ? (
                    <Chip tone="live">In progress</Chip>
                  ) : r.state === "paused" ? (
                    <Chip tone="paused">Paused</Chip>
                  ) : (
                    <Chip tone={r.endReason ? OUTCOMES[r.endReason].tone : "neutral"}>
                      {outcomeLabel(r.endReason)}
                    </Chip>
                  )}
                </div>
                {account && (
                  <div className="text-xs">
                    <Link
                      href={
                        r.person.contactId
                          ? `/contacts/${r.person.contactId}`
                          : `/leads/${r.person.leadId}`
                      }
                      className="text-primary hover:underline"
                    >
                      {r.person.name}
                    </Link>
                    {r.asLead && <span className="text-muted-foreground"> · as a lead</span>}
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  {r.state === "ended"
                    ? `${formatDate(r.enrolledAt)} – ${formatDate(r.endedAt!)} · ${r.stepsDone} of ${r.steps} steps done`
                    : [
                        `Started ${formatDate(r.enrolledAt)}`,
                        stepText(r),
                        r.state === "active" && r.nextDueOn && `next due ${formatDay(r.nextDueOn)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
