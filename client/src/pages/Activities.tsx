import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "wouter";
import {
  ActivityDialog,
  ActivityStatusBadge,
  ACTIVITY_TYPES,
  relatedOf,
  typeOf,
  useCompleteActivity,
} from "@/components/ActivityTimeline";
import {
  BulkChanges,
  ColumnPicker,
  downloadCsv,
  ExportButton,
  OwnerFilter,
  Pager,
  StatusFilter,
  useListPrefs,
  type StatusChoice,
} from "@/components/ListTools";
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
import {
  canUse,
  permissionsFor,
  useApi,
  useMe,
  useOrgUsers,
  type Activity,
  type ActivityStatus,
} from "@/lib/api";
import { cn, formatDateTime, formatDay } from "@/lib/utils";

/**
 * Every activity in one list: open ones still to do and completed ones, each
 * linked to the lead, contact, account or opportunity it is about. Same tools
 * as the other lists: search, filters, sorting, columns, paging, bulk changes
 * and export.
 */

const STATUS_CHOICES: StatusChoice[] = [
  { id: "open", name: "Open", value: "open" },
  { id: "overdue", name: "Overdue", value: "overdue" },
  { id: "completed", name: "Completed", value: "completed" },
];
const BULK_STATUSES: StatusChoice[] = [
  { id: "completed", name: "Completed", value: "completed" },
  { id: "open", name: "Open", value: "open" },
];
const TYPE_CHOICES: StatusChoice[] = ACTIVITY_TYPES.map((t) => ({
  id: t.value,
  name: t.label,
  value: t.value,
}));

interface Column {
  key: string;
  header: string;
  sort?: string;
  hidden?: boolean;
  cell: (a: Activity) => ReactNode;
  csv: (a: Activity) => string | null | undefined;
}

/** A link to a record that doesn't also open the activity under it. */
function RecordLink({ path, children }: { path: string; children: ReactNode }) {
  return (
    <Link
      href={path}
      className="text-primary hover:underline"
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
    >
      {children}
    </Link>
  );
}

const COLUMNS: Column[] = [
  {
    key: "status",
    header: "Status",
    sort: "status",
    cell: (a) => <ActivityStatusBadge a={a} />,
    csv: (a) => (a.status === "completed" ? "Completed" : a.overdue ? "Overdue" : "Open"),
  },
  {
    key: "type",
    header: "Type",
    sort: "type",
    cell: (a) => typeOf(a).label,
    csv: (a) => typeOf(a).label,
  },
  {
    key: "subject",
    header: "Subject",
    sort: "subject",
    cell: (a) => <span className="font-medium">{a.subject ?? "—"}</span>,
    csv: (a) => a.subject,
  },
  {
    key: "related",
    header: "Related to",
    cell: (a) => {
      const r = relatedOf(a);
      return r ? <RecordLink path={r.path}>{r.label}</RecordLink> : "—";
    },
    csv: (a) => relatedOf(a)?.label,
  },
  {
    key: "person",
    header: "Person",
    sort: "person",
    hidden: true,
    cell: (a) =>
      a.personName ? (
        <RecordLink path={a.contactId ? `/contacts/${a.contactId}` : `/leads/${a.leadId}`}>
          {a.personName}
        </RecordLink>
      ) : (
        "—"
      ),
    csv: (a) => a.personName,
  },
  {
    key: "account",
    header: "Account",
    sort: "account",
    cell: (a) =>
      a.accountId ? (
        <RecordLink path={`/accounts/${a.accountId}`}>{a.accountName}</RecordLink>
      ) : (
        "—"
      ),
    csv: (a) => a.accountName,
  },
  {
    key: "opportunity",
    header: "Opportunity",
    sort: "opportunity",
    hidden: true,
    cell: (a) =>
      a.opportunityId ? (
        <RecordLink path={`/opportunities/${a.opportunityId}`}>{a.opportunityName}</RecordLink>
      ) : (
        "—"
      ),
    csv: (a) => a.opportunityName,
  },
  {
    key: "dueOn",
    header: "Due",
    sort: "dueOn",
    cell: (a) =>
      a.dueOn ? (
        <span className={cn(a.overdue && "font-medium text-destructive")}>
          {formatDay(a.dueOn)}
        </span>
      ) : (
        "—"
      ),
    csv: (a) => a.dueOn,
  },
  {
    key: "occurredAt",
    header: "Completed",
    sort: "occurredAt",
    cell: (a) => (a.occurredAt ? formatDateTime(a.occurredAt) : "—"),
    csv: (a) => a.occurredAt,
  },
  {
    key: "owner",
    header: "Owner",
    sort: "owner",
    cell: (a) => a.ownerName ?? "—",
    csv: (a) => a.ownerName,
  },
  {
    key: "body",
    header: "Notes",
    hidden: true,
    cell: (a) => <span className="line-clamp-2 text-muted-foreground">{a.body ?? ""}</span>,
    csv: (a) => a.body,
  },
  {
    key: "fromSequence",
    header: "From a sequence",
    hidden: true,
    cell: (a) => (a.fromSequence ? "Yes" : ""),
    csv: (a) => (a.fromSequence ? "Yes" : ""),
  },
];

export function ActivitiesPage() {
  const api = useApi();
  const { data: me } = useMe();
  const { data: users } = useOrgUsers();
  const can = permissionsFor(me, "activities");
  const [prefs, setPrefs] = useListPrefs("activities");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const [offset, setOffset] = useState(0);

  const listParams = new URLSearchParams({
    withTotal: "1",
    limit: String(prefs.pageSize),
    offset: String(offset),
  });
  if (q) listParams.set("q", q);
  if (prefs.sort) {
    listParams.set("sort", prefs.sort);
    listParams.set("dir", prefs.dir);
  }
  if (prefs.owner) listParams.set("owner", prefs.owner);
  for (const st of prefs.statuses) {
    if (STATUS_CHOICES.some((c) => c.value === st)) listParams.append("status", st);
  }
  for (const t of prefs.types ?? []) listParams.append("type", t);
  const query = listParams.toString();
  useEffect(
    () => setOffset(0),
    [
      q,
      prefs.sort,
      prefs.dir,
      prefs.owner,
      prefs.statuses.join("|"),
      (prefs.types ?? []).join("|"),
      prefs.pageSize,
    ],
  );

  const list = useQuery({
    queryKey: ["activities", "list", query],
    queryFn: () => api<{ rows: Activity[]; total: number }>("GET", `/api/activities?${query}`),
    placeholderData: (previous) => previous,
  });
  const rows = list.data?.rows ?? [];
  const complete = useCompleteActivity();

  const shownIds = prefs.columns ?? COLUMNS.filter((c) => !c.hidden).map((c) => c.key);
  const columns = shownIds
    .map((id) => COLUMNS.find((c) => c.key === id))
    .filter((c): c is Column => Boolean(c));
  const sortBy = (c: Column) => {
    if (!c.sort) return;
    setPrefs({ sort: c.sort, dir: prefs.sort === c.sort && prefs.dir === "asc" ? "desc" : "asc" });
  };

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const selected = rows.filter((r) => checked.has(r.id));
  const allChecked = rows.length > 0 && selected.length === rows.length;
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const canExport = canUse(me, "data.export_lists");
  const [exporting, setExporting] = useState(false);
  const exportRows = (chosen: Activity[]) =>
    downloadCsv(`bagger-activities-${new Date().toISOString().slice(0, 10)}`, [
      columns.map((c) => c.header),
      ...chosen.map((a) => columns.map((c) => c.csv(a))),
    ]);
  const exportAll = async () => {
    setExporting(true);
    try {
      const all: Activity[] = [];
      for (let from = 0; from < 50000; from += 500) {
        const next = new URLSearchParams(listParams);
        next.set("limit", "500");
        next.set("offset", String(from));
        const page = await api<{ rows: Activity[]; total: number }>(
          "GET",
          `/api/activities?${next}`,
        );
        all.push(...page.rows);
        if (all.length >= page.total || page.rows.length === 0) break;
      }
      exportRows(all);
    } finally {
      setExporting(false);
    }
  };

  const [dialog, setDialog] = useState<{ activity?: Activity; startAs?: ActivityStatus } | null>(
    null,
  );
  const filtered = Boolean(q || prefs.owner || prefs.statuses.length || prefs.types?.length);

  return (
    <div>
      <div className="flex items-center justify-between border-b bg-background px-6 py-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Activities</h1>
          <p className="text-sm text-muted-foreground">
            Calls, emails, LinkedIn touches, meetings and notes on every lead, contact, account and
            opportunity
          </p>
        </div>
        {can.canCreate && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setDialog({ startAs: "open" })}>
              Plan activity
            </Button>
            <Button onClick={() => setDialog({ startAs: "completed" })}>
              <Plus className="mr-2 h-4 w-4" aria-hidden />
              Log activity
            </Button>
          </div>
        )}
      </div>

      <div className="p-6">
        <div className="rounded-lg border bg-background">
          <div className="border-b p-4">
            <div className="relative">
              <Search
                className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search subject, notes, person, account or opportunity…"
                aria-label="Search activities"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <OwnerFilter
                users={users}
                me={me}
                value={prefs.owner}
                onChange={(owner) => setPrefs({ owner })}
              />
              <StatusFilter
                label="Status"
                options={STATUS_CHOICES}
                chosen={prefs.statuses}
                onChange={(st) => setPrefs({ statuses: st })}
              />
              <StatusFilter
                label="Type"
                options={TYPE_CHOICES}
                chosen={prefs.types ?? []}
                onChange={(types) => setPrefs({ types })}
              />
              {(prefs.owner || prefs.statuses.length > 0 || (prefs.types ?? []).length > 0) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9"
                  onClick={() => setPrefs({ owner: "", statuses: [], types: [] })}
                >
                  Clear filters
                </Button>
              )}
              <span className="ml-auto text-sm text-muted-foreground">
                {list.data &&
                  `${list.data.total.toLocaleString()} ${list.data.total === 1 ? "activity" : "activities"}`}
              </span>
              <ColumnPicker
                available={COLUMNS.map((c) => ({ id: c.key, label: c.header }))}
                shown={shownIds}
                onChange={(ids) => setPrefs({ columns: ids })}
              />
              {canExport && <ExportButton busy={exporting} onClick={() => void exportAll()} />}
            </div>
          </div>

          {selected.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b bg-muted/60 px-4 py-2 text-sm">
              <span className="font-medium">{selected.length} selected</span>
              <BulkChanges
                object="activities"
                plural="activities"
                ids={selected.map((r) => r.id)}
                me={me}
                users={users}
                statuses={BULK_STATUSES}
                statusLabel="Status"
                canDelete={selected.every((r) => can.canDelete(r.ownerId))}
                onDone={() => setChecked(new Set())}
                onResult={setNotice}
              />
              {canExport && (
                <ExportButton label="Export selected" onClick={() => exportRows(selected)} />
              )}
              <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>
                Clear
              </Button>
            </div>
          )}
          {notice && selected.length === 0 && (
            <p role="status" className="border-b bg-muted/60 px-4 py-2 text-sm">
              {notice}
            </p>
          )}
          {complete.error && (
            <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">
              {complete.error.message}
            </p>
          )}

          {list.error ? (
            <p className="p-8 text-center text-sm text-destructive">{list.error.message}</p>
          ) : list.isLoading ? (
            <p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {filtered
                ? `No activities match${q ? ` “${q}”` : ""}${filtered && !q ? " these filters" : ""}.`
                : "No activities yet. Log one here or on any lead, contact, account or opportunity."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all shown"
                      checked={allChecked}
                      onChange={() =>
                        setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.id)))
                      }
                    />
                  </TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">Complete</span>
                  </TableHead>
                  {columns.map((c) => (
                    <TableHead
                      key={c.key}
                      aria-sort={
                        prefs.sort && prefs.sort === c.sort
                          ? prefs.dir === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      {c.sort ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => sortBy(c)}
                        >
                          {c.header}
                          {prefs.sort === c.sort && (prefs.dir === "asc" ? " ↑" : " ↓")}
                        </button>
                      ) : (
                        c.header
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow
                    key={a.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setDialog({ activity: a })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setDialog({ activity: a });
                    }}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${a.subject ?? typeOf(a).label}`}
                        checked={checked.has(a.id)}
                        onChange={() =>
                          setChecked((prev) => {
                            const next = new Set(prev);
                            if (next.has(a.id)) next.delete(a.id);
                            else next.add(a.id);
                            return next;
                          })
                        }
                      />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {a.status === "open" && can.canEdit(a.ownerId) && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={complete.isPending}
                          onClick={() => complete.mutate(a.id)}
                        >
                          Done
                        </Button>
                      )}
                    </TableCell>
                    {columns.map((c) => (
                      <TableCell key={c.key}>{c.cell(a)}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {list.data && (
            <Pager
              offset={offset}
              pageSize={prefs.pageSize}
              total={list.data.total}
              onOffset={(o) => {
                setOffset(o);
                setChecked(new Set());
              }}
              onPageSize={(n) => setPrefs({ pageSize: n })}
            />
          )}
        </div>
      </div>

      <ActivityDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        activity={dialog?.activity}
        startAs={dialog?.startAs}
      />
    </div>
  );
}
