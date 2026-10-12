import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Archive, Pencil, Plus, RotateCcw, X } from "lucide-react";
import { useState } from "react";
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
import { useApi } from "@/lib/api";
import {
  BUILT_IN_FIELDS,
  TYPE_LABELS,
  WIDTH_FOR,
  useFieldSetup,
  type CustomField,
  type CustomFieldType,
  type FieldSetup,
  type LayoutEntry,
  type LayoutObject,
} from "@/lib/fields";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";

/**
 * Admin → Fields: every field of a record type, Bagger's own and the
 * organization's, in the order the record page shows them. Admins move them,
 * set their width, hide optional ones, and add, edit or archive custom ones.
 */

const LISTS: { object: LayoutObject; label: string }[] = [
  { object: "leads", label: "Leads" },
  { object: "contacts", label: "Contacts" },
  { object: "accounts", label: "Accounts" },
  { object: "opportunities", label: "Opportunities" },
];
const WIDTHS: { value: LayoutEntry["width"]; label: string }[] = [
  { value: "third", label: "Small (⅓)" },
  { value: "half", label: "Medium (½)" },
  { value: "full", label: "Full width" },
];
const PICKLISTS: CustomFieldType[] = ["picklist", "multipicklist"];

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

interface Row {
  entry: LayoutEntry;
  label: string;
  custom?: CustomField;
  locked: boolean;
}

/** The current layout of one record type, with every live field in it exactly once. */
function rowsFor(setup: FieldSetup, object: LayoutObject): Row[] {
  const locked = new Set(setup.builtIn[object].filter((b) => b.locked).map((b) => b.name));
  const all = new Map<string, Row>();
  for (const b of BUILT_IN_FIELDS[object]) {
    all.set(b.name, {
      entry: { field: b.name, width: WIDTH_FOR[b.span] },
      label: b.label,
      locked: locked.has(b.name),
    });
  }
  for (const f of setup.fields.filter((x) => x.object === object && !x.archived)) {
    all.set(`custom.${f.key}`, {
      entry: {
        field: `custom.${f.key}`,
        width: f.type === "longtext" || f.type === "multipicklist" ? "full" : "half",
      },
      label: f.label,
      custom: f,
      locked: false,
    });
  }
  const ordered: Row[] = [];
  for (const e of setup.layouts[object] ?? []) {
    const row = all.get(e.field);
    if (!row) continue;
    ordered.push({ ...row, entry: { ...e } });
    all.delete(e.field);
  }
  return [...ordered, ...all.values()];
}

export function FieldSettings() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: setup, error: loadError } = useFieldSetup();
  const [object, setObject] = useState<LayoutObject>("leads");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CustomField | null>(null);

  const change = useMutation({
    mutationFn: (call: { method: string; path: string; body: unknown; done?: string }) =>
      api<FieldSetup>(call.method, call.path, call.body),
    onSuccess: async (fresh, call) => {
      queryClient.setQueryData(["fields"], fresh);
      toast.success(call.done ?? "Layout saved");
      for (const key of ["leads", "contacts", "accounts", "opportunities"]) {
        await queryClient.invalidateQueries({ queryKey: [key], refetchType: "none" });
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (loadError) return <p className="text-sm text-destructive">{loadError.message}</p>;
  if (!setup) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const rows = rowsFor(setup, object);
  const archived = setup.fields.filter((f) => f.object === object && f.archived);
  const saveLayout = (next: Row[]) => {
    const entries = next.map((r) => r.entry);
    // Show the new order at once; the server's answer replaces it, or a failure puts it back.
    queryClient.setQueryData(["fields"], { ...setup, layouts: { ...setup.layouts, [object]: entries } });
    change.mutate(
      { method: "PUT", path: "/api/fields/layout", body: { object, entries } },
      {
        onError: () => void queryClient.invalidateQueries({ queryKey: ["fields"] }),
      },
    );
  };
  const move = (i: number, by: -1 | 1) => {
    const next = [...rows];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    saveLayout(next);
  };
  const setEntry = (i: number, entry: Partial<LayoutEntry>) =>
    saveLayout(rows.map((r, j) => (j === i ? { ...r, entry: { ...r.entry, ...entry } } : r)));

  return (
    <section className="rounded-lg border bg-background">
      <div className="border-b p-4">
        <h2 className="text-lg font-semibold">Fields</h2>
        <p className="text-sm text-muted-foreground">
          The fields on each record page, in the order shown here. Move them, set their width, hide
          ones you don't use, and add your own. Changes apply to everyone at once.
        </p>
      </div>
      <div className="flex gap-1 border-b px-4 pt-3" role="tablist" aria-label="Record type">
        {LISTS.map((l) => (
          <button
            key={l.object}
            type="button"
            role="tab"
            aria-selected={object === l.object}
            onClick={() => {
              setObject(l.object);
              setAdding(false);
              change.reset();
            }}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              object === l.object
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div className="space-y-3 p-4">
        <ul className="divide-y rounded-md border">
          {rows.map((row, i) => {
            const hidden = Boolean(row.entry.hidden);
            return (
              <li
                key={row.entry.field}
                className={cn("flex flex-wrap items-center gap-2 p-2.5", hidden && "bg-muted/40")}
              >
                <div className="flex">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    aria-label={`Move ${row.label} up`}
                    disabled={change.isPending || i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    aria-label={`Move ${row.label} down`}
                    disabled={change.isPending || i === rows.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
                <div className={cn("min-w-0 flex-1", hidden && "text-muted-foreground")}>
                  <p className="text-sm font-medium">
                    {row.label}
                    {row.custom?.required && <span className="text-destructive"> *</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {row.custom ? `Custom · ${TYPE_LABELS[row.custom.type]}` : "Bagger field"}
                    {hidden && " · hidden"}
                  </p>
                </div>
                <select
                  aria-label={`Width of ${row.label}`}
                  className={selectClass}
                  value={row.entry.width}
                  disabled={change.isPending}
                  onChange={(e) => setEntry(i, { width: e.target.value as LayoutEntry["width"] })}
                >
                  {WIDTHS.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
                {row.locked ? (
                  <span
                    className="w-20 text-xs text-muted-foreground"
                    title="Bagger needs this field"
                  >
                    Always shown
                  </span>
                ) : (
                  <label className="flex w-20 items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={!hidden}
                      disabled={change.isPending}
                      onChange={(e) => setEntry(i, { hidden: !e.target.checked || undefined })}
                    />
                    Shown
                  </label>
                )}
                <div className="flex w-16 justify-end">
                  {row.custom && (
                    <>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        aria-label={`Edit ${row.label}`}
                        onClick={() => setEditing(row.custom!)}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        aria-label={`Archive ${row.label}`}
                        title="Archive: hide everywhere, keep the data"
                        disabled={change.isPending}
                        onClick={() =>
                          change.mutate({
                            method: "PATCH",
                            path: `/api/fields/${row.custom!.id}`,
                            body: { archived: true },
                            done: `${row.label} archived. Find it under Archived to bring it back.`,
                          })
                        }
                      >
                        <Archive className="h-4 w-4" aria-hidden />
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {adding ? (
          <AddField
            object={object}
            onDone={(fresh) => {
              if (fresh) queryClient.setQueryData(["fields"], fresh);
              setAdding(false);
            }}
          />
        ) : (
          <Button type="button" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden />
            Add field
          </Button>
        )}

        {archived.length > 0 && (
          <div>
            <h3 className="mb-1 mt-4 text-sm font-semibold">Archived</h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Hidden everywhere. Their values are kept and come back if you restore them.
            </p>
            <ul className="divide-y rounded-md border">
              {archived.map((f) => (
                <li key={f.id} className="flex items-center gap-2 p-2.5 text-sm">
                  <span className="flex-1 text-muted-foreground">
                    {f.label} · {TYPE_LABELS[f.type]}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={change.isPending}
                    onClick={() =>
                      change.mutate({
                        method: "PATCH",
                        path: `/api/fields/${f.id}`,
                        body: { archived: false },
                        done: `${f.label} restored`,
                      })
                    }
                  >
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {editing && (
        <EditField
          field={editing}
          onClose={(fresh) => {
            if (fresh) queryClient.setQueryData(["fields"], fresh);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function AddField({
  object,
  onDone,
}: {
  object: LayoutObject;
  onDone: (fresh?: FieldSetup) => void;
}) {
  const api = useApi();
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const [required, setRequired] = useState(false);
  const [choices, setChoices] = useState("");
  const options = choices
    .split("\n")
    .map((c) => c.trim())
    .filter(Boolean);
  const create = useMutation({
    mutationFn: () =>
      api<FieldSetup>("POST", "/api/fields", {
        object,
        label,
        type,
        required,
        ...(PICKLISTS.includes(type) ? { options } : {}),
      }),
    onSuccess: (fresh) => {
      onDone(fresh);
      toast.success(`${label} added`);
    },
  });
  return (
    <form
      className="space-y-3 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="new-field-label">Label</Label>
          <Input
            id="new-field-label"
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Current ERP"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-field-type">Type</Label>
          <select
            id="new-field-type"
            className={cn(selectClass, "h-10 w-full")}
            value={type}
            onChange={(e) => setType(e.target.value as CustomFieldType)}
          >
            {Object.entries(TYPE_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </div>
      </div>
      {PICKLISTS.includes(type) && (
        <div className="space-y-1.5">
          <Label htmlFor="new-field-choices">Choices, one per line</Label>
          <textarea
            id="new-field-choices"
            rows={4}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={choices}
            onChange={(e) => setChoices(e.target.value)}
            placeholder={"QuickBooks\nSage\nXero"}
          />
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
        Required on the Add form and record page (not on CSV import)
      </label>
      {create.error && (
        <p role="alert" className="text-sm text-destructive">
          {create.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending || label.trim() === ""}>
          Add field
        </Button>
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

interface Choice {
  /** The choice as it is saved now; null for one being added. */
  original: string | null;
  text: string;
  removed: boolean;
  /** Where its records go when removed; "" clears them. */
  replaceWith: string;
}

function EditField({
  field,
  onClose,
}: {
  field: CustomField;
  onClose: (fresh?: FieldSetup) => void;
}) {
  const api = useApi();
  const [label, setLabel] = useState(field.label);
  const [required, setRequired] = useState(field.required);
  const [choices, setChoices] = useState<Choice[]>(
    field.options.map((o) => ({ original: o, text: o, removed: false, replaceWith: "" })),
  );
  const isPicklist = PICKLISTS.includes(field.type);
  const usage = useQuery({
    queryKey: ["fields", "usage", field.id],
    queryFn: () =>
      api<{ filled: number; byOption: Record<string, number> }>(
        "GET",
        `/api/fields/${field.id}/usage`,
      ),
    enabled: isPicklist,
    gcTime: 0,
  });
  const used = (o: string | null) => (o ? (usage.data?.byOption[o] ?? 0) : 0);
  const kept = choices.filter((c) => !c.removed && c.text.trim() !== "");

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { label, required };
      if (isPicklist) {
        body.options = kept.map((c) => c.text.trim());
        body.renamed = Object.fromEntries(
          kept
            .filter((c) => c.original && c.original !== c.text.trim())
            .map((c) => [c.original, c.text.trim()]),
        );
        body.replace = Object.fromEntries(
          choices
            .filter((c) => c.removed && c.original && used(c.original) > 0)
            .map((c) => {
              // Point at the replacement's new name if it was renamed too.
              const target = choices.find(
                (x) => x.original === c.replaceWith || x.text === c.replaceWith,
              );
              return [
                c.original,
                c.replaceWith === "" ? null : (target?.text.trim() ?? c.replaceWith),
              ];
            }),
        );
      }
      return api<FieldSetup>("PATCH", `/api/fields/${field.id}`, body);
    },
    onSuccess: (fresh) => {
      onClose(fresh);
      toast.success(`${label} saved`);
    },
  });
  const update = (i: number, patch: Partial<Choice>) =>
    setChoices((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {field.label}</DialogTitle>
          <DialogDescription>
            {TYPE_LABELS[field.type]}. Renaming a choice renames it on every record that has it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="edit-field-label">Label</Label>
            <Input
              id="edit-field-label"
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />
            Required on the Add form and record page
          </label>
          {isPicklist && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Choices</p>
              {choices.map((c, i) =>
                c.removed ? (
                  <div
                    key={i}
                    className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 p-2 text-sm"
                  >
                    <span className="line-through">{c.original}</span>
                    {used(c.original) > 0 ? (
                      <>
                        <span>
                          {used(c.original)} {used(c.original) === 1 ? "record" : "records"} →
                          change to
                        </span>
                        <select
                          aria-label={`Replacement for ${c.original}`}
                          className={selectClass}
                          value={c.replaceWith}
                          onChange={(e) => update(i, { replaceWith: e.target.value })}
                        >
                          <option value="">(clear the value)</option>
                          {kept.map((k) => (
                            <option key={k.text} value={k.text.trim()}>
                              {k.text.trim()}
                            </option>
                          ))}
                        </select>
                      </>
                    ) : (
                      <span className="text-muted-foreground">not used</span>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => update(i, { removed: false })}
                    >
                      Undo
                    </Button>
                  </div>
                ) : (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      aria-label={`Choice ${i + 1}`}
                      className="h-9"
                      value={c.text}
                      onChange={(e) => update(i, { text: e.target.value })}
                    />
                    <span className="w-16 text-right text-xs text-muted-foreground">
                      {c.original ? `${used(c.original)} in use` : "new"}
                    </span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      aria-label={`Remove ${c.text}`}
                      onClick={() =>
                        c.original
                          ? update(i, { removed: true })
                          : setChoices((prev) => prev.filter((_, j) => j !== i))
                      }
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                ),
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setChoices((prev) => [
                    ...prev,
                    { original: null, text: "", removed: false, replaceWith: "" },
                  ])
                }
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                Add choice
              </Button>
            </div>
          )}
          {save.error && (
            <p role="alert" className="text-sm text-destructive">
              {save.error.message}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending || label.trim() === "" || (isPicklist && kept.length === 0)}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
