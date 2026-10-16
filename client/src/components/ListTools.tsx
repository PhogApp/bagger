import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Columns3, Download, GripVertical, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { canUse, useApi, type Me, type OrgUser, type StatusOption } from "@/lib/api";
import { count, toast } from "@/lib/toast";
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
  /** The person picked an owner themselves; until then lists start on "Mine". */
  ownerChosen?: boolean;
  statuses: string[];
  /** Activity types, on the Activities list. */
  types: string[];
  pageSize: number;
}

const DEFAULT_PREFS: ListPrefs = {
  columns: null,
  sort: null,
  dir: "asc",
  owner: "me",
  statuses: [],
  types: [],
  pageSize: 50,
};

/** Remembered list settings. Storage can be missing or blocked; then they last for the visit. */
export function useListPrefs(list: string): [ListPrefs, (patch: Partial<ListPrefs>) => void] {
  const key = `bagger:list:${list}`;
  const [prefs, setPrefs] = useState<ListPrefs>(() => {
    try {
      const saved = localStorage.getItem(key);
      if (!saved) return DEFAULT_PREFS;
      const loaded = { ...DEFAULT_PREFS, ...JSON.parse(saved) } as ListPrefs;
      // Lists start on "Mine" unless the person chose another owner themselves.
      return loaded.ownerChosen ? loaded : { ...loaded, owner: DEFAULT_PREFS.owner };
    } catch {
      return DEFAULT_PREFS;
    }
  });
  const update = (patch: Partial<ListPrefs>) =>
    setPrefs((prev) => {
      const next = { ...prev, ...patch, ...("owner" in patch ? { ownerChosen: true } : {}) };
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
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "left" | "right";
  width?: string;
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
            "absolute z-20 mt-1 rounded-md border bg-background p-2 shadow-lg",
            props.width ?? "w-72",
            props.align === "right" ? "right-0" : "left-0",
          )}
        >
          {typeof props.children === "function"
            ? props.children(() => setOpen(false))
            : props.children}
        </div>
      )}
    </div>
  );
}

/** Tick the columns to show, and drag them into order. */
export function ColumnPicker(props: {
  available: ColumnChoice[];
  shown: string[];
  onChange: (ids: string[] | null) => void;
}) {
  const shown = props.shown.filter((id) => props.available.some((a) => a.id === id));
  // One list: the shown columns in their order, then the rest.
  const order = [...shown, ...props.available.map((a) => a.id).filter((id) => !shown.includes(id))];
  const label = (id: string) => props.available.find((a) => a.id === id)?.label ?? id;
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const place = (moving: string, target: string) => {
    if (moving === target) return;
    const next = order.filter((id) => id !== moving);
    next.splice(
      next.indexOf(target) + (order.indexOf(moving) < order.indexOf(target) ? 1 : 0),
      0,
      moving,
    );
    props.onChange(next.filter((id) => shown.includes(id)));
  };
  /** Alt+arrow moves the focused column, for anyone not using a mouse. */
  const nudge = (id: string, by: -1 | 1) => {
    const i = shown.indexOf(id);
    if (i < 0 || i + by < 0 || i + by >= shown.length) return;
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
      <ul className="max-h-80 space-y-0.5 overflow-y-auto" aria-label="Columns">
        {order.map((id) => {
          const on = shown.includes(id);
          return (
            <li
              key={id}
              draggable
              onDragStart={(e) => {
                setDragging(id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(id);
              }}
              onDragLeave={() => setOver((o) => (o === id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging) place(dragging, id);
                setDragging(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              className={cn(
                "flex cursor-grab items-center gap-1.5 rounded px-1 text-sm hover:bg-muted/60 active:cursor-grabbing",
                dragging === id && "opacity-40",
                over === id && dragging !== id && "bg-muted ring-1 ring-primary/40",
              )}
            >
              <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <label className="flex flex-1 items-center gap-2 py-1">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={on && shown.length === 1}
                  onKeyDown={(e) => {
                    if (e.altKey && e.key === "ArrowUp") {
                      e.preventDefault();
                      nudge(id, -1);
                    }
                    if (e.altKey && e.key === "ArrowDown") {
                      e.preventDefault();
                      nudge(id, 1);
                    }
                  }}
                  onChange={() =>
                    props.onChange(on ? shown.filter((x) => x !== id) : [...shown, id])
                  }
                />
                <span className={cn(!on && "text-muted-foreground")}>{label(id)}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </Popover>
  );
}

/** A status to filter or change by: the organization's own, or a fixed one with a `value`. */
export type StatusChoice = Pick<StatusOption, "id" | "name"> & { value?: string };
const choiceValue = (o: StatusChoice) => o.value ?? o.name;

/** "Any status" or a set of them. */
export function StatusFilter(props: {
  options: StatusChoice[];
  chosen: string[];
  label: string;
  onChange: (chosen: string[]) => void;
}) {
  const text =
    props.chosen.length === 0
      ? `Any ${props.label.toLowerCase()}`
      : props.chosen.length === 1
        ? (props.options.find((o) => choiceValue(o) === props.chosen[0])?.name ?? props.chosen[0])
        : `${props.chosen.length} ${props.label === "Status" ? "statuses" : `${props.label.toLowerCase()}s`}`;
  return (
    <Popover ariaLabel={`Filter by ${props.label.toLowerCase()}`} label={text}>
      <ul className="max-h-64 space-y-0.5 overflow-y-auto">
        {props.options.map((o) => (
          <li key={o.id} className="rounded px-1 text-sm hover:bg-muted/60">
            <label className="flex items-center gap-2 py-1">
              <input
                type="checkbox"
                checked={props.chosen.includes(choiceValue(o))}
                onChange={(e) =>
                  props.onChange(
                    e.target.checked
                      ? [...props.chosen, choiceValue(o)]
                      : props.chosen.filter((c) => c !== choiceValue(o)),
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

/** Change the owner or status of the ticked rows, within the person's rights. */
export function BulkChanges(props: {
  object: string;
  plural: string;
  ids: string[];
  me: Me | undefined;
  users: OrgUser[] | undefined;
  statuses?: StatusChoice[];
  statusLabel: string;
  onDone: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const singular = props.plural.replace(/ies$/, "y").replace(/s$/, "");
  const run = useMutation({
    mutationFn: (body: { action: "update"; patch?: Record<string, string> }) =>
      api<{ done: number; skipped: { id: string; reason: string }[] }>(
        "POST",
        `/api/${props.object}/bulk`,
        {
          ids: props.ids,
          ...body,
        },
      ),
    onSuccess: async (r, body) => {
      const verb = body.action === "update" ? "updated" : "deleted";
      const reasons = [...new Set(r.skipped.map((s) => s.reason))].join("; ");
      const said = `${count(r.done, singular, props.plural)} ${verb}.`;
      if (r.skipped.length) toast.warning(`${said} ${r.skipped.length} skipped: ${reasons}.`);
      else toast.success(said);
      await queryClient.invalidateQueries({ queryKey: [props.object] });
      if (r.skipped.length === 0) props.onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const edit = canUse(props.me, "data.bulk_edit");
  const reassign = canUse(props.me, "data.bulk_reassign");

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
            <option key={s.id} value={choiceValue(s)}>
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
    </>
  );
}

/** The download icon: export everything that matches, or only the ticked rows. */
export function ExportMenu(props: {
  busy?: boolean;
  selected: number;
  onExportAll: () => void;
  onExportSelected: () => void;
}) {
  return (
    <Popover
      ariaLabel="Export"
      align="right"
      width="w-56"
      label={<Download className="h-4 w-4" aria-hidden />}
    >
      {(close) => (
        <MenuItems
          close={close}
          items={[
            {
              label: props.busy ? "Exporting…" : "Export all",
              onClick: props.onExportAll,
              disabled: props.busy,
            },
            {
              label: props.selected ? `Export selected (${props.selected})` : "Export selected",
              onClick: props.onExportSelected,
              disabled: props.selected === 0,
            },
          ]}
        />
      )}
    </Popover>
  );
}

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** Shown under the label when it's disabled, e.g. why. */
  hint?: string;
}

function MenuItems({ items, close }: { items: MenuItem[]; close: () => void }) {
  return (
    <ul role="menu" className="space-y-0.5">
      {items.map((item) => (
        <li key={item.label} role="none">
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={cn(
              "w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
              item.destructive && "text-destructive",
            )}
            onClick={() => {
              close();
              item.onClick();
            }}
          >
            {item.label}
            {item.disabled && item.hint && (
              <span className="block text-xs text-muted-foreground">{item.hint}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The three-dot menu: less frequent actions, such as importing or deleting. */
export function MoreMenu({ items, label = "More actions" }: { items: MenuItem[]; label?: string }) {
  if (items.length === 0) return null;
  return (
    <Popover
      ariaLabel={label}
      align="right"
      width="w-56"
      label={<MoreHorizontal className="h-4 w-4" aria-hidden />}
    >
      {(close) => <MenuItems items={items} close={close} />}
    </Popover>
  );
}

/** "Are you sure you want to delete the selected leads?", then delete them. */
export function BulkDeleteDialog(props: {
  open: boolean;
  object: string;
  plural: string;
  ids: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const singular = props.plural.replace(/ies$/, "y").replace(/s$/, "");
  const run = useMutation({
    mutationFn: () =>
      api<{ done: number; skipped: { id: string; reason: string }[] }>(
        "POST",
        `/api/${props.object}/bulk`,
        { ids: props.ids, action: "delete" },
      ),
    onSuccess: async (r) => {
      const reasons = [...new Set(r.skipped.map((s) => s.reason))].join("; ");
      const said = `${count(r.done, singular, props.plural)} deleted.`;
      if (r.skipped.length) toast.warning(`${said} ${r.skipped.length} skipped: ${reasons}.`);
      else toast.success(said);
      await queryClient.invalidateQueries({ queryKey: [props.object] });
      props.onClose();
      if (r.skipped.length === 0) props.onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const n = props.ids.length;
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-w-md" role="alertdialog">
        <DialogHeader>
          <DialogTitle>Delete selected {n === 1 ? singular : props.plural}?</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete{" "}
            {n === 1 ? `the selected ${singular}` : `the ${n} selected ${props.plural}`}? They're
            kept in History.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={run.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? "Deleting…" : `Delete ${count(n, singular, props.plural)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
