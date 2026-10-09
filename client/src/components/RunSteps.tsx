import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  MessageSquare,
  Mail,
  Phone,
  Play,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { canUse, useApi, useMe } from "@/lib/api";
import { formatDate, formatPhone } from "@/lib/utils";

type StepType = "email" | "phone_call" | "linkedin_connect" | "linkedin_message";

interface Task {
  taskId: string;
  sequenceName: string;
  dueOn: string;
  step: { type: StepType; title: string };
  person: {
    firstName: string;
    lastName: string;
    email: string;
    title: string | null;
    company: string | null;
    cellPhone: string | null;
    directPhone: string | null;
    hqPhone: string | null;
    linkedin: string | null;
  };
  callScript: string | null;
  callObjectives: string | null;
  content: { subject: string | null; body: string | null; edited: boolean };
}

const TYPE_LABELS: Record<StepType, string> = {
  email: "Email",
  phone_call: "Phone Call",
  linkedin_connect: "LinkedIn Connect",
  linkedin_message: "LinkedIn Message",
};
const TYPE_ICONS = {
  email: Mail,
  phone_call: Phone,
  linkedin_connect: UserPlus,
  linkedin_message: MessageSquare,
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{value}</p>
    </div>
  );
}

function useDueTasks(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["tasks", "due"],
    queryFn: () => api<Task[]>("GET", "/api/tasks/due"),
    enabled,
    refetchInterval: 60_000,
  });
}

/** The button in the top bar, with the number of steps waiting. */
export function RunStepsButton() {
  const { data: me } = useMe();
  const allowed = canUse(me, "sequences.enroll");
  const [open, setOpen] = useState(false);
  const tasks = useDueTasks(allowed);
  if (!allowed) return null;
  const count = tasks.data?.length ?? 0;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Play className="mr-2 h-4 w-4" aria-hidden />
        Run Steps
        {count > 0 && (
          <span className="ml-2 rounded-full bg-white/25 px-2 py-0.5 text-xs">{count}</span>
        )}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
          <SheetHeader className="border-b p-4">
            <SheetTitle>Run Steps</SheetTitle>
            <SheetDescription>Steps due today or earlier, one at a time.</SheetDescription>
          </SheetHeader>
          <RunStepsPanel tasks={tasks.data ?? []} loading={tasks.isLoading} />
        </SheetContent>
      </Sheet>
    </>
  );
}

function RunStepsPanel({ tasks, loading }: { tasks: Task[]; loading: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<StepType | "all">("all");
  const [index, setIndex] = useState(0);
  const [note, setNote] = useState("");
  const [snoozeTo, setSnoozeTo] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ subject: "", body: "" });
  const [error, setError] = useState<string | null>(null);

  const visible = filter === "all" ? tasks : tasks.filter((t) => t.step.type === filter);
  const position = Math.min(index, Math.max(visible.length - 1, 0));
  const task = visible[position];

  // Start fresh whenever a different task is shown.
  useEffect(() => {
    setNote("");
    setSnoozeTo("");
    setEditing(false);
    setError(null);
  }, [task?.taskId]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["sequence"] });
    await queryClient.invalidateQueries({ queryKey: ["sequences"] });
  };
  const act = useMutation({
    mutationFn: (call: () => Promise<unknown>) => call(),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
    onMutate: () => setError(null),
  });

  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;

  const counts = (type: StepType) => tasks.filter((t) => t.step.type === type).length;
  const Icon = task ? TYPE_ICONS[task.step.type] : Mail;
  const base = task ? `/api/tasks/${task.taskId}` : "";
  const phones = task
    ? ([
        ["Cell", task.person.cellPhone],
        ["Direct", task.person.directPhone],
        ["HQ", task.person.hqPhone],
      ].filter(([, n]) => n) as [string, string][])
    : [];

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-2 border-b bg-muted/60 p-4">
        <select
          aria-label="Filter by type"
          className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as StepType | "all");
            setIndex(0);
          }}
        >
          <option value="all">All ({tasks.length})</option>
          {(Object.keys(TYPE_LABELS) as StepType[]).map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type]} ({counts(type)})
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">
          {visible.length === 0 ? "0 of 0" : `${position + 1} of ${visible.length}`}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Previous step"
          disabled={position === 0}
          onClick={() => setIndex(position - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Next step"
          disabled={position >= visible.length - 1}
          onClick={() => setIndex(position + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {!task ? (
        <div className="p-8 text-center">
          <p className="font-medium">You're all caught up</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing is due. New steps appear here on the day they come due.
          </p>
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div className="rounded-lg border p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Icon className="h-4 w-4" aria-hidden />
              {TYPE_LABELS[task.step.type]}
              {task.dueOn < today() && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                  Due {formatDate(`${task.dueOn}T12:00:00`)}
                </span>
              )}
            </div>
            <p className="mt-2 text-lg font-semibold text-primary">
              {task.person.firstName} {task.person.lastName}
            </p>
            <p className="text-sm text-muted-foreground">
              {[task.person.title, task.person.company].filter(Boolean).join(" · ") || "—"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {task.sequenceName} · {task.step.title}
            </p>

            <div className="mt-4 space-y-3 rounded-md bg-muted/60 p-3">
              {task.step.type === "email" && <CopyRow label="Email" value={task.person.email} />}
              {task.step.type !== "email" && task.step.type !== "phone_call" && (
                <div className="text-sm">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    LinkedIn
                  </span>
                  <p>
                    {task.person.linkedin ? (
                      <a
                        className="text-primary underline"
                        href={task.person.linkedin}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open profile
                      </a>
                    ) : (
                      "No LinkedIn address on this record"
                    )}
                  </p>
                </div>
              )}

              {task.step.type === "phone_call" ? (
                <>
                  {phones.length === 0 ? (
                    <p className="text-sm">No phone number on this record.</p>
                  ) : (
                    phones.map(([label, number]) => (
                      <CopyRow key={label} label={`${label} phone`} value={formatPhone(number)} />
                    ))
                  )}
                  {task.callObjectives && (
                    <CopyRow label="Objectives" value={task.callObjectives} />
                  )}
                  {task.callScript && <CopyRow label="Script" value={task.callScript} />}
                </>
              ) : editing ? (
                <div className="space-y-2">
                  {task.step.type === "email" && (
                    <div className="space-y-1">
                      <Label htmlFor="run-subject">Subject</Label>
                      <Input
                        id="run-subject"
                        value={draft.subject}
                        onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                      />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label htmlFor="run-body">Message</Label>
                    <Textarea
                      id="run-body"
                      rows={10}
                      value={draft.body}
                      onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={act.isPending}
                      onClick={() =>
                        act.mutate(async () => {
                          await api("PUT", `${base}/message`, {
                            body: draft.body,
                            ...(task.step.type === "email" ? { subject: draft.subject } : {}),
                          });
                          setEditing(false);
                        })
                      }
                    >
                      Save for this person
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {task.step.type === "email" && (
                    <CopyRow label="Subject" value={task.content.subject ?? ""} />
                  )}
                  <CopyRow
                    label={task.step.type === "email" ? "Email body" : "Message"}
                    value={task.content.body ?? ""}
                  />
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDraft({
                          subject: task.content.subject ?? "",
                          body: task.content.body ?? "",
                        });
                        setEditing(true);
                      }}
                    >
                      Edit for this person
                    </Button>
                    {task.content.edited && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={act.isPending}
                        onClick={() =>
                          act.mutate(() =>
                            api("PUT", `${base}/message`, { subject: null, body: null }),
                          )
                        }
                      >
                        Reset to template
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="run-note">Add note (optional)</Label>
            <Textarea
              id="run-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add any notes about this step…"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button
            className="w-full"
            disabled={act.isPending || editing}
            onClick={() =>
              act.mutate(() => api("POST", `${base}/complete`, note ? { note } : {}))
            }
          >
            <Check className="mr-2 h-4 w-4" aria-hidden />
            Mark Complete
          </Button>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              variant="outline"
              disabled={act.isPending}
              onClick={() => act.mutate(() => api("POST", `${base}/skip`, note ? { note } : {}))}
            >
              <X className="mr-2 h-4 w-4" aria-hidden />
              Skip
            </Button>
            <div className="flex flex-1 gap-1">
              <Input
                type="date"
                aria-label="Snooze until"
                min={today()}
                value={snoozeTo}
                onChange={(e) => setSnoozeTo(e.target.value)}
              />
              <Button
                variant="outline"
                aria-label="Snooze"
                disabled={act.isPending || !snoozeTo}
                onClick={() => act.mutate(() => api("POST", `${base}/snooze`, { dueOn: snoozeTo }))}
              >
                <Clock className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
