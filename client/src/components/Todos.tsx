import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import type { ActivityAbout } from "@/components/ActivityTimeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { permissionsFor, useApi, useMe, useOrgUsers, type Todo, type TodoType } from "@/lib/api";
import { cn, formatDay } from "@/lib/utils";

/**
 * To-dos: one-off tasks with a due date. Shown on each record page and in
 * Run Steps. Ticking one off a call, email, LinkedIn or meeting to-do also
 * logs the activity.
 */

export const TODO_TYPES: { value: TodoType; label: string }[] = [
  { value: "todo", label: "To-do" },
  { value: "call", label: "Call" },
  { value: "email", label: "Email" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "meeting", label: "Meeting" },
];

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Today in the viewer's own time, as YYYY-MM-DD. */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dueLabel(day: string): { text: string; late: boolean } {
  const today = todayLocal();
  if (day === today) return { text: "Today", late: false };
  if (day === shiftDays(today, 1)) return { text: "Tomorrow", late: false };
  return { text: formatDay(day), late: day < today };
}

/** Where the to-do points: the person, opportunity or account it is about. */
function aboutLink(t: Todo) {
  if (t.contactId) return { href: `/contacts/${t.contactId}`, text: t.personName ?? "Contact" };
  if (t.leadId) return { href: `/leads/${t.leadId}`, text: t.personName ?? "Lead" };
  if (t.opportunityId)
    return { href: `/opportunities/${t.opportunityId}`, text: t.opportunityName ?? "Opportunity" };
  if (t.accountId) return { href: `/accounts/${t.accountId}`, text: t.accountName ?? "Account" };
  return null;
}

export function useTodos(query: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["todos", query],
    queryFn: () => api<Todo[]>("GET", `/api/todos?${query}`),
    enabled,
    refetchInterval: 60_000,
  });
}

/** A list of to-dos with a tick box each, and a way to move or delete one. */
export function TodoList(props: { todos: Todo[]; showAbout?: boolean; empty: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const can = permissionsFor(me, "activities");
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (call: { method: string; path: string; body?: unknown }) =>
      api(call.method, call.path, call.body),
    onSuccess: async () => {
      setMoving(null);
      setError(null);
      for (const key of ["todos", "activities", "dashboard"]) {
        await queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  if (props.todos.length === 0)
    return <p className="text-sm text-muted-foreground">{props.empty}</p>;
  return (
    <div>
      <ul className="divide-y">
        {props.todos.map((t) => {
          const due = dueLabel(t.dueOn);
          const about = props.showAbout ? aboutLink(t) : null;
          const editable = can.canEdit(t.ownerId);
          const done = t.state === "done";
          return (
            <li key={t.id} className="flex items-start gap-3 py-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                aria-label={done ? `Reopen ${t.title}` : `Done: ${t.title}`}
                checked={done}
                disabled={!editable || act.isPending}
                onChange={() =>
                  act.mutate({
                    method: "POST",
                    path: `/api/todos/${t.id}/${done ? "reopen" : "complete"}`,
                    body: {},
                  })
                }
              />
              <div className="min-w-0 flex-1">
                <p className={cn("font-medium", done && "text-muted-foreground line-through")}>
                  {t.type !== "todo" && (
                    <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-xs font-normal">
                      {TODO_TYPES.find((x) => x.value === t.type)?.label}
                    </span>
                  )}
                  {t.title}
                </p>
                {t.notes && <p className="whitespace-pre-line text-muted-foreground">{t.notes}</p>}
                <p className="text-xs text-muted-foreground">
                  <span className={cn(due.late && !done && "font-medium text-destructive")}>
                    {due.late && !done ? `Overdue · ${due.text}` : due.text}
                  </span>
                  {t.ownerId !== me?.user.id && ` · for ${t.ownerName ?? "someone"}`}
                  {about && (
                    <>
                      {" · "}
                      <Link href={about.href} className="text-primary hover:underline">
                        {about.text}
                      </Link>
                    </>
                  )}
                </p>
                {moving === t.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {[
                      ["Tomorrow", 1],
                      ["In 3 days", 3],
                      ["Next week", 7],
                    ].map(([label, n]) => (
                      <Button
                        key={label}
                        size="sm"
                        variant="outline"
                        className="h-8"
                        onClick={() =>
                          act.mutate({
                            method: "PATCH",
                            path: `/api/todos/${t.id}`,
                            body: { dueOn: shiftDays(todayLocal(), n as number) },
                          })
                        }
                      >
                        {label}
                      </Button>
                    ))}
                    <Input
                      type="date"
                      aria-label="New due date"
                      className="h-8 w-40"
                      defaultValue={t.dueOn}
                      onChange={(e) =>
                        e.target.value &&
                        act.mutate({
                          method: "PATCH",
                          path: `/api/todos/${t.id}`,
                          body: { dueOn: e.target.value },
                        })
                      }
                    />
                  </div>
                )}
              </div>
              {editable && !done && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 text-muted-foreground"
                  aria-label={`Reschedule ${t.title}`}
                  onClick={() => setMoving(moving === t.id ? null : t.id)}
                >
                  <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                </Button>
              )}
              {(t.createdBy === me?.user.id ||
                t.ownerId === me?.user.id ||
                can.canDelete(t.ownerId)) && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete ${t.title}`}
                  disabled={act.isPending}
                  onClick={() => act.mutate({ method: "DELETE", path: `/api/todos/${t.id}` })}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A short form to add a to-do, optionally about a record. */
export function AddTodo(props: { about?: ActivityAbout; onDone?: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const { data: users } = useOrgUsers();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<TodoType>("todo");
  const [dueOn, setDueOn] = useState(todayLocal);
  const [ownerId, setOwnerId] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api("POST", "/api/todos", {
        ...props.about,
        title,
        type,
        dueOn,
        ...(ownerId ? { ownerId } : {}),
      }),
    onSuccess: async () => {
      setTitle("");
      setType("todo");
      setDueOn(todayLocal());
      setOwnerId("");
      setOpen(false);
      for (const key of ["todos", "dashboard"])
        await queryClient.invalidateQueries({ queryKey: [key] });
      props.onDone?.();
    },
  });
  if (!permissionsFor(me, "activities").canCreate) return null;
  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-4 w-4" aria-hidden />
        Add to-do
      </Button>
    );
  }
  return (
    <form
      className="space-y-2 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Input
        aria-label="What needs doing"
        placeholder="Call back about pricing, send the proposal, …"
        value={title}
        maxLength={200}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Kind of to-do"
          className={selectClass}
          value={type}
          onChange={(e) => setType(e.target.value as TodoType)}
        >
          {TODO_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <Input
          type="date"
          aria-label="Due"
          className="h-9 w-40"
          value={dueOn}
          onChange={(e) => setDueOn(e.target.value)}
        />
        <select
          aria-label="For"
          className={selectClass}
          value={ownerId}
          onChange={(e) => setOwnerId(e.target.value)}
        >
          <option value="">For me</option>
          {(users ?? [])
            .filter((u) => u.id !== me?.user.id)
            .map((u) => (
              <option key={u.id} value={u.id}>
                For {u.name}
              </option>
            ))}
        </select>
      </div>
      {create.error && (
        <p role="alert" className="text-sm text-destructive">
          {create.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={create.isPending || title.trim() === "" || !dueOn}
        >
          Save to-do
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The To-dos card on a record page: open ones first, then a few recently done. */
export function RecordTodos({ about }: { about: ActivityAbout }) {
  const [key, value] = Object.entries(about)[0];
  const open = useTodos(`${key}=${value}&show=open`);
  const done = useTodos(`${key}=${value}&show=done&limit=5`);
  const [showDone, setShowDone] = useState(false);
  return (
    <section className="rounded-lg border bg-background p-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          To-dos
          {open.data && open.data.length > 0 && (
            <span className="ml-2 font-normal text-muted-foreground">{open.data.length}</span>
          )}
        </h2>
        <AddTodo about={about} />
      </div>
      {open.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <TodoList todos={open.data ?? []} empty="Nothing to do here yet." />
      )}
      {(done.data?.length ?? 0) > 0 && (
        <div className="mt-2">
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => setShowDone(!showDone)}
          >
            {showDone ? "Hide done" : `Show recently done (${done.data!.length})`}
          </button>
          {showDone && <TodoList todos={done.data ?? []} empty="" />}
        </div>
      )}
    </section>
  );
}
