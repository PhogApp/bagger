import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { STATUS_TONES } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useApi,
  useStatuses,
  type StatusColor,
  type StatusObject,
  type StatusOption,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";

/**
 * The Admin section where an organization defines its own statuses for
 * leads, contacts, accounts and opportunities.
 */

const LISTS: { object: StatusObject; label: string; note?: string }[] = [
  { object: "leads", label: "Leads" },
  { object: "contacts", label: "Contacts" },
  { object: "accounts", label: "Accounts" },
  {
    object: "opportunities",
    label: "Opportunities",
    note: "These are the pipeline stages, in the order the board shows them. The percentage is the chance of winning a deal at that stage, used for the weighted pipeline total.",
  },
];

const COLORS: { value: StatusColor; label: string }[] = [
  { value: "ocean", label: "Blue" },
  { value: "teal", label: "Teal" },
  { value: "sage", label: "Sage" },
  { value: "mauve", label: "Mauve" },
  { value: "rose", label: "Rose" },
  { value: "neutral", label: "Gray" },
];

/** What a status can do, per list. Lists with one choice show no picker. */
const EFFECTS: Record<StatusObject, { value: StatusOption["effect"]; label: string }[]> = {
  leads: [
    { value: "none", label: "Does nothing" },
    { value: "ends_sequence", label: "Ends their sequence" },
    { value: "do_not_contact", label: "Do not contact" },
  ],
  contacts: [
    { value: "none", label: "Does nothing" },
    { value: "ends_sequence", label: "Ends their sequence" },
    { value: "do_not_contact", label: "Do not contact" },
  ],
  accounts: [{ value: "none", label: "Does nothing" }],
  opportunities: [
    { value: "none", label: "Open" },
    { value: "won", label: "Closed, won" },
    { value: "lost", label: "Closed, lost" },
  ],
};

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

export function StatusSettings({ canEdit }: { canEdit: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: all, error: loadError } = useStatuses();
  const [object, setObject] = useState<StatusObject>("leads");
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [replaceWith, setReplaceWith] = useState("");

  const options = (all ?? []).filter((o) => o.object === object);
  const list = LISTS.find((l) => l.object === object)!;
  const effects = EFFECTS[object];

  // Every change answers with the full, fresh lists.
  const change = useMutation({
    mutationFn: (call: { method: string; path: string; body?: unknown; done?: string }) =>
      api<StatusOption[]>(call.method, call.path, call.body),
    onError: (e: Error) => toast.error(e.message),
    onSuccess: async (fresh, call) => {
      queryClient.setQueryData(["statuses"], fresh);
      toast.success(call.done ?? "Status saved");
      setDeleting(null);
      setReplaceWith("");
      // Renames and replacements change the records themselves.
      for (const key of ["leads", "contacts", "accounts", "opportunities"]) {
        await queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
  const patch = (id: string, body: object) =>
    change.mutate({ method: "PATCH", path: `/api/statuses/${id}`, body });
  const move = (index: number, by: -1 | 1) => {
    const ids = options.map((o) => o.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    change.mutate({
      method: "PUT",
      path: "/api/statuses/order",
      body: { object, ids },
      done: "Order saved",
    });
  };
  const add = () => {
    if (newName.trim() === "") return;
    change.mutate(
      {
        method: "POST",
        path: "/api/statuses",
        body: { object, name: newName },
        done: `${newName.trim()} added`,
      },
      { onSuccess: () => setNewName("") },
    );
  };

  const disabled = !canEdit || change.isPending;

  return (
    <section className="rounded-lg border bg-background">
      <div className="border-b p-4">
        <h2 className="text-lg font-semibold">Statuses</h2>
        <p className="text-sm text-muted-foreground">
          The statuses your organization uses. Renaming one renames it on every record that has
          it. The default is what a new record starts with.
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
              setDeleting(null);
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
        {list.note && <p className="text-sm text-muted-foreground">{list.note}</p>}
        {loadError && <p className="text-sm text-destructive">{loadError.message}</p>}

        <ul className="divide-y rounded-md border">
          {options.map((option, index) => (
            <li key={option.id} className="space-y-2 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    aria-label={`Move ${option.name} up`}
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    aria-label={`Move ${option.name} down`}
                    disabled={disabled || index === options.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
                <NameInput
                  // Remount when the saved name changes so the box shows it.
                  key={option.name}
                  option={option}
                  disabled={disabled}
                  onSave={(name) => patch(option.id, { name })}
                />
                <div className="ml-auto flex items-center gap-2">
                  {/* A swatch of the badge color, beside the picker that sets it. */}
                  <span
                    aria-hidden
                    className={cn("h-5 w-5 shrink-0 rounded-full border", STATUS_TONES[option.color])}
                  />
                  <select
                    aria-label={`Color of ${option.name}`}
                    className={selectClass}
                    value={option.color}
                    disabled={disabled}
                    onChange={(e) => patch(option.id, { color: e.target.value })}
                  >
                    {COLORS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  {effects.length > 1 && (
                    <select
                      aria-label={`What ${option.name} does`}
                      className={selectClass}
                      value={option.effect}
                      disabled={disabled}
                      onChange={(e) => patch(option.id, { effect: e.target.value })}
                    >
                      {effects.map((e) => (
                        <option key={e.value} value={e.value}>
                          {e.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {object === "opportunities" && (
                    <ProbabilityInput
                      key={String(option.probability)}
                      option={option}
                      disabled={disabled}
                      onSave={(probability) => patch(option.id, { probability })}
                    />
                  )}
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      name={`default-${object}`}
                      checked={option.isDefault}
                      disabled={disabled}
                      onChange={() => patch(option.id, { isDefault: true })}
                    />
                    Default
                  </label>
                  <span className="w-16 text-right text-xs text-muted-foreground">
                    {option.inUse > 0 ? `${option.inUse.toLocaleString()} in use` : "unused"}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    aria-label={`Delete ${option.name}`}
                    title={option.isDefault ? "Make another status the default first" : undefined}
                    disabled={disabled || option.isDefault}
                    onClick={() => {
                      change.reset();
                      setReplaceWith("");
                      setDeleting(deleting === option.id ? null : option.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </div>

              {deleting === option.id && (
                <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 p-2 text-sm">
                  {option.inUse > 0 ? (
                    <>
                      <span>
                        {option.inUse.toLocaleString()} {option.inUse === 1 ? "record has" : "records have"}{" "}
                        this status. Move {option.inUse === 1 ? "it" : "them"} to
                      </span>
                      <select
                        aria-label="Replacement status"
                        className={selectClass}
                        value={replaceWith}
                        onChange={(e) => setReplaceWith(e.target.value)}
                      >
                        <option value="">Select…</option>
                        {options
                          .filter((o) => o.id !== option.id)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                      </select>
                    </>
                  ) : (
                    <span>Delete “{option.name}”? No records use it.</span>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={change.isPending || (option.inUse > 0 && !replaceWith)}
                    onClick={() =>
                      change.mutate({
                        method: "DELETE",
                        path: `/api/statuses/${option.id}${replaceWith ? `?replaceWith=${replaceWith}` : ""}`,
                        done: replaceWith
                          ? `${option.name} deleted. Its records are now ${replaceWith}.`
                          : `${option.name} deleted`,
                      })
                    }
                  >
                    Delete status
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setDeleting(null)}>
                    Cancel
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {canEdit && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input
              className="max-w-xs"
              value={newName}
              maxLength={40}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={`New ${list.label.toLowerCase().replace(/ies$/, "y").replace(/s$/, "")} status`}
              aria-label="New status name"
            />
            <Button type="submit" variant="outline" disabled={disabled || newName.trim() === ""}>
              <Plus className="mr-2 h-4 w-4" aria-hidden />
              Add status
            </Button>
          </form>
        )}

        {(object === "leads" || object === "contacts") && (
          <p className="text-xs text-muted-foreground">
            “Ends their sequence” stops a person's sequence when they are given that status. “Do
            not contact” does the same and also keeps them from being enrolled again.
          </p>
        )}
      </div>
    </section>
  );
}

/** A stage's win probability, saved on Enter or on leaving the box. */
function ProbabilityInput(props: {
  option: StatusOption;
  disabled: boolean;
  onSave: (probability: number | null) => void;
}) {
  const saved = props.option.probability;
  const [value, setValue] = useState(saved === null ? "" : String(saved));
  const save = () => {
    const next = value.trim() === "" ? null : Math.round(Number(value));
    if (next !== null && (!Number.isFinite(next) || next < 0 || next > 100)) {
      setValue(saved === null ? "" : String(saved));
    } else if (next !== saved) {
      props.onSave(next);
    }
  };
  return (
    <span className="flex items-center gap-1 text-sm">
      <Input
        className="h-9 w-16 text-right"
        inputMode="numeric"
        value={value}
        disabled={props.disabled}
        aria-label={`Win probability of ${props.option.name}, percent`}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      %
    </span>
  );
}

/** A status name that saves when you press Enter or leave the box. */
function NameInput(props: {
  option: StatusOption;
  disabled: boolean;
  onSave: (name: string) => void;
}) {
  const [value, setValue] = useState(props.option.name);
  const save = () => {
    const next = value.trim();
    if (next === "") setValue(props.option.name);
    else if (next !== props.option.name) props.onSave(next);
  };
  return (
    <Input
      className="h-9 w-36"
      value={value}
      maxLength={40}
      disabled={props.disabled}
      aria-label={`Name of ${props.option.name}`}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
