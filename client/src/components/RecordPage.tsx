import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { PlainTextEditor, RichTextEditor } from "@/components/RichTextEditor";
import { PhoneLink } from "@/components/PhoneLink";
import { ImportDialog, type ImportKind } from "@/components/ImportRecords";
import {
  BulkChanges,
  BulkDeleteDialog,
  ColumnPicker,
  downloadCsv,
  ExportMenu,
  MoreMenu,
  OwnerFilter,
  type MenuItem,
  Pager,
  StatusFilter,
  useListPrefs,
} from "@/components/ListTools";
import {
  ApiError,
  canUse,
  permissionsFor,
  useApi,
  useMe,
  useOrgUsers,
  useStatuses,
  type StatusObject,
} from "@/lib/api";
import { customFieldAsField, useFieldSetup, type LayoutObject } from "@/lib/fields";
import { count, toast } from "@/lib/toast";
import { cn, formatDateTime } from "@/lib/utils";
import { htmlToText } from "../../../shared/richtext";

/**
 * One list-and-edit screen, used for leads, contacts and accounts. Each page
 * supplies its fields and columns; this component handles search, the add and
 * edit dialogs, deleting, and the History tab.
 */

export interface Option {
  value: string;
  label: string;
}

export interface Field {
  name: string;
  label: string;
  kind?:
    | "text"
    | "number"
    | "email"
    | "tel"
    | "url"
    | "date"
    | "textarea"
    | "select"
    | "multiselect"
    | "richtext"
    /** Plain text with the Insert field menu (LinkedIn messages). */
    | "plaintext";
  required?: boolean;
  options?: Option[];
  placeholder?: string;
  /** Columns out of 6 the field spans in the form. Defaults to 3 (half width). */
  span?: 2 | 3 | 6;
  /** Height of a textarea, in lines. */
  rows?: number;
  /** Most characters allowed, counted as you type (plain text). */
  maxLength?: number;
  /** Short guidance shown under the field. */
  help?: string;
  /** Converts the form's text value before sending, e.g. "true" to true. */
  parse?: (value: string) => unknown;
  /** How a stored value reads on the record page, when plain text won't do. */
  format?: (value: unknown) => ReactNode;
}

/** A record's value for a field, including custom ones named "custom.<key>". */
export function valueOf(row: Record<string, unknown>, name: string): unknown {
  if (!name.startsWith("custom.")) return row[name];
  return (row.custom as Record<string, unknown> | undefined)?.[name.slice(7)];
}

/** A stored value as the text a form box holds. Lists become "a; b". */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join("; ");
  return String(value);
}

/** Turn form values into a request body, gathering "custom.<key>" values under `custom`. */
export function toBody(values: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    if (name.startsWith("custom.")) custom[name.slice(7)] = value;
    else body[name] = value;
  }
  if (Object.keys(custom).length > 0) body.custom = custom;
  return body;
}

/** Ticks for each choice; the value is the choices joined with "; ". */
export function MultiSelect(props: {
  id: string;
  options: Option[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const chosen = new Set(
    props.value
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean),
  );
  return (
    <div id={props.id} className="flex flex-wrap gap-x-4 gap-y-1.5 py-1.5" role="group">
      {props.options.map((o) => (
        <label key={o.value} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            disabled={props.disabled}
            checked={chosen.has(o.value)}
            onChange={(e) => {
              const next = new Set(chosen);
              if (e.target.checked) next.add(o.value);
              else next.delete(o.value);
              props.onChange(
                props.options
                  .filter((x) => next.has(x.value))
                  .map((x) => x.value)
                  .join("; "),
              );
            }}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  /** A stable name for the column; defaults to the header. */
  key?: string;
  /** The server's name for sorting by this column, if it can be sorted. */
  sort?: string;
  /** The value in a CSV export, when the cell isn't plain text. */
  csv?: (row: T) => string | number | null | undefined;
  /** Offered in the column picker but not shown until chosen. */
  hidden?: boolean;
}

const columnId = <T,>(c: Column<T>) => c.key ?? c.header;

interface BaseRecord {
  id: string;
  ownerId: string;
}

export interface RecordPageProps<T extends BaseRecord> {
  object: "leads" | "contacts" | "accounts" | "opportunities" | "templates" | "sequences";
  /** Name used by audit history, e.g. "lead". */
  recordType: string;
  title: string;
  singular: string;
  searchPlaceholder: string;
  fields: Field[];
  columns: Column<T>[];
  defaults?: Record<string, string>;
  /** Heading for the edit dialog. */
  describe: (row: T) => string;
  /**
   * The record's own page. When set, a row opens that page, a new record opens
   * its page once created, and the dialog is only used for adding.
   */
  detailPath?: (id: string) => string;
  /** When set, clicking a row calls this instead of opening the edit dialog. */
  onRowOpen?: (row: T) => void;
  /** More tabs in a record's dialog, between Details and History, e.g. Activity. */
  tabs?: { value: string; label: string; render: (row: T) => ReactNode }[];
  /** Shown under a record's own fields, e.g. the contacts on an account. */
  related?: (row: T) => ReactNode;
  /** Extra buttons in the edit dialog for one record, e.g. Convert. Call `close` when done. */
  recordActions?: (row: T, close: () => void) => ReactNode;
  /**
   * Turns on owner and status filters, custom field columns, bulk changes and
   * export, for the record types that have them.
   */
  listTools?: {
    statusObject?: StatusObject;
    customObject?: LayoutObject;
    /** What the status is called on this record type, e.g. "Stage". */
    statusLabel?: string;
  };
  /** Draws the rows some other way than the table, e.g. a board. Call `open` to edit one. */
  renderList?: (rows: T[], open: (row: T) => void) => ReactNode;
  /** Extra buttons in the page header, e.g. the board/list switch. */
  headerActions?: ReactNode;
  /** The form's fields when they depend on what's chosen (a template's type). */
  formFields?: (values: Record<string, string>) => Field[];
  /** Fix up the form after a change, e.g. turn a message to plain text for LinkedIn. */
  adjust?: (next: Record<string, string>, changed: string) => Record<string, string>;
  /** Offer "Import CSV" in the three-dot menu, for these records. */
  importKind?: ImportKind;
  /** New ones are added from the + menu in the top bar, so the page has no Add button. */
  addFromTopBar?: boolean;
  /**
   * Turns on row checkboxes. Called with the checked rows to draw the actions
   * that apply to them; call `clear` when an action is finished.
   */
  bulkActions?: (selected: T[], clear: () => void) => ReactNode;
}

interface DuplicateMatch {
  type: "lead" | "contact" | "account";
  id: string;
  label: string;
}

interface HistoryEntry {
  id: string;
  recordType: string;
  action: "create" | "update" | "delete";
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  source: "user" | "import" | "system" | "integration" | "api";
  via?: string | null;
  at: string;
  userName: string | null;
}

type Values = Record<string, string>;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

function FieldInput({
  field,
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  field: Field;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  const id = `${idPrefix}-${field.name}`;
  const span = { 2: "sm:col-span-2", 3: "sm:col-span-3", 6: "sm:col-span-6" }[field.span ?? 3];
  return (
    <div className={cn("col-span-6 space-y-1.5", span)}>
      <Label htmlFor={id}>
        {field.label}
        {field.required && <span className="text-destructive"> *</span>}
      </Label>
      {field.kind === "multiselect" ? (
        <MultiSelect
          id={id}
          options={field.options ?? []}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      ) : field.kind === "richtext" ? (
        <RichTextEditor id={id} value={value} onChange={onChange} disabled={disabled} />
      ) : field.kind === "plaintext" ? (
        <PlainTextEditor
          id={id}
          value={value}
          onChange={onChange}
          disabled={disabled}
          rows={field.rows ?? 6}
          limit={field.maxLength}
        />
      ) : field.kind === "textarea" ? (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={field.rows ?? 3}
        />
      ) : field.kind === "select" ? (
        <select
          id={id}
          className={selectClass}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={field.required}
        >
          {!field.required || value === "" ? <option value="">Select…</option> : null}
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          // Web addresses use a plain text box: the browser's own "url" check
          // rejects "www.example.com", which is how most people type one.
          type={field.kind === "url" || field.kind === "number" ? "text" : (field.kind ?? "text")}
          inputMode={field.kind === "url" ? "url" : field.kind === "number" ? "decimal" : undefined}
          autoCapitalize={field.kind === "url" ? "none" : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={field.required}
          placeholder={field.placeholder}
        />
      )}
      {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
    </div>
  );
}

export function History({
  recordType,
  recordId,
  fields,
}: {
  recordType: string;
  recordId: string;
  fields: Field[];
}) {
  const api = useApi();
  const { data, isLoading, error } = useQuery({
    queryKey: ["history", recordType, recordId],
    queryFn: () => api<HistoryEntry[]>("GET", `/api/history/${recordType}/${recordId}`),
  });

  if (isLoading) return <p className="py-6 text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="py-6 text-sm text-destructive">{error.message}</p>;
  if (!data?.length) return <p className="py-6 text-sm text-muted-foreground">No history yet.</p>;

  const byName = new Map(fields.map((f) => [f.name, f]));
  // Stored values are ids for owner and account; show the names instead.
  const show = (fieldName: string | null, value: string | null) => {
    if (value === null || value === "") return "empty";
    const option = byName.get(fieldName ?? "")?.options?.find((o) => o.value === value);
    // A formatted message reads as its words here.
    return option?.label ?? htmlToText(value);
  };

  return (
    <ol className="max-h-[32rem] space-y-3 overflow-y-auto py-2">
      {data.map((h) => (
        <li key={h.id} className="border-l-2 border-border pl-3 text-sm">
          {h.field === "convertedContactId" ? (
            <p className="font-medium">Converted from a lead to a contact</p>
          ) : h.action === "update" ? (
            <p>
              <span className="font-medium">{byName.get(h.field ?? "")?.label ?? h.field}</span>
              {": "}
              <span className="text-muted-foreground line-through">
                {show(h.field, h.oldValue)}
              </span>
              {" → "}
              <span>{show(h.field, h.newValue)}</span>
            </p>
          ) : (
            <p className="font-medium">
              {h.action === "create" ? "Created" : "Deleted"}
              {h.recordType !== recordType && ` as a ${h.recordType}`}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {h.userName ?? "System"} · {formatDateTime(h.at)}
            {h.source === "integration" || h.source === "api"
              ? ` · via ${h.via ?? (h.source === "api" ? "the API" : "an integration")}`
              : h.source !== "user" && ` · ${h.source}`}
          </p>
        </li>
      ))}
    </ol>
  );
}

export function RecordPage<T extends BaseRecord>(props: RecordPageProps<T>) {
  const { object, fields, singular } = props;
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const can = permissionsFor(me, object);

  const [search, setSearch] = useState(
    () => new URLSearchParams(window.location.search).get("q") ?? "",
  );
  const q = useDebounced(search.trim(), 250);
  const [editing, setEditing] = useState<T | "new" | null>(null);
  const [values, setValues] = useState<Values>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Records the server says this new one may duplicate; the user decides.
  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null);

  const tools = props.listTools;
  const { data: users } = useOrgUsers();
  const { data: statuses } = useStatuses();
  const { data: fieldSetup } = useFieldSetup();
  const [prefs, setPrefs] = useListPrefs(object);
  const [offset, setOffset] = useState(0);
  const statusOptions = tools?.statusObject
    ? (statuses ?? []).filter((st) => st.object === tools.statusObject)
    : [];
  // A board shows everything at once; a table goes a page at a time.
  const pageSize = props.renderList ? 500 : prefs.pageSize;

  const listParams = new URLSearchParams({
    withTotal: "1",
    limit: String(pageSize),
    offset: String(props.renderList ? 0 : offset),
  });
  if (q) listParams.set("q", q);
  if (prefs.sort) {
    listParams.set("sort", prefs.sort);
    listParams.set("dir", prefs.dir);
  }
  if (tools && prefs.owner) listParams.set("owner", prefs.owner);
  // Statuses that no longer exist are dropped rather than matching nothing.
  for (const st of prefs.statuses) {
    if (statusOptions.some((o) => o.name === st)) listParams.append("status", st);
  }
  const query = listParams.toString();
  useEffect(
    () => setOffset(0),
    [q, prefs.sort, prefs.dir, prefs.owner, prefs.statuses.join("|"), prefs.pageSize],
  );

  const list = useQuery({
    queryKey: [object, "list", query],
    queryFn: () => api<{ rows: T[]; total: number }>("GET", `/api/${object}?${query}`),
    placeholderData: (previous) => previous,
  });

  // Every column the picker offers: the page's own, then custom fields.
  const allColumns: Column<T>[] = [
    ...props.columns,
    ...(tools?.customObject
      ? (fieldSetup?.fields ?? [])
          .filter((f) => f.object === tools.customObject && !f.archived)
          .map((def): Column<T> => {
            const field = customFieldAsField(def, users);
            const read = (row: T) => valueOf(row as unknown as Record<string, unknown>, field.name);
            const text = (row: T) => {
              const v = read(row);
              const option = field.options?.find((o) => o.value === asText(v));
              return option?.label ?? asText(v);
            };
            return {
              key: field.name,
              header: def.label,
              sort: def.type === "multipicklist" ? undefined : field.name,
              hidden: true,
              cell: (row) => {
                const v = read(row);
                if (field.kind === "tel") return <PhoneLink value={asText(v)} copy={false} />;
                return (field.format?.(v) ?? text(row)) || "—";
              },
              csv: (row) =>
                def.type === "number" || def.type === "currency"
                  ? (read(row) as number)
                  : text(row),
            };
          })
      : []),
  ];
  const shownIds = prefs.columns ?? allColumns.filter((c) => !c.hidden).map(columnId);
  const columns = shownIds
    .map((id) => allColumns.find((c) => columnId(c) === id))
    .filter((c): c is Column<T> => Boolean(c));
  const csvValue = (c: Column<T>, row: T) => {
    if (c.csv) return c.csv(row);
    const v = c.cell(row);
    return typeof v === "string" || typeof v === "number" ? v : "";
  };
  const canExport = Boolean(tools) && canUse(me, "data.export_lists");
  const [exporting, setExporting] = useState(false);
  const exportRows = (chosen: T[]) => {
    downloadCsv(`bagger-${object}-${new Date().toISOString().slice(0, 10)}`, [
      columns.map((c) => c.header),
      ...chosen.map((row) => columns.map((c) => csvValue(c, row))),
    ]);
    toast.success(
      `${count(chosen.length, singular.toLowerCase(), props.title.toLowerCase())} exported`,
    );
  };
  // Everything that matches the current search and filters, a page at a time.
  const exportAll = async () => {
    setExporting(true);
    try {
      const all: T[] = [];
      for (let from = 0; from < 50000; from += 500) {
        const next = new URLSearchParams(listParams);
        next.set("limit", "500");
        next.set("offset", String(from));
        const page = await api<{ rows: T[]; total: number }>("GET", `/api/${object}?${next}`);
        all.push(...page.rows);
        if (all.length >= page.total || page.rows.length === 0) break;
      }
      exportRows(all);
    } finally {
      setExporting(false);
    }
  };
  const sortBy = (c: Column<T>) => {
    if (!c.sort) return;
    setPrefs({
      sort: c.sort,
      dir: prefs.sort === c.sort && prefs.dir === "asc" ? "desc" : "asc",
    });
  };

  // Rows ticked for a bulk action. Only rows still on screen count.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const rows = list.data?.rows ?? [];
  const selectable = Boolean(props.bulkActions || tools);
  const selected = rows.filter((r) => checked.has(r.id));
  const allChecked = rows.length > 0 && selected.length === rows.length;
  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The three-dot menu: importing, and deleting the ticked rows.
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState(false);
  const mayDelete =
    canUse(me, "data.bulk_delete") && selected.every((r) => can.canDelete(r.ownerId));
  const moreItems: MenuItem[] = [
    ...(props.importKind && canUse(me, "data.import") && can.canCreate
      ? [{ label: "Import CSV", onClick: () => setImporting(true) }]
      : []),
    ...(tools && canUse(me, "data.bulk_delete")
      ? [
          {
            label: selected.length ? `Delete selected (${selected.length})` : "Delete selected",
            onClick: () => setDeleting(true),
            disabled: selected.length === 0 || !mayDelete,
            destructive: true,
            hint:
              selected.length === 0
                ? `Tick the ${props.title.toLowerCase()} to delete first`
                : "Some of these aren't yours to delete",
          },
        ]
      : []),
  ];

  const blank = useMemo(
    () => Object.fromEntries(fields.map((f) => [f.name, props.defaults?.[f.name] ?? ""])),
    [fields, props.defaults],
  );

  function open(target: T | "new") {
    const row = target === "new" ? null : (target as unknown as Record<string, unknown>);
    setValues(
      row ? Object.fromEntries(fields.map((f) => [f.name, asText(valueOf(row, f.name))])) : blank,
    );
    setFormError(null);
    setDuplicates(null);
    setConfirmingDelete(false);
    setEditing(target);
  }

  const parsed = (body: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(body).map(([name, v]) => {
        const parse = fields.find((f) => f.name === name)?.parse;
        return [name, parse ? parse(v) : v];
      }),
    );

  // The server reports problems by field name; show the label people see.
  const relabel = (message: string) =>
    fields.reduce((text, f) => text.replace(`${f.name}:`, `${f.label}:`), message);

  const openRow = (row: T) =>
    props.detailPath
      ? navigateTo(props.detailPath(row.id))
      : props.onRowOpen
        ? props.onRowOpen(row)
        : open(row);

  // A link such as /contacts?open=<id> lands on the list with that record open;
  // /contacts?new=1&accountId=<id> opens a new one with those fields filled in.
  const [path, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const linkedId = params.get("open");
  // /leads?q=jill (from the search box's "See all") starts the list searched.
  const linkedQ = params.get("q");
  useEffect(() => {
    if (linkedQ === null) return;
    setSearch(linkedQ);
    navigate(path, { replace: true });
    // Only the address should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedQ]);
  const startNew = params.get("new") === "1" ? params.toString() : null;
  useEffect(() => {
    if (!startNew) return;
    const given = new URLSearchParams(startNew);
    open("new");
    setValues((prev) => ({
      ...prev,
      ...Object.fromEntries(
        fields.filter((f) => given.has(f.name)).map((f) => [f.name, given.get(f.name) ?? ""]),
      ),
    }));
    navigate(path, { replace: true });
    // Only the address should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startNew]);
  useEffect(() => {
    if (!linkedId) return;
    if (props.detailPath) {
      navigate(props.detailPath(linkedId), { replace: true });
      return;
    }
    let cancelled = false;
    api<T>("GET", `/api/${object}/${linkedId}`)
      .then((row) => {
        if (!cancelled) openRow(row);
      })
      .catch(() => undefined) // deleted or not visible: just show the list
      .finally(() => {
        if (!cancelled) navigate(path, { replace: true });
      });
    return () => {
      cancelled = true;
    };
    // Only the id in the address should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedId]);

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: [object] });
    setEditing(null);
  };

  const [, navigateTo] = useLocation();

  const save = useMutation({
    mutationFn: async (allowDuplicate: boolean) => {
      if (editing === "new") {
        // Leave out blanks so the server applies its defaults.
        const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
        return api(
          "POST",
          `/api/${object}${allowDuplicate ? "?allowDuplicate=1" : ""}`,
          toBody(parsed(body)),
        );
      }
      const row = editing as unknown as Record<string, unknown>;
      const changed = Object.fromEntries(
        Object.entries(values).filter(([name, v]) => v !== asText(valueOf(row, name))),
      );
      if (Object.keys(changed).length === 0) return null;
      return api("PATCH", `/api/${object}/${(editing as T).id}`, toBody(parsed(changed)));
    },
    onSuccess: async (created) => {
      const wasNew = editing === "new";
      await done();
      if (created) toast.success(wasNew ? `${singular} added` : "Changes saved");
      const id = (created as { id?: string } | null)?.id;
      if (props.detailPath && editing === "new" && id) navigateTo(props.detailPath(id));
    },
    onError: (e: Error) => {
      if (e instanceof ApiError && e.code === "duplicate") {
        setDuplicates((e.body.matches as DuplicateMatch[]) ?? []);
      } else {
        setFormError(relabel(e.message));
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => api("DELETE", `/api/${object}/${(editing as T).id}`),
    onSuccess: async () => {
      await done();
      toast.success(`${singular} deleted`);
    },
    onError: (e: Error) => setFormError(relabel(e.message)),
  });

  const isNew = editing === "new";
  const current = editing && editing !== "new" ? editing : null;
  const readOnly = current ? !can.canEdit(current.ownerId) : !can.canCreate;
  const busy = save.isPending || remove.isPending;

  const form = (
    <form
      id="record-form"
      className="grid grid-cols-6 gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setFormError(null);
        setDuplicates(null);
        save.mutate(false);
      }}
    >
      {(props.formFields?.(values) ?? fields).map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          idPrefix={object}
          value={values[field.name] ?? ""}
          onChange={(v) =>
            setValues((prev) => {
              const next = { ...prev, [field.name]: v };
              return props.adjust ? props.adjust(next, field.name) : next;
            })
          }
          disabled={readOnly || busy}
        />
      ))}
    </form>
  );

  return (
    <div>
      <div className="flex items-center justify-between border-b bg-background px-6 py-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>
        </div>
        <div className="flex items-center gap-2">
          {props.headerActions}
          {can.canCreate && !props.addFromTopBar && (
            <Button onClick={() => open("new")}>
              <Plus className="mr-2 h-4 w-4" aria-hidden />
              Add {singular}
            </Button>
          )}
        </div>
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
                placeholder={props.searchPlaceholder}
                aria-label={props.searchPlaceholder}
              />
            </div>
            {tools && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <OwnerFilter
                  users={users}
                  me={me}
                  value={prefs.owner}
                  onChange={(owner) => setPrefs({ owner })}
                />
                {tools.statusObject && (
                  <StatusFilter
                    label={tools.statusLabel ?? "Status"}
                    options={statusOptions}
                    chosen={prefs.statuses}
                    onChange={(st) => setPrefs({ statuses: st })}
                  />
                )}
                {(prefs.owner !== "me" || prefs.statuses.length > 0) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-9"
                    onClick={() => setPrefs({ owner: "me", statuses: [] })}
                  >
                    Clear filters
                  </Button>
                )}
                <span className="ml-auto" />
                {!props.renderList && (
                  <ColumnPicker
                    available={allColumns.map((c) => ({ id: columnId(c), label: c.header }))}
                    shown={shownIds}
                    onChange={(ids) => setPrefs({ columns: ids })}
                  />
                )}
                {canExport && (
                  <ExportMenu
                    busy={exporting}
                    selected={selected.length}
                    onExportAll={() => void exportAll()}
                    onExportSelected={() => exportRows(selected)}
                  />
                )}
                <MoreMenu items={moreItems} />
              </div>
            )}
          </div>

          {selectable && selected.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b bg-muted/60 px-4 py-2 text-sm">
              <span className="font-medium">{selected.length} selected</span>
              {props.bulkActions?.(selected, () => setChecked(new Set()))}
              {tools && (
                <BulkChanges
                  object={object}
                  plural={props.title.toLowerCase()}
                  ids={selected.map((r) => r.id)}
                  me={me}
                  users={users}
                  statuses={statusOptions}
                  statusLabel={tools.statusLabel ?? "Status"}
                  onDone={() => setChecked(new Set())}
                />
              )}
            </div>
          )}
          {list.error ? (
            <p className="p-8 text-center text-sm text-destructive">{list.error.message}</p>
          ) : list.isLoading ? (
            <p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {q || (prefs.owner && prefs.owner !== "me") || prefs.statuses.length
                ? `No ${props.title.toLowerCase()} match${q ? ` “${q}”` : ""}${
                    (prefs.owner && prefs.owner !== "me") || prefs.statuses.length
                      ? " these filters"
                      : ""
                  }.`
                : prefs.owner === "me" && tools
                  ? `None of yours yet. Choose "Everyone's" to see the rest of your team's ${props.title.toLowerCase()}.`
                : q
                  ? `No ${props.title.toLowerCase()} match “${q}”.`
                  : `No ${props.title.toLowerCase()} yet.${
                      can.canCreate
                        ? ` Add your first ${singular.toLowerCase()} to get started.`
                        : ""
                    }`}
            </p>
          ) : props.renderList ? (
            props.renderList(rows, openRow)
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {selectable && (
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        aria-label={selected.length ? "Clear the selection" : "Select all shown"}
                        checked={selected.length > 0}
                        ref={(box) => {
                          if (box) box.indeterminate = selected.length > 0 && !allChecked;
                        }}
                        onChange={() =>
                          setChecked(
                            selected.length > 0 ? new Set() : new Set(rows.map((r) => r.id)),
                          )
                        }
                      />
                    </TableHead>
                  )}
                  {columns.map((c) => (
                    <TableHead
                      key={columnId(c)}
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
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => openRow(row)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") openRow(row);
                    }}
                  >
                    {selectable && (
                      // Clicking the box must not also open the record.
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${props.describe(row)}`}
                          checked={checked.has(row.id)}
                          onChange={() => toggle(row.id)}
                        />
                      </TableCell>
                    )}
                    {columns.map((c) => (
                      <TableCell key={columnId(c)}>{c.cell(row)}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {!props.renderList && list.data && (
            <Pager
              offset={offset}
              pageSize={pageSize}
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

      <BulkDeleteDialog
        open={deleting}
        object={object}
        plural={props.title.toLowerCase()}
        ids={selected.map((r) => r.id)}
        onClose={() => setDeleting(false)}
        onDone={() => setChecked(new Set())}
      />
      {importing && props.importKind && (
        <ImportDialog kind={props.importKind} onClose={() => setImporting(false)} />
      )}

      <Dialog open={editing !== null} onOpenChange={(isOpen) => !isOpen && setEditing(null)}>
        <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {isNew ? `Add ${singular}` : current ? props.describe(current) : ""}
            </DialogTitle>
            <DialogDescription>
              {isNew
                ? null
                : readOnly
                  ? "Your role can view this record but not change it."
                  : `Edit this ${singular.toLowerCase()}. Every change is recorded in History.`}
            </DialogDescription>
          </DialogHeader>

          {!current || (!can.canViewHistory && !props.tabs?.length) ? (
            <>
              {form}
              {current && props.related?.(current)}
            </>
          ) : (
            <Tabs defaultValue="details">
              <TabsList>
                <TabsTrigger value="details">Details</TabsTrigger>
                {props.tabs?.map((t) => (
                  <TabsTrigger key={t.value} value={t.value}>
                    {t.label}
                  </TabsTrigger>
                ))}
                {can.canViewHistory && <TabsTrigger value="history">History</TabsTrigger>}
              </TabsList>
              <TabsContent value="details">
                {form}
                {props.related?.(current)}
              </TabsContent>
              {props.tabs?.map((t) => (
                <TabsContent key={t.value} value={t.value}>
                  {t.render(current)}
                </TabsContent>
              ))}
              {can.canViewHistory && (
                <TabsContent value="history">
                  <History recordType={props.recordType} recordId={current.id} fields={fields} />
                </TabsContent>
              )}
            </Tabs>
          )}

          {duplicates && (
            <div
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm"
            >
              <p className="font-medium text-amber-900">This may already be in Bagger:</p>
              <ul className="mt-1 list-disc pl-5 text-amber-900">
                {duplicates.map((d) => (
                  <li key={d.id}>
                    {d.label} ({d.type})
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={busy}
                onClick={() => {
                  setDuplicates(null);
                  save.mutate(true);
                }}
              >
                Create {singular} anyway
              </Button>
            </div>
          )}

          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}

          <DialogFooter className="sm:justify-between">
            <div className="flex items-center gap-2">
              {current && props.recordActions?.(current, () => setEditing(null))}
              {current &&
                can.canDelete(current.ownerId) &&
                (confirmingDelete ? (
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => remove.mutate()}
                  >
                    Confirm delete
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    Delete
                  </Button>
                ))}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                {readOnly ? "Close" : "Cancel"}
              </Button>
              {!readOnly && (
                <Button type="submit" form="record-form" disabled={busy}>
                  {isNew ? `Create ${singular}` : "Save changes"}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
