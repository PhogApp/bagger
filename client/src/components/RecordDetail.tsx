import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Pencil } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ActivityTimeline, type ActivityAbout } from "@/components/ActivityTimeline";
import { RecordTodos } from "@/components/Todos";
import { asText, History, MultiSelect, toBody, valueOf, type Field } from "@/components/RecordPage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, permissionsFor, useApi, useMe } from "@/lib/api";
import { cn, formatDay, formatPhone } from "@/lib/utils";

/**
 * A record's own page: its fields on the left, its activity and history on
 * the right. Fields read as plain text; click one to change it, and it saves
 * when you press Enter or move away. Escape puts it back. There is no Save
 * button because there is never anything unsaved.
 */

type Row = { id: string; ownerId: string } & Record<string, unknown>;

export interface RecordDetailProps<T extends Row> {
  object: "leads" | "contacts" | "accounts" | "opportunities";
  recordType: string;
  id: string;
  listHref: string;
  listLabel: string;
  fields: Field[];
  title: (row: T) => string;
  /** Under the title: company, account, and so on. */
  subtitle?: (row: T) => ReactNode;
  /** Beside the title, e.g. the status badge. */
  badge?: (row: T) => ReactNode;
  /** Buttons at the top right, e.g. Convert or Enroll. Delete is added on its own. */
  actions?: (row: T) => ReactNode;
  /** Under the fields, e.g. an account's contacts and opportunities. */
  below?: (row: T) => ReactNode;
  activity: (row: T) => ActivityAbout;
  /** Where to send someone who opens this record instead, e.g. a converted lead's contact. */
  redirect?: (row: T) => string | null;
  /** When set, the record can't be changed and this says why. */
  frozen?: (row: T) => ReactNode | null;
  /** How a field reads when it isn't being edited, when plain text won't do. */
  display?: Record<string, (row: T) => ReactNode>;
  /** A question to ask before saving a change with side effects; null to just save. */
  confirm?: (field: string, value: string, row: T) => string | null;
}

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const SPAN = { 2: "sm:col-span-2", 3: "sm:col-span-3", 6: "sm:col-span-6" } as const;

/** How a stored value reads, by the kind of field. */
function shown(field: Field, raw: unknown): ReactNode {
  if (field.format) return field.format(raw);
  const value = asText(raw);
  if (value === "") return null;
  switch (field.kind) {
    case "select":
      return field.options?.find((o) => o.value === value)?.label ?? value;
    case "email":
      return (
        <a
          href={`mailto:${value}`}
          className="text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {value}
        </a>
      );
    case "url":
      return (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className="break-all text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {value.replace(/^https?:\/\/(www\.)?/, "")}
        </a>
      );
    case "tel":
      return formatPhone(value);
    case "date":
      return formatDay(value);
    case "textarea":
      return <span className="whitespace-pre-line">{value}</span>;
    default:
      return value;
  }
}

function InlineField<T extends Row>(props: {
  field: Field;
  row: T;
  editable: boolean;
  display?: (row: T) => ReactNode;
  confirm?: (value: string) => string | null;
  save: (value: string) => Promise<void>;
}) {
  const { field, row } = props;
  const stored = asText(valueOf(row, field.name));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ question: string; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const box = useRef<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>(null);
  const id = `field-${field.name}`;

  useEffect(() => {
    if (editing) box.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);

  const start = () => {
    if (!props.editable) return;
    setDraft(stored);
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setAsking(null);
    setError(null);
  };
  const commit = async (value: string, confirmed = false) => {
    if (value.trim() === stored.trim()) return cancel();
    if (field.required && value.trim() === "") {
      setError(`${field.label} is required`);
      return;
    }
    const question = confirmed ? null : (props.confirm?.(value) ?? null);
    if (question) {
      setAsking({ question, value });
      return;
    }
    setSaving(true);
    try {
      await props.save(value);
      setEditing(false);
      setAsking(null);
      setError(null);
      setSaved(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message.replace(`${field.name}:`, `${field.label}:`) : "Not saved",
      );
      setEditing(true);
    } finally {
      setSaving(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === "Enter" && (field.kind !== "textarea" || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void commit(draft);
    }
  };

  const reading = props.display?.(row) ?? shown(field, valueOf(row, field.name));

  return (
    <div className={cn("col-span-6 min-w-0", SPAN[field.span ?? 3])}>
      <label
        htmlFor={editing ? id : undefined}
        className="text-xs font-medium text-muted-foreground"
      >
        {field.label}
        {saved && (
          <span role="status" className="ml-2 inline-flex items-center gap-0.5 text-brand-teal">
            <Check className="h-3 w-3" aria-hidden /> Saved
          </span>
        )}
      </label>
      {editing ? (
        <div className="mt-1 space-y-1">
          {field.kind === "multiselect" ? (
            <div
              onBlur={(e) => {
                // Save once focus leaves the whole group of ticks.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void commit(draft);
              }}
              onKeyDown={onKey}
            >
              <MultiSelect
                id={id}
                options={field.options ?? []}
                value={draft}
                disabled={saving}
                onChange={setDraft}
              />
              <div className="flex gap-2">
                <Button size="sm" disabled={saving} onClick={() => void commit(draft)}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={cancel}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : field.kind === "select" ? (
            <select
              id={id}
              ref={box}
              className={selectClass}
              value={draft}
              disabled={saving}
              onChange={(e) => {
                setDraft(e.target.value);
                void commit(e.target.value);
              }}
              onBlur={() => !asking && cancel()}
              onKeyDown={onKey}
            >
              {!field.required && <option value="">—</option>}
              {field.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : field.kind === "textarea" ? (
            <Textarea
              id={id}
              ref={box}
              rows={field.rows ?? 4}
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => !asking && void commit(draft)}
              onKeyDown={onKey}
            />
          ) : (
            <Input
              id={id}
              ref={box}
              className="h-9"
              type={
                field.kind === "date" || field.kind === "email" || field.kind === "tel"
                  ? field.kind
                  : "text"
              }
              inputMode={
                field.kind === "url" ? "url" : field.kind === "number" ? "decimal" : undefined
              }
              placeholder={field.placeholder}
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => !asking && void commit(draft)}
              onKeyDown={onKey}
            />
          )}
          {asking && (
            <div
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900"
            >
              <p>{asking.question}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" disabled={saving} onClick={() => void commit(asking.value, true)}>
                  Yes, change it
                </Button>
                <Button size="sm" variant="ghost" onClick={cancel}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      ) : props.editable ? (
        <div
          role="button"
          tabIndex={0}
          aria-label={`Edit ${field.label}`}
          onClick={start}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              start();
            }
          }}
          className={cn(
            "group -mx-2 mt-0.5 flex min-h-9 cursor-text items-start gap-2 rounded-md px-2 py-1.5 text-sm",
            "hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <span className="min-w-0 flex-1 break-words">
            {reading ?? <span className="text-muted-foreground">—</span>}
          </span>
          <Pencil
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100"
            aria-hidden
          />
        </div>
      ) : (
        <div className="mt-0.5 min-h-9 py-1.5 text-sm break-words">
          {reading ?? <span className="text-muted-foreground">—</span>}
        </div>
      )}
    </div>
  );
}

export function RecordDetail<T extends Row>(props: RecordDetailProps<T>) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { data: me } = useMe();
  const can = permissionsFor(me, props.object);
  const key = [props.object, "one", props.id];

  const record = useQuery({
    queryKey: key,
    queryFn: () => api<T>("GET", `/api/${props.object}/${props.id}`),
  });

  const goTo = record.data ? (props.redirect?.(record.data) ?? null) : null;
  useEffect(() => {
    if (goTo) navigate(goTo, { replace: true });
  }, [goTo, navigate]);

  // The last change, so it can be put back.
  const [undo, setUndo] = useState<{ field: Field; value: unknown } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(timer);
  }, [undo]);

  const refresh = async (updated: T) => {
    queryClient.setQueryData(key, updated);
    await queryClient.invalidateQueries({ queryKey: [props.object], refetchType: "none" });
    await queryClient.invalidateQueries({ queryKey: ["history", props.recordType, props.id] });
  };
  const patch = async (name: string, value: unknown) =>
    refresh(await api<T>("PATCH", `/api/${props.object}/${props.id}`, toBody({ [name]: value })));

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const remove = useMutation({
    mutationFn: () => api("DELETE", `/api/${props.object}/${props.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [props.object] });
      navigate(props.listHref);
    },
  });

  const back = (
    <Link
      href={props.listHref}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {props.listLabel}
    </Link>
  );

  if (record.isLoading || goTo)
    return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  if (record.error || !record.data) {
    const gone = record.error instanceof ApiError && record.error.status === 404;
    return (
      <div className="space-y-4 p-6">
        {back}
        <p className="text-sm text-destructive">
          {gone ? "This record no longer exists, or was deleted." : record.error?.message}
        </p>
      </div>
    );
  }

  const row = record.data;
  const frozen = props.frozen?.(row) ?? null;
  const editable = !frozen && can.canEdit(row.ownerId);

  return (
    <div>
      <div className="border-b bg-background px-6 py-4">
        {back}
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{props.title(row)}</h1>
              {props.badge?.(row)}
            </div>
            {props.subtitle && (
              <div className="text-sm text-muted-foreground">{props.subtitle(row)}</div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!frozen && props.actions?.(row)}
            {!frozen &&
              can.canDelete(row.ownerId) &&
              (confirmingDelete ? (
                <>
                  <Button
                    variant="destructive"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    Confirm delete
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete
                </Button>
              ))}
          </div>
        </div>
        {remove.error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {remove.error.message}
          </p>
        )}
        {frozen && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {frozen}
          </div>
        )}
      </div>

      <div className="grid gap-6 p-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <section className="rounded-lg border bg-background p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Details</h2>
              {editable && (
                <p className="text-xs text-muted-foreground">
                  Click a field to change it. Changes save on their own.
                </p>
              )}
            </div>
            <div className="grid grid-cols-6 gap-x-5 gap-y-3">
              {props.fields.map((field) => (
                <InlineField
                  key={field.name}
                  field={field}
                  row={row}
                  editable={editable}
                  display={props.display?.[field.name]}
                  confirm={
                    props.confirm ? (value) => props.confirm!(field.name, value, row) : undefined
                  }
                  save={async (value) => {
                    const before = valueOf(row, field.name);
                    await patch(field.name, field.parse ? field.parse(value) : value);
                    setUndo({ field, value: before ?? "" });
                  }}
                />
              ))}
            </div>
            {undo && (
              <div
                role="status"
                className="mt-4 flex items-center gap-3 rounded-md bg-muted/70 px-3 py-2 text-sm"
              >
                <span>{undo.field.label} saved.</span>
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={async () => {
                    const { field, value } = undo;
                    setUndo(null);
                    await patch(field.name, value);
                  }}
                >
                  Undo
                </button>
              </div>
            )}
          </section>
          {props.below?.(row)}
        </div>

        <div className="space-y-6">
          <RecordTodos about={props.activity(row)} />
          <section className="rounded-lg border bg-background p-5">
            <Tabs defaultValue="activity">
              <TabsList>
                <TabsTrigger value="activity">Activity</TabsTrigger>
                {can.canViewHistory && <TabsTrigger value="history">History</TabsTrigger>}
              </TabsList>
              <TabsContent value="activity">
                <ActivityTimeline about={props.activity(row)} />
              </TabsContent>
              {can.canViewHistory && (
                <TabsContent value="history">
                  <History recordType={props.recordType} recordId={row.id} fields={props.fields} />
                </TabsContent>
              )}
            </Tabs>
          </section>
        </div>
      </div>
    </div>
  );
}
