import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarCheck,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  StickyNote,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { permissionsFor, useApi, useMe, type Activity, type ActivityType } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";

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

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** "2026-10-12T07:30" in the viewer's own time, for a datetime-local box. */
function nowLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * The Activity tab on a lead, contact, account or opportunity: a form to log
 * a call, email, LinkedIn touch, meeting or note, and everything logged so
 * far, newest first. Completed sequence steps appear here on their own.
 */
export function ActivityTimeline({ about }: { about: ActivityAbout }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const can = permissionsFor(me, "activities");
  const [key, value] = Object.entries(about)[0];
  // On an account or opportunity, say who each activity was with.
  const showWho = key === "accountId" || key === "opportunityId";

  const list = useQuery({
    queryKey: ["activities", key, value],
    queryFn: () => api<Activity[]>("GET", `/api/activities?${key}=${value}`),
  });

  // The form stays folded away until someone wants to log something.
  const [logging, setLogging] = useState(false);
  const [type, setType] = useState<ActivityType>("call");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [when, setWhen] = useState(nowLocal);
  // Untouched, "when" means now to the second; the box itself only holds minutes.
  const [whenChanged, setWhenChanged] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["activities"] });
  const log = useMutation({
    mutationFn: () =>
      api("POST", "/api/activities", {
        ...about,
        type,
        subject,
        body,
        occurredAt: whenChanged ? new Date(when).toISOString() : undefined,
      }),
    onSuccess: async () => {
      setSubject("");
      setBody("");
      setWhen(nowLocal());
      setWhenChanged(false);
      setLogging(false);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api("DELETE", `/api/activities/${id}`),
    onSuccess: refresh,
  });

  return (
    <div className="space-y-4 py-2">
      {can.canCreate && !logging && (
        <Button type="button" variant="outline" onClick={() => setLogging(true)}>
          <Plus className="mr-2 h-4 w-4" aria-hidden />
          Log activity
        </Button>
      )}
      {can.canCreate && logging && (
        <form
          className="space-y-3 rounded-md border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            log.mutate();
          }}
        >
          <div className="grid grid-cols-6 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="activity-type">Type</Label>
              <select
                id="activity-type"
                className={selectClass}
                value={type}
                onChange={(e) => setType(e.target.value as ActivityType)}
              >
                {ACTIVITY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-4 space-y-1.5">
              <Label htmlFor="activity-when">When</Label>
              <Input
                id="activity-when"
                type="datetime-local"
                value={when}
                max={nowLocal()}
                onChange={(e) => {
                  setWhen(e.target.value);
                  setWhenChanged(true);
                }}
              />
            </div>
            <div className="col-span-6 space-y-1.5">
              <Label htmlFor="activity-subject">Subject</Label>
              <Input
                id="activity-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Left a voicemail, Discovery call, …"
              />
            </div>
            <div className="col-span-6 space-y-1.5">
              <Label htmlFor="activity-body">Notes</Label>
              <Textarea
                id="activity-body"
                rows={2}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            {log.error ? (
              <p role="alert" className="text-sm text-destructive">
                {log.error.message}
              </p>
            ) : (
              <span />
            )}
            <span className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setLogging(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="outline"
                disabled={log.isPending || (subject.trim() === "" && body.trim() === "")}
              >
                Save activity
              </Button>
            </span>
          </div>
        </form>
      )}

      {list.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.error ? (
        <p className="text-sm text-destructive">{list.error.message}</p>
      ) : list.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <ol className="max-h-80 space-y-3 overflow-y-auto">
          {list.data?.map((a) => {
            const kind = ACTIVITY_TYPES.find((t) => t.value === a.type) ?? ACTIVITY_TYPES[4];
            const Icon = kind.icon;
            return (
              <li key={a.id} className="flex gap-3 text-sm">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Icon className="h-3.5 w-3.5" aria-label={kind.label} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {a.subject ?? kind.label}
                    {showWho && a.personName && (
                      <span className="font-normal text-muted-foreground"> · {a.personName}</span>
                    )}
                  </p>
                  {a.body && (
                    <p className="whitespace-pre-line text-muted-foreground line-clamp-4">
                      {a.body}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {kind.label} · {a.ownerName ?? "Someone"} · {formatDateTime(a.occurredAt)}
                    {a.fromSequence && " · sequence step"}
                  </p>
                </div>
                {can.canDelete(a.ownerId) && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${a.subject ?? kind.label}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(a.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
