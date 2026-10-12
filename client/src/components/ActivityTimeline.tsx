import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarCheck,
  CalendarPlus,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  StickyNote,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "wouter";
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
import { Textarea } from "@/components/ui/textarea";
import {
  permissionsFor,
  useApi,
  useMe,
  useOrgUsers,
  type Activity,
  type ActivityStatus,
  type ActivityType,
} from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn, formatDateTime, formatDay } from "@/lib/utils";

/** What one record's timeline is about: exactly one of these. */
export type ActivityAbout =
  { leadId: string } | { contactId: string } | { accountId: string } | { opportunityId: string };

export const ACTIVITY_TYPES: {
  value: ActivityType;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "call", label: "Call", icon: Phone },
  { value: "email", label: "Email", icon: Mail },
  { value: "linkedin", label: "LinkedIn", icon: MessageSquare },
  { value: "meeting", label: "Meeting", icon: CalendarCheck },
  { value: "note", label: "Note", icon: StickyNote },
];

export const typeOf = (a: { type: ActivityType }) =>
  ACTIVITY_TYPES.find((t) => t.value === a.type) ?? ACTIVITY_TYPES[4];

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

/** "2026-10-12T07:30" in the viewer's own time, for a datetime-local box. */
function localInput(d: Date = new Date()): string {
  const copy = new Date(d);
  copy.setMinutes(copy.getMinutes() - copy.getTimezoneOffset());
  return copy.toISOString().slice(0, 16);
}

/** Today's calendar date in the viewer's time zone. */
export function todayLocal(): string {
  return localInput().slice(0, 10);
}

/** The page of the record an activity is about: the opportunity, else the person, else the account. */
export function relatedOf(a: Activity): { label: string; path: string } | null {
  if (a.opportunityId)
    return { label: a.opportunityName ?? "Opportunity", path: `/opportunities/${a.opportunityId}` };
  if (a.contactId) return { label: a.personName ?? "Contact", path: `/contacts/${a.contactId}` };
  if (a.leadId) return { label: a.personName ?? "Lead", path: `/leads/${a.leadId}` };
  if (a.accountId) return { label: a.accountName ?? "Account", path: `/accounts/${a.accountId}` };
  return null;
}

/** Open, Overdue or Completed, as a small colored label. */
export function ActivityStatusBadge({ a }: { a: Activity }) {
  const [text, tone] =
    a.status === "completed"
      ? ["Completed", "bg-emerald-50 text-emerald-800 border-emerald-200"]
      : a.overdue
        ? ["Overdue", "bg-red-50 text-red-800 border-red-200"]
        : ["Open", "bg-sky-50 text-sky-800 border-sky-200"];
  return (
    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium", tone)}>
      {text}
    </span>
  );
}

/** "Overdue · Oct 9", "Due today" or "Due Oct 14". */
export function dueText(a: Activity): string {
  if (!a.dueOn) return "";
  if (a.overdue) return `Overdue · was due ${formatDay(a.dueOn)}`;
  if (a.dueOn === todayLocal()) return "Due today";
  return `Due ${formatDay(a.dueOn)}`;
}

type PickKind = "leads" | "contacts" | "accounts" | "opportunities";
const PICK_KINDS: { value: PickKind; label: string; key: keyof ActivityAboutAll }[] = [
  { value: "leads", label: "Lead", key: "leadId" },
  { value: "contacts", label: "Contact", key: "contactId" },
  { value: "accounts", label: "Account", key: "accountId" },
  { value: "opportunities", label: "Opportunity", key: "opportunityId" },
];
type ActivityAboutAll = {
  leadId: string;
  contactId: string;
  accountId: string;
  opportunityId: string;
};
interface Picked {
  about: ActivityAbout;
  label: string;
}

/** Find the lead, contact, account or opportunity a new activity is about. */
function RecordPicker(props: { value: Picked | null; onChange: (v: Picked | null) => void }) {
  const api = useApi();
  const [kind, setKind] = useState<PickKind>("contacts");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const found = useQuery({
    queryKey: [kind, "pick", debounced],
    enabled: debounced.length > 0 && !props.value,
    queryFn: () =>
      api<Record<string, unknown>[]>(
        "GET",
        `/api/${kind}?q=${encodeURIComponent(debounced)}&limit=8`,
      ),
  });
  const nameOf = (r: Record<string, unknown>) =>
    kind === "leads" || kind === "contacts"
      ? `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() +
        (r.company ? ` · ${r.company}` : r.email ? ` · ${r.email}` : "")
      : String(r.name ?? "");
  const pickKind = PICK_KINDS.find((k) => k.value === kind)!;

  if (props.value) {
    return (
      <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
        <span>{props.value.label}</span>
        <Button type="button" size="sm" variant="ghost" onClick={() => props.onChange(null)}>
          Change
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <select
          aria-label="Record type"
          className={cn(selectClass, "w-40")}
          value={kind}
          onChange={(e) => setKind(e.target.value as PickKind)}
        >
          {PICK_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <Input
          id="activity-related"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${pickKind.label.toLowerCase()}s…`}
        />
      </div>
      {debounced && (
        <ul className="max-h-48 overflow-y-auto rounded-md border text-sm">
          {found.isLoading ? (
            <li className="px-3 py-2 text-muted-foreground">Searching…</li>
          ) : found.data?.length ? (
            found.data.map((r) => (
              <li key={String(r.id)}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left hover:bg-muted/60"
                  onClick={() =>
                    props.onChange({
                      about: { [pickKind.key]: String(r.id) } as ActivityAbout,
                      label: `${pickKind.label}: ${nameOf(r)}`,
                    })
                  }
                >
                  {nameOf(r)}
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-2 text-muted-foreground">No matches.</li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Add or change one activity. Done ones have the time they happened; open ones
 * a due date and an owner. A new one is either about a record given by the
 * page or one chosen here.
 */
export function ActivityDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The activity to change; leave out to add one. */
  activity?: Activity | null;
  /** The record a new activity is about; leave out to choose one. */
  about?: ActivityAbout;
  /** For a new one: logging something done, or planning something to do. */
  startAs?: ActivityStatus;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const { data: users } = useOrgUsers();
  const can = permissionsFor(me, "activities");
  const existing = props.activity ?? null;

  const [type, setType] = useState<ActivityType>("call");
  const [status, setStatus] = useState<ActivityStatus>("completed");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [dueOn, setDueOn] = useState(todayLocal());
  const [when, setWhen] = useState(localInput());
  // Untouched, "when" means now (or, for an existing one, what it already says).
  const [whenChanged, setWhenChanged] = useState(false);
  const [ownerId, setOwnerId] = useState("");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setType(existing?.type ?? "call");
    setStatus(existing?.status ?? props.startAs ?? "completed");
    setSubject(existing?.subject ?? "");
    setBody(existing?.body ?? "");
    setDueOn(existing?.dueOn ?? todayLocal());
    setWhen(existing?.occurredAt ? localInput(new Date(existing.occurredAt)) : localInput());
    setWhenChanged(false);
    setOwnerId(existing?.ownerId ?? me?.user.id ?? "");
    setPicked(null);
    setConfirmingDelete(false);
    save.reset();
    remove.reset();
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, existing?.id]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["activities"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!existing) {
        const about = props.about ?? picked?.about;
        if (!about) throw new Error("Choose who or what this activity is about");
        return api("POST", "/api/activities", {
          ...about,
          type,
          status,
          subject,
          body,
          ownerId: ownerId || undefined,
          ...(status === "open"
            ? { dueOn }
            : whenChanged
              ? { occurredAt: new Date(when).toISOString() }
              : {}),
        });
      }
      const patch: Record<string, unknown> = {};
      if (type !== existing.type) patch.type = type;
      if (status !== existing.status) patch.status = status;
      if (subject !== (existing.subject ?? "")) patch.subject = subject;
      if (body !== (existing.body ?? "")) patch.body = body;
      if (ownerId && ownerId !== existing.ownerId) patch.ownerId = ownerId;
      if (status === "open" && dueOn !== existing.dueOn) patch.dueOn = dueOn;
      if (status === "completed" && whenChanged) patch.occurredAt = new Date(when).toISOString();
      if (Object.keys(patch).length === 0) return null;
      return api("PATCH", `/api/activities/${existing.id}`, patch);
    },
    onSuccess: async (result) => {
      await refresh();
      props.onOpenChange(false);
      if (!result) return;
      toast.success(
        existing ? "Activity saved" : status === "open" ? "Activity planned" : "Activity logged",
      );
    },
  });
  const remove = useMutation({
    mutationFn: () => api("DELETE", `/api/activities/${existing!.id}`),
    onSuccess: async () => {
      await refresh();
      props.onOpenChange(false);
      toast.success("Activity deleted");
    },
  });

  const readOnly = existing
    ? existing.fromSequence || !can.canEdit(existing.ownerId)
    : !can.canCreate;
  const related = existing ? relatedOf(existing) : null;
  const error = save.error ?? remove.error;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {existing
              ? (existing.subject ?? typeOf(existing).label)
              : status === "open"
                ? "Plan an activity"
                : "Log an activity"}
          </DialogTitle>
          <DialogDescription>
            {existing?.fromSequence
              ? "Written by a sequence step, so it can't be changed."
              : readOnly
                ? "Your role can view this activity but not change it."
                : status === "open"
                  ? "Something still to do, with a due date and an owner."
                  : "Something that already happened."}
          </DialogDescription>
        </DialogHeader>

        <form
          id="activity-form"
          className="grid grid-cols-6 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div
            className="col-span-6 flex gap-1 rounded-md border p-1"
            role="radiogroup"
            aria-label="Status"
          >
            {(
              [
                ["completed", existing ? "Completed" : "Already done"],
                ["open", existing ? "Open" : "Still to do"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={status === value}
                disabled={readOnly}
                className={cn(
                  "flex-1 rounded px-3 py-1.5 text-sm",
                  status === value ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                )}
                onClick={() => setStatus(value)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="col-span-6 space-y-1.5">
            <Label htmlFor="activity-related">Related to</Label>
            {existing ? (
              <p className="py-1 text-sm">
                {related ? (
                  <Link href={related.path} className="text-primary hover:underline">
                    {related.label}
                  </Link>
                ) : (
                  "—"
                )}
                {existing.accountName && related?.label !== existing.accountName && (
                  <span className="text-muted-foreground"> · {existing.accountName}</span>
                )}
              </p>
            ) : props.about ? null : (
              <RecordPicker value={picked} onChange={setPicked} />
            )}
          </div>

          <div className="col-span-3 space-y-1.5">
            <Label htmlFor="activity-type">Type</Label>
            <select
              id="activity-type"
              className={selectClass}
              value={type}
              disabled={readOnly}
              onChange={(e) => setType(e.target.value as ActivityType)}
            >
              {ACTIVITY_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-3 space-y-1.5">
            <Label htmlFor="activity-owner">Owner</Label>
            <select
              id="activity-owner"
              className={selectClass}
              value={ownerId}
              disabled={readOnly}
              onChange={(e) => setOwnerId(e.target.value)}
            >
              {(users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          {status === "open" ? (
            <div className="col-span-3 space-y-1.5">
              <Label htmlFor="activity-due">Due date</Label>
              <Input
                id="activity-due"
                type="date"
                required
                value={dueOn}
                disabled={readOnly}
                onChange={(e) => setDueOn(e.target.value)}
              />
            </div>
          ) : (
            <div className="col-span-3 space-y-1.5">
              <Label htmlFor="activity-when">When</Label>
              <Input
                id="activity-when"
                type="datetime-local"
                value={whenChanged || existing?.occurredAt ? when : localInput()}
                max={localInput()}
                disabled={readOnly}
                onChange={(e) => {
                  setWhen(e.target.value);
                  setWhenChanged(true);
                }}
              />
            </div>
          )}
          <div className="col-span-6 space-y-1.5">
            <Label htmlFor="activity-subject">Subject</Label>
            <Input
              id="activity-subject"
              value={subject}
              disabled={readOnly}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={
                status === "open"
                  ? "Follow up on pricing, Send case study, …"
                  : "Left a voicemail, Discovery call, …"
              }
            />
          </div>
          <div className="col-span-6 space-y-1.5">
            <Label htmlFor="activity-body">Notes</Label>
            <Textarea
              id="activity-body"
              rows={3}
              value={body}
              disabled={readOnly}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        </form>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}

        <DialogFooter className="sm:justify-between">
          <div>
            {existing &&
              can.canDelete(existing.ownerId) &&
              (confirmingDelete ? (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={remove.isPending}
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
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <Button
                type="submit"
                form="activity-form"
                disabled={save.isPending || (subject.trim() === "" && body.trim() === "")}
              >
                {existing ? "Save changes" : "Save activity"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Tick an open activity to complete it. */
export function useCompleteActivity() {
  const api = useApi();
  const queryClient = useQueryClient();
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["activities"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };
  return useMutation({
    mutationFn: (id: string) => api("PATCH", `/api/activities/${id}`, { status: "completed" }),
    onSuccess: async (_result, id) => {
      await refresh();
      toast.success("Activity completed", {
        undo: () =>
          api("PATCH", `/api/activities/${id}`, { status: "open" }).then(refresh, (e: Error) =>
            toast.error(e.message),
          ),
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * The Activity tab on a lead, contact, account or opportunity: open activities
 * first (tick to complete), then everything that happened, newest first.
 * Completed sequence steps appear here on their own.
 */
export function ActivityTimeline({ about }: { about: ActivityAbout }) {
  const api = useApi();
  const { data: me } = useMe();
  const can = permissionsFor(me, "activities");
  const [key, value] = Object.entries(about)[0];
  // On an account or opportunity, say who each activity was with.
  const showWho = key === "accountId" || key === "opportunityId";

  const list = useQuery({
    queryKey: ["activities", key, value],
    queryFn: () => api<Activity[]>("GET", `/api/activities?${key}=${value}`),
  });
  const complete = useCompleteActivity();
  const [dialog, setDialog] = useState<{ activity?: Activity; startAs?: ActivityStatus } | null>(
    null,
  );

  const open = (list.data ?? []).filter((a) => a.status === "open");
  const done = (list.data ?? []).filter((a) => a.status === "completed");

  const line = (a: Activity) => {
    const kind = typeOf(a);
    const Icon = kind.icon;
    const tickable = a.status === "open" && can.canEdit(a.ownerId);
    return (
      <li key={a.id} className="flex gap-3 text-sm">
        {a.status === "open" ? (
          <input
            type="checkbox"
            className="mt-1.5 h-4 w-4 shrink-0"
            aria-label={`Complete ${a.subject ?? kind.label}`}
            disabled={!tickable || complete.isPending}
            checked={false}
            onChange={() => complete.mutate(a.id)}
          />
        ) : (
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
            <Icon className="h-3.5 w-3.5" aria-label={kind.label} />
          </span>
        )}
        <button
          type="button"
          className="min-w-0 flex-1 rounded text-left hover:bg-muted/50"
          onClick={() => setDialog({ activity: a })}
        >
          <p className="font-medium">
            {a.subject ?? kind.label}
            {showWho && a.personName && (
              <span className="font-normal text-muted-foreground"> · {a.personName}</span>
            )}
          </p>
          {a.body && (
            <p className="whitespace-pre-line text-muted-foreground line-clamp-4">{a.body}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {kind.label} · {a.ownerName ?? "Someone"} ·{" "}
            {a.status === "open" ? (
              <span className={cn(a.overdue && "font-medium text-destructive")}>{dueText(a)}</span>
            ) : (
              a.occurredAt && formatDateTime(a.occurredAt)
            )}
            {a.fromSequence && " · sequence step"}
          </p>
        </button>
      </li>
    );
  };

  return (
    <div className="space-y-4 py-2">
      {can.canCreate && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setDialog({ startAs: "completed" })}
          >
            <Plus className="mr-2 h-4 w-4" aria-hidden />
            Log activity
          </Button>
          <Button type="button" variant="outline" onClick={() => setDialog({ startAs: "open" })}>
            <CalendarPlus className="mr-2 h-4 w-4" aria-hidden />
            Plan activity
          </Button>
        </div>
      )}

      {list.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.error ? (
        <p className="text-sm text-destructive">{list.error.message}</p>
      ) : list.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <div className="max-h-[28rem] space-y-4 overflow-y-auto">
          {open.length > 0 && (
            <section aria-label="Open activities">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Open ({open.length})
              </h3>
              <ol className="space-y-3">{open.map(line)}</ol>
            </section>
          )}
          {done.length > 0 && (
            <section aria-label="Completed activities">
              {open.length > 0 && (
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Completed
                </h3>
              )}
              <ol className="space-y-3">{done.map(line)}</ol>
            </section>
          )}
        </div>
      )}

      <ActivityDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        activity={dialog?.activity}
        startAs={dialog?.startAs}
        about={about}
      />
    </div>
  );
}
