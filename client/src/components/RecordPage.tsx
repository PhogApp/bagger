import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
import { permissionsFor, useApi, useMe } from "@/lib/api";
import { cn, formatDateTime } from "@/lib/utils";

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
  kind?: "text" | "email" | "tel" | "url" | "textarea" | "select";
  required?: boolean;
  options?: Option[];
  placeholder?: string;
  /** Columns out of 6 the field spans in the form. Defaults to 3 (half width). */
  span?: 2 | 3 | 6;
  /** Height of a textarea, in lines. */
  rows?: number;
  /** Short guidance shown under the field. */
  help?: string;
  /** Converts the form's text value before sending, e.g. "true" to true. */
  parse?: (value: string) => unknown;
}

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
}

interface BaseRecord {
  id: string;
  ownerId: string;
}

export interface RecordPageProps<T extends BaseRecord> {
  object: "leads" | "contacts" | "accounts" | "templates" | "sequences";
  /** Name used by audit history, e.g. "lead". */
  recordType: string;
  title: string;
  subtitle: string;
  singular: string;
  searchPlaceholder: string;
  fields: Field[];
  columns: Column<T>[];
  defaults?: Record<string, string>;
  /** Heading for the edit dialog. */
  describe: (row: T) => string;
  /** When set, clicking a row calls this instead of opening the edit dialog. */
  onRowOpen?: (row: T) => void;
}

interface HistoryEntry {
  id: string;
  action: "create" | "update" | "delete";
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  source: "user" | "import" | "system";
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
      {field.kind === "textarea" ? (
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
          type={field.kind === "url" ? "text" : (field.kind ?? "text")}
          inputMode={field.kind === "url" ? "url" : undefined}
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

function History({
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
    return option?.label ?? value;
  };

  return (
    <ol className="max-h-96 space-y-3 overflow-y-auto py-2">
      {data.map((h) => (
        <li key={h.id} className="border-l-2 border-border pl-3 text-sm">
          {h.action === "update" ? (
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
            <p className="font-medium">{h.action === "create" ? "Created" : "Deleted"}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {h.userName ?? "System"} · {formatDateTime(h.at)}
            {h.source !== "user" && ` · ${h.source}`}
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

  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const [editing, setEditing] = useState<T | "new" | null>(null);
  const [values, setValues] = useState<Values>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const list = useQuery({
    queryKey: [object, q],
    queryFn: () => api<T[]>("GET", `/api/${object}${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  });

  const blank = useMemo(
    () => Object.fromEntries(fields.map((f) => [f.name, props.defaults?.[f.name] ?? ""])),
    [fields, props.defaults],
  );

  function open(target: T | "new") {
    const row = target === "new" ? null : (target as unknown as Record<string, unknown>);
    setValues(
      row ? Object.fromEntries(fields.map((f) => [f.name, String(row[f.name] ?? "")])) : blank,
    );
    setFormError(null);
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

  const openRow = (row: T) => (props.onRowOpen ? props.onRowOpen(row) : open(row));

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: [object] });
    setEditing(null);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (editing === "new") {
        // Leave out blanks so the server applies its defaults.
        const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
        return api("POST", `/api/${object}`, parsed(body));
      }
      const row = editing as unknown as Record<string, unknown>;
      const changed = Object.fromEntries(
        Object.entries(values).filter(([name, v]) => v !== String(row[name] ?? "")),
      );
      if (Object.keys(changed).length === 0) return null;
      return api("PATCH", `/api/${object}/${(editing as T).id}`, parsed(changed));
    },
    onSuccess: done,
    onError: (e: Error) => setFormError(relabel(e.message)),
  });

  const remove = useMutation({
    mutationFn: () => api("DELETE", `/api/${object}/${(editing as T).id}`),
    onSuccess: done,
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
        save.mutate();
      }}
    >
      {fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          idPrefix={object}
          value={values[field.name] ?? ""}
          onChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
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
          <p className="text-sm text-muted-foreground">{props.subtitle}</p>
        </div>
        {can.canCreate && (
          <Button onClick={() => open("new")}>
            <Plus className="mr-2 h-4 w-4" aria-hidden />
            Add {singular}
          </Button>
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
                placeholder={props.searchPlaceholder}
                aria-label={props.searchPlaceholder}
              />
            </div>
          </div>

          {list.error ? (
            <p className="p-8 text-center text-sm text-destructive">{list.error.message}</p>
          ) : list.isLoading ? (
            <p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : list.data?.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {q
                ? `No ${props.title.toLowerCase()} match “${q}”.`
                : `No ${props.title.toLowerCase()} yet.${
                    can.canCreate ? ` Add your first ${singular.toLowerCase()} to get started.` : ""
                  }`}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {props.columns.map((c) => (
                    <TableHead key={c.header}>{c.header}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data?.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => openRow(row)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") openRow(row);
                    }}
                  >
                    {props.columns.map((c) => (
                      <TableCell key={c.header}>{c.cell(row)}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      <Dialog open={editing !== null} onOpenChange={(isOpen) => !isOpen && setEditing(null)}>
        <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {isNew ? `Add ${singular}` : current ? props.describe(current) : ""}
            </DialogTitle>
            <DialogDescription>
              {isNew
                ? `Fields marked * are required.`
                : readOnly
                  ? "Your role can view this record but not change it."
                  : `Edit this ${singular.toLowerCase()}. Every change is recorded in History.`}
            </DialogDescription>
          </DialogHeader>

          {isNew || !can.canViewHistory ? (
            form
          ) : (
            <Tabs defaultValue="details">
              <TabsList>
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>
              <TabsContent value="details">{form}</TabsContent>
              <TabsContent value="history">
                {current && (
                  <History recordType={props.recordType} recordId={current.id} fields={fields} />
                )}
              </TabsContent>
            </Tabs>
          )}

          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}

          <DialogFooter className="sm:justify-between">
            <div>
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
