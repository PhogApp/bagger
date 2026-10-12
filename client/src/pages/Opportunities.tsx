import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns3, List } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { ActivityTimeline } from "@/components/ActivityTimeline";
import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { StatusBadge, STATUS_TONES } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  permissionsFor,
  useApi,
  useMe,
  useOrgUsers,
  useStatuses,
  type StatusOption,
} from "@/lib/api";
import { cn, formatDay, formatMoney } from "@/lib/utils";
import { defaultStatus, nameOf, ownerField, statusColor, statusField } from "./shared";

interface Opportunity {
  id: string;
  ownerId: string;
  accountId: string;
  contactId: string | null;
  name: string;
  amount: string | null;
  closeDate: string | null;
  status: string;
  closedAt: string | null;
}
interface AccountRow {
  id: string;
  name: string;
}
interface ContactRow {
  id: string;
  accountId: string;
  firstName: string;
  lastName: string;
}

/** Closed deals stay on the board this long; the list view always shows them all. */
const CLOSED_DAYS_ON_BOARD = 30;
const isClosedStage = (stage: StatusOption) => stage.effect === "won" || stage.effect === "lost";
const total = (rows: Opportunity[]) => rows.reduce((sum, o) => sum + Number(o.amount ?? 0), 0);

export function OpportunitiesPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();
  const { data: statuses } = useStatuses();
  const [view, setView] = useState<"board" | "list">("board");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ["accounts", "for-picker"],
    queryFn: () => api<AccountRow[]>("GET", "/api/accounts?limit=500"),
  });
  const contacts = useQuery({
    queryKey: ["contacts", "for-picker"],
    queryFn: () => api<ContactRow[]>("GET", "/api/contacts?limit=500"),
  });
  const accountName = (id: string) => accounts.data?.find((a) => a.id === id)?.name ?? "—";

  const moveStage = useMutation({
    mutationFn: (move: { id: string; status: string }) =>
      api("PATCH", `/api/opportunities/${move.id}`, { status: move.status }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["opportunities"] }),
  });

  // An opportunity must belong to an account, so there has to be one first.
  if (accounts.data?.length === 0) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Opportunities</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every opportunity belongs to an account.{" "}
          <Link href="/accounts" className="text-primary underline">
            Add an account
          </Link>{" "}
          first, then come back to add opportunities.
        </p>
      </div>
    );
  }

  const stages = (statuses ?? []).filter((s) => s.object === "opportunities");
  const can = permissionsFor(me, "opportunities");

  const fields: Field[] = [
    { name: "name", label: "Opportunity Name", required: true, span: 6 },
    {
      name: "accountId",
      label: "Account",
      kind: "select",
      required: true,
      options: (accounts.data ?? []).map((a) => ({ value: a.id, label: a.name })),
    },
    {
      name: "contactId",
      label: "Main Contact",
      kind: "select",
      options: (contacts.data ?? []).map((c) => ({
        value: c.id,
        label: `${c.firstName} ${c.lastName} (${accountName(c.accountId)})`,
      })),
      help: "Someone at the account above.",
    },
    { name: "amount", label: "Amount", placeholder: "12500", span: 2 },
    { name: "closeDate", label: "Expected Close", kind: "date", span: 2 },
    { ...statusField(statuses, "opportunities"), label: "Stage", span: 2 },
    ownerField(users),
    { name: "notes", label: "Notes", kind: "textarea", span: 6 },
  ];

  const columns: Column<Opportunity>[] = [
    { header: "Opportunity", cell: (o) => <span className="font-medium">{o.name}</span> },
    { header: "Account", cell: (o) => accountName(o.accountId) },
    { header: "Amount", cell: (o) => (o.amount === null ? "—" : formatMoney(Number(o.amount))) },
    { header: "Expected Close", cell: (o) => (o.closeDate ? formatDay(o.closeDate) : "—") },
    { header: "Owner", cell: (o) => nameOf(users, o.ownerId) },
    {
      header: "Stage",
      cell: (o) => (
        <StatusBadge status={o.status} color={statusColor(statuses, "opportunities", o.status)} />
      ),
    },
  ];

  const board = (rows: Opportunity[], open: (row: Opportunity) => void) => {
    const cutoff = Date.now() - CLOSED_DAYS_ON_BOARD * 24 * 60 * 60 * 1000;
    const openStages = new Set(stages.filter((s) => !isClosedStage(s)).map((s) => s.name));
    const openDeals = rows.filter((o) => openStages.has(o.status));
    const weighted = openDeals.reduce(
      (sum, o) =>
        sum +
        (Number(o.amount ?? 0) * (stages.find((s) => s.name === o.status)?.probability ?? 0)) / 100,
      0,
    );
    return (
      <div>
        <dl className="flex flex-wrap gap-x-10 gap-y-2 border-b px-4 py-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Open opportunities</dt>
            <dd className="text-lg font-semibold">{openDeals.length}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Open pipeline</dt>
            <dd className="text-lg font-semibold">{formatMoney(total(openDeals))}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Weighted by stage</dt>
            <dd className="text-lg font-semibold">{formatMoney(weighted)}</dd>
          </div>
        </dl>
        <div className="flex gap-3 overflow-x-auto p-4">
          {stages.map((stage) => {
            const closed = isClosedStage(stage);
            const cards = rows.filter(
              (o) =>
                o.status === stage.name &&
                (!closed || !o.closedAt || new Date(o.closedAt).getTime() >= cutoff),
            );
            return (
              <section
                key={stage.id}
                aria-label={stage.name}
                className={cn(
                  "flex w-64 shrink-0 flex-col rounded-lg border bg-muted/40",
                  over === stage.name && "ring-2 ring-primary",
                )}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  setOver(stage.name);
                }}
                onDragLeave={() => setOver((current) => (current === stage.name ? null : current))}
                onDrop={(e) => {
                  e.preventDefault();
                  const moved = rows.find((o) => o.id === dragging);
                  if (moved && moved.status !== stage.name) {
                    moveStage.mutate({ id: moved.id, status: stage.name });
                  }
                  setDragging(null);
                  setOver(null);
                }}
              >
                <header className="border-b p-3">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={cn("h-3 w-3 rounded-full border", STATUS_TONES[stage.color])}
                    />
                    <h2 className="text-sm font-semibold">{stage.name}</h2>
                    <span className="ml-auto text-xs text-muted-foreground">{cards.length}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatMoney(total(cards))}
                    {closed
                      ? ` · last ${CLOSED_DAYS_ON_BOARD} days`
                      : stage.probability !== null && ` · ${stage.probability}%`}
                  </p>
                </header>
                <ul className="min-h-24 flex-1 space-y-2 p-2">
                  {cards.map((o) => (
                    <li key={o.id}>
                      <button
                        type="button"
                        draggable={can.canEdit(o.ownerId)}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = "move";
                          setDragging(o.id);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setOver(null);
                        }}
                        onClick={() => open(o)}
                        className={cn(
                          "w-full rounded-md border bg-background p-3 text-left text-sm shadow-sm",
                          "hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          dragging === o.id && "opacity-50",
                        )}
                      >
                        <span className="block font-medium">{o.name}</span>
                        <span className="block text-muted-foreground">
                          {accountName(o.accountId)}
                        </span>
                        <span className="mt-2 flex items-center justify-between">
                          <span className="font-medium">
                            {o.amount === null ? "No amount" : formatMoney(Number(o.amount))}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {o.closeDate ? formatDay(o.closeDate) : "No date"}
                          </span>
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {nameOf(users, o.ownerId)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
        {moveStage.error && (
          <p role="alert" className="px-4 pb-4 text-sm text-destructive">
            {moveStage.error.message}
          </p>
        )}
      </div>
    );
  };

  const toggle = (
    <div className="flex rounded-md border" role="group" aria-label="View">
      {(
        [
          ["board", "Board", Columns3],
          ["list", "List", List],
        ] as const
      ).map(([value, label, Icon]) => (
        <Button
          key={value}
          type="button"
          size="sm"
          variant={view === value ? "secondary" : "ghost"}
          aria-pressed={view === value}
          className="h-10 rounded-none first:rounded-l-md last:rounded-r-md"
          onClick={() => setView(value)}
        >
          <Icon className="mr-2 h-4 w-4" aria-hidden />
          {label}
        </Button>
      ))}
    </div>
  );

  return (
    <RecordPage<Opportunity>
      object="opportunities"
      recordType="opportunity"
      title="Opportunities"
      subtitle="Deals in your pipeline, by stage"
      singular="Opportunity"
      searchPlaceholder="Search opportunities by name…"
      fields={fields}
      columns={columns}
      defaults={{ status: defaultStatus(statuses, "opportunities"), ownerId: me?.user.id ?? "" }}
      headerActions={toggle}
      renderList={view === "board" ? board : undefined}
      tabs={[
        {
          value: "activity",
          label: "Activity",
          render: (r) => <ActivityTimeline about={{ opportunityId: r.id }} />,
        },
      ]}
      describe={(o) => o.name}
    />
  );
}
