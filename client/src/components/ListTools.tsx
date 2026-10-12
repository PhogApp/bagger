import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Columns3, Download } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { canUse, useApi, type Me, type OrgUser, type StatusOption } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The tools around a record list: which columns show, sorting, the owner and
 * status filters, paging, and the actions for ticked rows. Each person's
 * choices are remembered in their own browser, per list.
 */

export interface ListPrefs {
  /** Column ids in order; null means the list's standard columns. */
  columns: string[] | null;
  sort: string | null;
  dir: "asc" | "desc";
  /** "" for everyone's, "me", or a user id. */
  owner: string;
  statuses: string[];
  pageSize: number;
}

const DEFAULT_PREFS: ListPrefs = {
  columns: null,
  sort: null,
  dir: "asc",
  owner: "",
  statuses: [],
  pageSize: 50,
};

/** Remembered list settings. Storage can be missing or blocked; then they last for the visit. */
export function useListPrefs(list: string): [ListPrefs, (patch: Partial<ListPrefs>) => void] {
  const key = `bagger:list:${list}`;
  const [prefs, setPrefs] = useState<ListPrefs>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? { ...DEFAULT_PREFS, ...JSON.parse(saved) } : DEFAULT_PREFS;
    } catch {
      return DEFAULT_PREFS;
    }
  });
  const update = (patch: Partial<ListPrefs>) =>
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Not remembered; the list still works.
      }
      return next;
    });
  return [prefs, update];
}

export interface ColumnChoice {
  id: string;
  label: string;
}

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** A small panel that opens under a button and closes on a click elsewhere or Escape. */
function Popover(props: {
  label: ReactNode;
  ariaLabel: string;
  children: ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="relative" ref={box}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-9"
        aria-label={props.ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {props.label}
      </Button>
      {open && (
        <div
          className={cn(
            "absolute z-20 mt-1 w-72 rounded-md border bg-background p-2 shadow-lg",
            props.align === "right" ? "right-0" : "left-0",
          )}
        >
          {props.children}
        </div>
      )}
    </div>
  );
}

/** Tick the columns to show and put them in order. */
export function ColumnPicker(props: {
  available: ColumnChoice[];
  shown: string[];
  onChange: (ids: string[] | null) => void;
}) {
  const shown = props.shown.filter((id) => props.available.some((a) => a.id === id));
  const rest = props.available.filter((a) => !shown.includes(a.id));
  const label = (id: string) => props.available.find((a) => a.id === id)?.label ?? id;
  const move = (i: number, by: -1 | 1) => {
    const next = [...shown];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    props.onChange(next);
  };
  return (
    <Popover
      ariaLabel="Choose columns"
      align="right"
      label={
        <>
          <Columns3 className="mr-1.5 h-4 w-4" aria-hidden />
          Columns
        </>
      }
    >
      <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">Shown</p>
      <ul className="max-h-64 space-y-0.5 overflow-y-auto">
        {shown.map((id, i) => (
          <li key={id} className="flex items-center gap-1 rounded px-1 text-sm hover:bg-muted/60">
            <label className="flex flex-1 items-center gap-2 py-1">
              <input
                type="checkbox"
                checked
                disabled={shown.length === 1}
                onChange={() => props.onChange(shown.filter((x) => x !== id))}
              />
              {label(id)}
            </label>
            <button
              type="button"
              className="p-1 text-muted-foreground disabled:opacity-30"
              aria-label={`Move ${label(id)} left`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              <ArrowUp className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              className="p-1 text-muted-foreground disabled:opacity-30"
              aria-label={`Move ${label(id)} right`}
              disabled={i === shown.length - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDown className="h-3.5 w-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {rest.length > 0 && (
        <>
          <p className="px-1 pb-1 pt-2 text-xs font-medium text-muted-foreground">More</p>
          <ul className="max-h-48 space-y-0.5 overflow-y-auto">
            {rest.map((a) => (
              <li key={a.id} className="rounded px-1 text-sm hover:bg-muted/60">
                <label className="flex items-center gap-2 py-1">
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => props.onChange([...shown, a.id])}
                  />
                  {a.label}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      <button
        type="button"
        className="mt-2 px-1 text-xs text-primary hover:underline"
        onClick={() => props.onChange(null)}
      >
        Back to the standard columns
      </button>
    </Popover>
  );
}

/** "Any status" or a set of them. */
export function StatusFilter(props: {
  options: StatusOption[];
  chosen: string[];
  label: string;
  onChange: (chosen: string[]) => void;
}) {
  const text =
    props.chosen.length === 0
      ? `Any ${props.label.toLowerCase()}`
      : props.chosen.length === 1
        ? props.chosen[0]
        : `${props.chosen.length} ${props.label === "Status" ? "statuses" : `${props.label.toLowerCase()}s`}`;
  return (
    <Popover ariaLabel={`Filter by ${props.label.toLowerCase()}`} label={text}>
      <ul className="max-h-64 space-y-0.5 overflow-y-auto">
        {props.options.map((o) => (
          <li key={o.id} className="rounded px-1 text-sm hover:bg-muted/60">
            <label className="flex items-center gap-2 py-1">
              <input
                type="checkbox"
                checked={props.chosen.includes(o.name)}
                onChange={(e) =>
                  props.onChange(
                    e.target.checked
                      ? [...props.chosen, o.name]
                      : props.chosen.filter((c) => c !== o.name),
                  )
                }
              />
              {o.name}
            </label>
          </li>
        ))}
      </ul>
      {props.chosen.length > 0 && (
        <button
          type="button"
          className="mt-1 px-1 text-xs text-primary hover:underline"
          onClick={() => props.onChange([])}
        >
          Clear
        </button>
      )}
    </Popover>
  );
}

export function OwnerFilter(props: {
  users: OrgUser[] | undefined;
  me: Me | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      aria-label="Filter by owner"
      className={selectClass}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    >
      <option value="">Everyone's</option>
      <option value="me">Mine</option>
      {(props.users ?? [])
        .filter((u) => u.id !== props.me?.user.id)
        .map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}'s
          </option>
        ))}
    </select>
  );
}

/** "1–50 of 1,234" with previous and next. */
export function Pager(props: {
  offset: number;
  pageSize: number;
  total: number;
  onOffset: (offset: number) => void;
  onPageSize: (size: number) => void;
}) {
  const { offset, pageSize, total } = props;
  if (total === 0) return null;
  const last = Math.min(offset + pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5 text-sm">
      <span className="text-muted-foreground">
        {offset + 1}–{last} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        <select
          aria-label="Rows per page"
          className={cn(selectClass, "h-8")}
          value={pageSize}
          onChange={(e) => props.onPageSize(Number(e.target.value))}
        >
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>
              {n} per page
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={offset === 0}
          onClick={() => props.onOffset(Math.max(0, offset - pageSize))}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={last >= total}
          onClick={() => props.onOffset(offset + pageSize)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

/** Save rows as a CSV file the browser downloads. */
export function downloadCsv(name: string, rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    const text = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = rows.map((r) => r.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Change owner, change status or delete the ticked rows, within the person's rights. */
export function BulkChanges(props: {
  object: string;
  plural: string;
  ids: string[];
  me: Me | undefined;
  users: OrgUser[] | undefined;
  statuses?: StatusOption[];
  statusLabel: string;
  canDelete: boolean;
  onDone: () => void;
  /** What happened, said where it stays visible after the selection clears. */
  onResult: (message: string) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (body: { action: "update" | "delete"; patch?: Record<string, string> }) =>
      api<{ done: number; skipped: { id: string; reason: string }[] }>(
        "POST",
        `/api/${props.object}/bulk`,
        {
          ids: props.ids,
          ...body,
        },
      ),
    onSuccess: async (r, body) => {
      const verb = body.action === "delete" ? "deleted" : "updated";
      const reasons = [...new Set(r.skipped.map((s) => s.reason))].join("; ");
      const said =
        `${r.done.toLocaleString()} ${verb}.` +
        (r.skipped.length ? ` ${r.skipped.length} skipped: ${reasons}.` : "");
      setMessage(said);
      props.onResult(said);
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: [props.object] });
      if (r.skipped.length === 0) props.onDone();
    },
    onError: (e: Error) => setMessage(e.message),
  });
  const edit = canUse(props.me, "data.bulk_edit");
  const reassign = canUse(props.me, "data.bulk_reassign");
  const remove = canUse(props.me, "data.bulk_delete") && props.canDelete;

  return (
    <>
      {edit && props.statuses && props.statuses.length > 0 && (
        <select
          aria-label={`Change ${props.statusLabel.toLowerCase()}`}
          className={cn(selectClass, "h-8")}
          value=""
          disabled={run.isPending}
          onChange={(e) =>
            e.target.value && run.mutate({ action: "update", patch: { status: e.target.value } })
          }
        >
          <option value="">Change {props.statusLabel.toLowerCase()}…</option>
          {props.statuses.map((s) => (
            <option key={s.id} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {edit && reassign && (
        <select
          aria-label="Change owner"
          className={cn(selectClass, "h-8")}
          value=""
          disabled={run.isPending}
          onChange={(e) =>
            e.target.value && run.mutate({ action: "update", patch: { ownerId: e.target.value } })
          }
        >
          <option value="">Change owner…</option>
          {(props.users ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      )}
      {remove &&
        (confirming ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              disabled={run.isPending}
              onClick={() => run.mutate({ action: "delete" })}
            >
              Delete {props.ids.length} {props.plural}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirming(true)}
          >
            Delete
          </Button>
        ))}
      {message && (
        <span role="status" className="text-sm">
          {message}
        </span>
      )}
    </>
  );
}

export function ExportButton(props: { onClick: () => void; busy?: boolean; label?: string }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-9"
      disabled={props.busy}
      onClick={props.onClick}
    >
      <Download className="mr-1.5 h-4 w-4" aria-hidden />
      {props.label ?? "Export"}
    </Button>
  );
}
