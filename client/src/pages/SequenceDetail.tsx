import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Mail,
  MessageSquare,
  Pencil,
  Phone,
  Plus,
  Search,
  Trash2,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { RecordDetail } from "@/components/RecordDetail";
import { History } from "@/components/RecordPage";
import { StatusBadge } from "@/components/StatusBadge";
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
import { canUse, permissionsFor, useApi, useMe, useOrgUsers } from "@/lib/api";
import { toast } from "@/lib/toast";
import { PlainTextEditor, RichTextEditor } from "@/components/RichTextEditor";
import { LINKEDIN_NOTE_LIMIT } from "../../../shared/linkedin";
import { htmlToText, looksLikeHtml, textToHtml } from "../../../shared/richtext";
import { cn, formatDate } from "@/lib/utils";
import { sequenceFields, useSequenceStats, type Sequence } from "./Sequences";
import { nameOf } from "./shared";
import { type Template } from "./Templates";

/**
 * A sequence's own page: its details edited in place like any record, then
 * its steps as a timeline you edit right where they are, the people in it,
 * and its history.
 */

type StepType = "email" | "phone_call" | "linkedin_connect" | "linkedin_message";

interface Step {
  id: string;
  position: number;
  type: StepType;
  title: string;
  waitDays: number;
  templateId: string | null;
  subject: string | null;
  body: string | null;
  callScript: string | null;
  callObjectives: string | null;
}

interface Enrollment {
  id: string;
  state: "active" | "paused" | "ended";
  endReason: string | null;
  ownerId: string;
  currentStepId: string | null;
  enrolledAt: string;
  leadId: string | null;
  contactId: string | null;
  leadFirstName: string | null;
  leadLastName: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  nextDueOn: string | null;
}

export const STEP_LABELS: Record<StepType, string> = {
  email: "Email",
  phone_call: "Phone Call",
  linkedin_connect: "LinkedIn Connect",
  linkedin_message: "LinkedIn Message",
};

const STEP_ICONS: Record<StepType, LucideIcon> = {
  email: Mail,
  phone_call: Phone,
  linkedin_connect: UserPlus,
  linkedin_message: MessageSquare,
};

const END_REASONS: Record<string, string> = {
  finished: "Finished",
  replied: "Replied",
  meeting_booked: "Meeting booked",
  opted_out: "Opted out",
  bounced: "Bounced",
  status_change: "Status changed",
  removed: "Removed",
};

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

const templateKind = (type: StepType) =>
  type === "email" ? "email" : type === "phone_call" ? null : "linkedin";

// ------------------------------------------------------------ step editor

interface StepForm {
  type: StepType;
  title: string;
  waitDays: string;
  /** The template it follows; "" when the message is written for this step. */
  templateId: string;
  subject: string;
  body: string;
  /** The template's words were changed here, so the step keeps its own copy. */
  edited: boolean;
  callScript: string;
}

const BLANK_STEP: StepForm = {
  type: "email",
  title: "",
  waitDays: "0",
  templateId: "",
  subject: "",
  body: "",
  edited: false,
  callScript: "",
};

/** A phone step has no title of its own: it's the Phone Call. */
const titleOf = (step: { type: StepType; title: string }) =>
  step.type === "phone_call" ? STEP_LABELS.phone_call : step.title;

/** Add or change one step, in place in the timeline. */
function StepEditor({
  sequenceId,
  step,
  templates,
  isFirst,
  onClose,
}: {
  sequenceId: string;
  step: Step | "new";
  templates: Template[];
  isFirst: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<StepForm>(() => {
    if (step === "new") return { ...BLANK_STEP, waitDays: isFirst ? "0" : "2" };
    const template = step.templateId ? templates.find((t) => t.id === step.templateId) : null;
    return {
      type: step.type,
      title: step.type === "phone_call" ? "" : step.title,
      waitDays: String(step.waitDays),
      templateId: template?.id ?? "",
      // A step that follows a template shows the template's words.
      subject: (template ? template.subject : step.subject) ?? "",
      body: (template ? template.body : step.body) ?? "",
      edited: false,
      callScript: step.callScript ?? "",
    };
  });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<StepForm>) => setForm((f) => ({ ...f, ...patch }));
  /** A change to the words themselves: the step now has its own copy. */
  const write = (patch: Partial<StepForm>) => set({ ...patch, edited: true });

  const kind = templateKind(form.type);
  const choices = templates.filter((t) => t.type === kind);
  const chosen = templates.find((t) => t.id === form.templateId);
  const limit = form.type === "linkedin_connect" ? LINKEDIN_NOTE_LIMIT : undefined;
  const followsTemplate = Boolean(chosen) && !form.edited;

  const pickTemplate = (id: string) => {
    const template = templates.find((t) => t.id === id);
    if (!template) return set({ templateId: "" }); // keep the words, written for this step
    set({
      templateId: template.id,
      subject: template.subject ?? "",
      body: template.body,
      edited: false,
    });
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        type: form.type,
        title: form.type === "phone_call" ? STEP_LABELS.phone_call : form.title,
        waitDays: Number(form.waitDays),
        // Following a template: its words, kept up to date. Changed here: this step's own.
        templateId: kind !== null && followsTemplate ? form.templateId : null,
        subject: form.type === "email" && !followsTemplate ? form.subject : null,
        body: kind !== null && !followsTemplate ? form.body : null,
        callScript: form.type === "phone_call" ? form.callScript : null,
      };
      return step === "new"
        ? api("POST", `/api/sequences/${sequenceId}/steps`, body)
        : api("PATCH", `/api/steps/${step.id}`, body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sequence", sequenceId] });
      await queryClient.invalidateQueries({ queryKey: ["history", "sequence", sequenceId] });
      onClose();
      toast.success(step === "new" ? "Step added" : "Step saved");
    },
    onError: (e: Error) => setError(e.message),
  });

  const plainLength = kind === "linkedin" ? form.body.length : 0;

  return (
    <form
      aria-label={step === "new" ? "New step" : `Edit ${titleOf(step)}`}
      className="grid grid-cols-6 gap-3 rounded-lg border-2 border-primary/40 bg-background p-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setError(null);
        if (kind !== null && htmlToText(form.body).trim() === "") {
          setError("Choose a template, or write the message.");
          return;
        }
        if (limit && plainLength > limit) {
          setError(
            `LinkedIn allows ${limit} characters in a connection note; this is ${plainLength}.`,
          );
          return;
        }
        save.mutate();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="col-span-6 space-y-1.5 sm:col-span-2">
        <Label htmlFor="step-type">Step type</Label>
        <select
          id="step-type"
          className={selectClass}
          value={form.type}
          onChange={(e) => {
            const type = e.target.value as StepType;
            // Email messages are formatted; LinkedIn ones are plain text.
            const body =
              type === "email"
                ? looksLikeHtml(form.body)
                  ? form.body
                  : textToHtml(form.body)
                : htmlToText(form.body);
            set({ type, templateId: "", body, edited: true });
          }}
        >
          {Object.entries(STEP_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="col-span-6 space-y-1.5 sm:col-span-2">
        <Label htmlFor="step-wait">Days to wait</Label>
        <Input
          id="step-wait"
          type="number"
          min={0}
          max={365}
          required
          value={form.waitDays}
          onChange={(e) => set({ waitDays: e.target.value })}
        />
      </div>
      {form.type !== "phone_call" && (
        <div className="col-span-6 space-y-1.5 sm:col-span-2">
          <Label htmlFor="step-title">Title</Label>
          <Input
            id="step-title"
            required
            autoFocus
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder={form.type === "email" ? "e.g. Intro email" : "e.g. Connect"}
          />
        </div>
      )}

      {kind !== null && (
        <>
          <div className="col-span-6 space-y-1.5">
            <Label htmlFor="step-template">Template</Label>
            <select
              id="step-template"
              className={selectClass}
              value={form.templateId}
              onChange={(e) => pickTemplate(e.target.value)}
            >
              <option value="">None: write it for this step</option>
              {choices.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {chosen && followsTemplate ? (
              <p className="text-xs text-muted-foreground">
                Changes to this template reach this step on their own.{" "}
                <Link href={`/templates/${chosen.id}`} className="text-primary hover:underline">
                  Open template
                </Link>
              </p>
            ) : chosen ? (
              <p className="text-xs text-muted-foreground">
                Changed for this step, so later changes to “{chosen.name}” won't reach it.{" "}
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => pickTemplate(chosen.id)}
                >
                  Use the template as it is
                </button>
              </p>
            ) : choices.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No {kind === "email" ? "email" : "LinkedIn"} templates yet.{" "}
                <Link href="/templates?new=1" className="text-primary hover:underline">
                  Create one
                </Link>
                , or write the message here.
              </p>
            ) : null}
          </div>
          {form.type === "email" && (
            <div className="col-span-6 space-y-1.5">
              <Label htmlFor="step-subject">Subject</Label>
              <Input
                id="step-subject"
                value={form.subject}
                onChange={(e) => write({ subject: e.target.value })}
              />
            </div>
          )}
          <div className="col-span-6 space-y-1.5">
            <Label htmlFor="step-body">Message</Label>
            {form.type === "email" ? (
              <RichTextEditor
                id="step-body"
                value={form.body}
                onChange={(body) => write({ body })}
              />
            ) : (
              <PlainTextEditor
                id="step-body"
                rows={6}
                limit={limit}
                value={form.body}
                onChange={(body) => write({ body })}
              />
            )}
          </div>
        </>
      )}

      {form.type === "phone_call" && (
        <div className="col-span-6 space-y-1.5">
          <Label htmlFor="step-script">Call script</Label>
          <Textarea
            id="step-script"
            rows={5}
            value={form.callScript}
            onChange={(e) => set({ callScript: e.target.value })}
          />
        </div>
      )}

      <div className="col-span-6 flex items-center justify-between gap-3">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <span />
        )}
        <span className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {step === "new" ? "Add step" : "Save step"}
          </Button>
        </span>
      </div>
    </form>
  );
}

// ------------------------------------------------------------ steps

function waitText(step: Step, index: number, dayWord: string) {
  if (step.waitDays === 0)
    return index === 0 ? "On the day they're enrolled" : "Same day as the step before";
  const unit = step.waitDays === 1 ? dayWord.replace(/s$/, "") : dayWord;
  return index === 0
    ? `${step.waitDays} ${unit} after enrolling`
    : `${step.waitDays} ${unit} after the step before`;
}

function StepsPanel({
  sequence,
  steps,
  templates,
  canEdit,
  dayWord,
}: {
  sequence: Sequence;
  steps: Step[];
  templates: Template[];
  canEdit: boolean;
  dayWord: string;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (job: { call: () => Promise<unknown>; done: string }) => job.call(),
    onSuccess: async (_result, job) => {
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: ["sequence", sequence.id] });
      await queryClient.invalidateQueries({ queryKey: ["history", "sequence", sequence.id] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast.success(job.done);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const templateName = (id: string | null) => templates.find((t) => t.id === id)?.name;
  const move = (index: number, by: -1 | 1) => {
    const order = steps.map((s) => s.id);
    [order[index], order[index + by]] = [order[index + by], order[index]];
    act.mutate({
      call: () => api("PUT", `/api/sequences/${sequence.id}/steps/order`, { stepIds: order }),
      done: `${titleOf(steps[index])} moved ${by < 0 ? "up" : "down"}`,
    });
  };

  // The day each step comes due for someone who moves along without delay.
  let day = 0;
  const days = steps.map((s) => (day += s.waitDays));

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Changes never rebuild anyone's tasks. Each person picks up the current steps when they
        finish the one they're on.
      </p>
      {steps.length === 0 && editing !== "new" && (
        <p className="rounded-lg border border-dashed bg-background p-8 text-center text-sm text-muted-foreground">
          No steps yet. Add the first step to start building this sequence.
        </p>
      )}
      <ol className="space-y-3">
        {steps.map((step, index) => {
          const Icon = STEP_ICONS[step.type];
          if (editing === step.id) {
            return (
              <li key={step.id}>
                <StepEditor
                  sequenceId={sequence.id}
                  step={step}
                  templates={templates}
                  isFirst={index === 0}
                  onClose={() => setEditing(null)}
                />
              </li>
            );
          }
          const preview = step.templateId
            ? `Template: ${templateName(step.templateId) ?? "(deleted)"}`
            : step.type === "phone_call"
              ? step.callScript
              : step.subject || (step.body && htmlToText(step.body));
          return (
            <li key={step.id} className="flex items-center gap-3">
              <div className="flex w-16 shrink-0 justify-center">
                <span
                  className="flex h-14 w-14 flex-col items-center justify-center rounded-full border-2 border-primary/30 bg-background leading-none"
                  aria-label={`Day ${days[index] + 1}`}
                >
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Day
                  </span>
                  <span className="text-base font-semibold text-foreground">{days[index] + 1}</span>
                </span>
              </div>
              <div className="flex min-w-0 flex-1 items-start gap-3 rounded-lg border bg-background p-4">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left disabled:cursor-default"
                  disabled={!canEdit}
                  onClick={() => setEditing(step.id)}
                >
                  <p className="font-medium">
                    {index + 1}. {titleOf(step)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {STEP_LABELS[step.type]} · {waitText(step, index, dayWord)}
                  </p>
                  {preview && (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{preview}</p>
                  )}
                </button>
                {canEdit &&
                  (deleting === step.id ? (
                    <div className="flex shrink-0 items-center gap-2 text-sm">
                      <span className="hidden text-muted-foreground lg:inline">
                        Anyone on it moves to the next step.
                      </span>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={act.isPending}
                        onClick={() =>
                          act.mutate({
                            call: () => api("DELETE", `/api/steps/${step.id}`),
                            done: `${titleOf(step)} deleted`,
                          })
                        }
                      >
                        Delete step
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>
                        Keep
                      </Button>
                    </div>
                  ) : (
                    <div className="flex shrink-0">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Move ${titleOf(step)} up`}
                        disabled={index === 0 || act.isPending}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Move ${titleOf(step)} down`}
                        disabled={index === steps.length - 1 || act.isPending}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Edit ${titleOf(step)}`}
                        onClick={() => setEditing(step.id)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Delete ${titleOf(step)}`}
                        onClick={() => setDeleting(step.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
              </div>
            </li>
          );
        })}
        {editing === "new" && (
          <li>
            <StepEditor
              sequenceId={sequence.id}
              step="new"
              templates={templates}
              isFirst={steps.length === 0}
              onClose={() => setEditing(null)}
            />
          </li>
        )}
      </ol>
      {canEdit && editing !== "new" && (
        <Button variant="outline" onClick={() => setEditing("new")}>
          <Plus className="mr-2 h-4 w-4" aria-hidden />
          Add step
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------ people

function PeoplePanel({
  sequenceId,
  enrollments,
  steps,
}: {
  sequenceId: string;
  enrollments: Enrollment[];
  steps: Step[];
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const { data: users } = useOrgUsers();
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<"all" | "active" | "paused" | "ended">("all");
  const act = useMutation({
    mutationFn: (job: { call: () => Promise<unknown>; done: string }) => job.call(),
    onSuccess: async (_result, job) => {
      await queryClient.invalidateQueries({ queryKey: ["sequence", sequenceId] });
      await queryClient.invalidateQueries({ queryKey: ["sequences", "stats"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast.success(job.done);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const canManage = (ownerId: string) =>
    canUse(me, "sequences.enroll") &&
    (ownerId === me?.user.id || canUse(me, "sequences.manage_others"));

  const nameOfPerson = (e: Enrollment) =>
    e.leadId
      ? `${e.leadFirstName} ${e.leadLastName}`
      : `${e.contactFirstName} ${e.contactLastName}`;
  const counts = {
    all: enrollments.length,
    active: enrollments.filter((e) => e.state === "active").length,
    paused: enrollments.filter((e) => e.state === "paused").length,
    ended: enrollments.filter((e) => e.state === "ended").length,
  };
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = enrollments.filter(
    (e) =>
      (show === "all" || e.state === show) &&
      words.every((w) => nameOfPerson(e).toLowerCase().includes(w)),
  );

  return (
    <div className="rounded-lg border bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b p-4">
        <div className="relative min-w-48 flex-1">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            className="pl-9"
            placeholder="Find someone in this sequence…"
            aria-label="Find someone in this sequence"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1 rounded-md border p-1" role="radiogroup" aria-label="Show">
          {(["all", "active", "paused", "ended"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={show === s}
              className={cn(
                "rounded px-3 py-1 text-sm capitalize",
                show === s ? "bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
              onClick={() => setShow(s)}
            >
              {s} ({counts[s]})
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">
          {enrollments.length === 0 ? "Nobody is enrolled yet." : "Nobody here matches."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Current step</TableHead>
              <TableHead>Next due</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Enrolled</TableHead>
              <TableHead className="w-48">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((e) => {
              const name = nameOfPerson(e);
              const current = steps.find((s) => s.id === e.currentStepId);
              const status =
                e.state === "ended"
                  ? (END_REASONS[e.endReason ?? ""] ?? "Ended")
                  : e.state === "paused"
                    ? "Paused"
                    : "Active";
              return (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={e.leadId ? `/leads/${e.leadId}` : `/contacts/${e.contactId}`}
                      className="text-primary hover:underline"
                    >
                      {name}
                    </Link>
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {e.leadId ? "Lead" : "Contact"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={status} />
                  </TableCell>
                  <TableCell>{current ? `${current.position}. ${current.title}` : "—"}</TableCell>
                  <TableCell>{e.nextDueOn ? formatDate(`${e.nextDueOn}T12:00:00`) : "—"}</TableCell>
                  <TableCell>{nameOf(users, e.ownerId)}</TableCell>
                  <TableCell>{formatDate(e.enrolledAt)}</TableCell>
                  <TableCell>
                    {e.state !== "ended" && canManage(e.ownerId) && (
                      <select
                        aria-label={`Actions for ${name}`}
                        className={selectClass}
                        value=""
                        disabled={act.isPending}
                        onChange={(event) => {
                          const action = event.target.value;
                          if (!action) return;
                          const path = `/api/enrollments/${e.id}`;
                          if (action === "pause" || action === "resume") {
                            act.mutate({
                              call: () => api("POST", `${path}/${action}`),
                              done: `${name} ${action === "pause" ? "paused" : "resumed"}`,
                            });
                          } else {
                            act.mutate({
                              call: () => api("POST", `${path}/stop`, { reason: action }),
                              done:
                                action === "removed"
                                  ? `${name} removed from the sequence`
                                  : `${name}: ${END_REASONS[action].toLowerCase()}. Sequence ended.`,
                            });
                          }
                        }}
                      >
                        <option value="">Choose…</option>
                        {e.state === "active" ? (
                          <option value="pause">Pause</option>
                        ) : (
                          <option value="resume">Resume</option>
                        )}
                        <option value="replied">Log reply (ends sequence)</option>
                        <option value="meeting_booked">Meeting booked (ends)</option>
                        <option value="opted_out">Opted out (ends)</option>
                        <option value="removed">Remove from sequence</option>
                      </select>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// --------------------------------------------------------- enroll dialog

interface Person {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  company?: string | null;
}

function EnrollDialog({ sequenceId, onClose }: { sequenceId: string; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"leads" | "contacts">("leads");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const people = useQuery({
    queryKey: [kind, "enroll-picker", q],
    queryFn: () => api<Person[]>("GET", `/api/${kind}?limit=25&q=${encodeURIComponent(q)}`),
  });

  const enroll = useMutation({
    mutationFn: (person: Person) =>
      api("POST", `/api/sequences/${sequenceId}/enrollments`, {
        [kind === "leads" ? "leadId" : "contactId"]: person.id,
      }).then(() => person),
    onSuccess: async (person) => {
      setError(null);
      toast.success(`${person.firstName} ${person.lastName} enrolled`);
      await queryClient.invalidateQueries({ queryKey: ["sequence", sequenceId] });
      await queryClient.invalidateQueries({ queryKey: ["sequences", "stats"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Enroll people</DialogTitle>
          <DialogDescription>
            Their first step lands in your Roll the Calls queue. A person can be in one sequence at
            a time. To enroll many at once, tick them on the Leads or Contacts list.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <select
            aria-label="Leads or contacts"
            className={`${selectClass} w-36`}
            value={kind}
            onChange={(e) => setKind(e.target.value as "leads" | "contacts")}
          >
            <option value="leads">Leads</option>
            <option value="contacts">Contacts</option>
          </select>
          <Input
            aria-label="Search people"
            placeholder="Search by name, email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
          {people.data?.length === 0 && (
            <li className="p-4 text-sm text-muted-foreground">No matches.</li>
          )}
          {people.data?.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {p.firstName} {p.lastName}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {[p.company, p.email].filter(Boolean).join(" · ")}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={enroll.isPending}
                onClick={() => enroll.mutate(p)}
              >
                Enroll
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------- the page

function SequenceBody({ seq }: { seq: Sequence }) {
  const api = useApi();
  const { data: me } = useMe();
  const { data: users } = useOrgUsers();
  const steps = useQuery({
    queryKey: ["sequence", seq.id, "steps"],
    queryFn: () => api<Step[]>("GET", `/api/sequences/${seq.id}/steps`),
  });
  const enrollments = useQuery({
    queryKey: ["sequence", seq.id, "enrollments"],
    queryFn: () => api<Enrollment[]>("GET", `/api/sequences/${seq.id}/enrollments`),
  });
  const templates = useQuery({
    queryKey: ["templates", "for-picker"],
    queryFn: () => api<Template[]>("GET", "/api/templates?limit=500"),
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ waitDayMode: "business" | "calendar" }>("GET", "/api/settings"),
  });
  const dayWord = settings.data?.waitDayMode === "calendar" ? "days" : "business days";
  const can = permissionsFor(me, "sequences");
  const stepList = steps.data ?? [];
  const people = enrollments.data ?? [];

  return (
    <Tabs defaultValue="steps">
      <TabsList>
        <TabsTrigger value="steps">Steps ({stepList.length})</TabsTrigger>
        <TabsTrigger value="people">People ({people.length})</TabsTrigger>
        {can.canViewHistory && <TabsTrigger value="history">History</TabsTrigger>}
      </TabsList>
      <TabsContent value="steps">
        {steps.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <StepsPanel
            sequence={seq}
            steps={stepList}
            templates={templates.data ?? []}
            canEdit={can.canEdit(seq.ownerId)}
            dayWord={dayWord}
          />
        )}
      </TabsContent>
      <TabsContent value="people">
        <PeoplePanel sequenceId={seq.id} enrollments={people} steps={stepList} />
      </TabsContent>
      {can.canViewHistory && (
        <TabsContent value="history">
          <section className="rounded-lg border bg-background p-5">
            <History recordType="sequence" recordId={seq.id} fields={sequenceFields(users)} />
          </section>
        </TabsContent>
      )}
    </Tabs>
  );
}

export function SequenceDetailPage({ params }: { params: { id: string } }) {
  const { data: me } = useMe();
  const { data: users } = useOrgUsers();
  const stats = useSequenceStats();
  const [enrolling, setEnrolling] = useState(false);
  const stat = stats.data?.[params.id];

  return (
    <>
      <RecordDetail<Sequence & Record<string, unknown>>
        object="sequences"
        recordType="sequence"
        id={params.id}
        listHref="/sequences"
        listLabel="Sequences"
        layout="wide"
        fields={sequenceFields(users)}
        title={(s) => s.name}
        badge={(s) => <StatusBadge status={s.isActive ? "Active" : "Inactive"} />}
        subtitle={() =>
          stat
            ? `${stat.active + stat.paused} in progress · ${stat.ended} finished or stopped`
            : "Nobody enrolled yet"
        }
        actions={(s) =>
          canUse(me, "sequences.enroll") && s.isActive ? (
            <Button onClick={() => setEnrolling(true)}>
              <UserPlus className="mr-2 h-4 w-4" aria-hidden />
              Enroll people
            </Button>
          ) : null
        }
        below={(s) => <SequenceBody seq={s} />}
      />
      {enrolling && <EnrollDialog sequenceId={params.id} onClose={() => setEnrolling(false)} />}
    </>
  );
}
