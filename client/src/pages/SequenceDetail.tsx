import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, Pencil, Plus, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "wouter";
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
import { formatDate } from "@/lib/utils";
import type { Sequence } from "./Sequences";
import { nameOf } from "./shared";
import { MERGE_FIELD_HELP, type Template } from "./Templates";

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

// ------------------------------------------------------------ step form

interface StepForm {
  type: StepType;
  title: string;
  waitDays: string;
  source: "template" | "inline";
  templateId: string;
  subject: string;
  body: string;
  callScript: string;
  callObjectives: string;
}

const BLANK_STEP: StepForm = {
  type: "email",
  title: "",
  waitDays: "0",
  source: "template",
  templateId: "",
  subject: "",
  body: "",
  callScript: "",
  callObjectives: "",
};

function StepDialog({
  sequenceId,
  step,
  templates,
  onClose,
}: {
  sequenceId: string;
  step: Step | "new";
  templates: Template[];
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<StepForm>(() =>
    step === "new"
      ? BLANK_STEP
      : {
          type: step.type,
          title: step.title,
          waitDays: String(step.waitDays),
          source: step.templateId ? "template" : "inline",
          templateId: step.templateId ?? "",
          subject: step.subject ?? "",
          body: step.body ?? "",
          callScript: step.callScript ?? "",
          callObjectives: step.callObjectives ?? "",
        },
  );
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<StepForm>) => setForm((f) => ({ ...f, ...patch }));

  const kind = templateKind(form.type);
  const choices = templates.filter((t) => t.type === kind);

  const save = useMutation({
    mutationFn: () => {
      const usesTemplate = kind !== null && form.source === "template";
      const body = {
        type: form.type,
        title: form.title,
        waitDays: Number(form.waitDays),
        templateId: usesTemplate ? form.templateId || null : null,
        subject: form.type === "email" && !usesTemplate ? form.subject : null,
        body: kind !== null && !usesTemplate ? form.body : null,
        callScript: form.type === "phone_call" ? form.callScript : null,
        callObjectives: form.type === "phone_call" ? form.callObjectives : null,
      };
      return step === "new"
        ? api("POST", `/api/sequences/${sequenceId}/steps`, body)
        : api("PATCH", `/api/steps/${step.id}`, body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sequence", sequenceId] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{step === "new" ? "Add step" : "Edit step"}</DialogTitle>
          <DialogDescription>
            Wait days count from when the previous step is completed. New steps go at the end.
          </DialogDescription>
        </DialogHeader>
        <form
          id="step-form"
          className="grid grid-cols-6 gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setError(null);
            if (kind !== null && form.source === "template" && !form.templateId) {
              setError("Choose a template, or switch to writing the message here.");
              return;
            }
            save.mutate();
          }}
        >
          <div className="col-span-6 space-y-1.5 sm:col-span-3">
            <Label htmlFor="step-type">Step type</Label>
            <select
              id="step-type"
              className={selectClass}
              value={form.type}
              onChange={(e) => set({ type: e.target.value as StepType, templateId: "" })}
            >
              {Object.entries(STEP_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-6 space-y-1.5 sm:col-span-3">
            <Label htmlFor="step-wait">Wait days</Label>
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
          <div className="col-span-6 space-y-1.5">
            <Label htmlFor="step-title">Title</Label>
            <Input
              id="step-title"
              required
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="e.g. Intro email"
            />
          </div>

          {kind !== null && (
            <>
              <div className="col-span-6 space-y-1.5">
                <Label htmlFor="step-source">Message</Label>
                <select
                  id="step-source"
                  className={selectClass}
                  value={form.source}
                  onChange={(e) => set({ source: e.target.value as StepForm["source"] })}
                >
                  <option value="template">Use a template (edits to it flow through)</option>
                  <option value="inline">Write it here, for this step only</option>
                </select>
              </div>
              {form.source === "template" ? (
                <div className="col-span-6 space-y-1.5">
                  <Label htmlFor="step-template">Template</Label>
                  <select
                    id="step-template"
                    className={selectClass}
                    value={form.templateId}
                    onChange={(e) => set({ templateId: e.target.value })}
                  >
                    <option value="">Select…</option>
                    {choices.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  {choices.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No {kind === "email" ? "email" : "LinkedIn"} templates yet. Create one under
                      Templates, or write the message here.
                    </p>
                  )}
                </div>
              ) : (
                <>
                  {form.type === "email" && (
                    <div className="col-span-6 space-y-1.5">
                      <Label htmlFor="step-subject">Subject</Label>
                      <Input
                        id="step-subject"
                        value={form.subject}
                        onChange={(e) => set({ subject: e.target.value })}
                      />
                    </div>
                  )}
                  <div className="col-span-6 space-y-1.5">
                    <Label htmlFor="step-body">Message text</Label>
                    <Textarea
                      id="step-body"
                      rows={8}
                      value={form.body}
                      onChange={(e) => set({ body: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">{MERGE_FIELD_HELP}</p>
                  </div>
                </>
              )}
            </>
          )}

          {form.type === "phone_call" && (
            <>
              <div className="col-span-6 space-y-1.5">
                <Label htmlFor="step-objectives">Call objectives</Label>
                <Textarea
                  id="step-objectives"
                  rows={2}
                  value={form.callObjectives}
                  onChange={(e) => set({ callObjectives: e.target.value })}
                />
              </div>
              <div className="col-span-6 space-y-1.5">
                <Label htmlFor="step-script">Call script</Label>
                <Textarea
                  id="step-script"
                  rows={5}
                  value={form.callScript}
                  onChange={(e) => set({ callScript: e.target.value })}
                />
              </div>
            </>
          )}
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="step-form" disabled={save.isPending}>
            {step === "new" ? "Add step" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

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
      setMessage({ tone: "ok", text: `${person.firstName} ${person.lastName} enrolled.` });
      await queryClient.invalidateQueries({ queryKey: ["sequence", sequenceId] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e: Error) => setMessage({ tone: "error", text: e.message }),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Enroll people</DialogTitle>
          <DialogDescription>
            Their first step lands in your Run Steps queue. A person can be in one sequence at a
            time.
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
        {message && (
          <p
            role="status"
            className={message.tone === "ok" ? "text-sm text-emerald-700" : "text-sm text-destructive"}
          >
            {message.text}
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

export function SequenceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const { data: users } = useOrgUsers();

  const sequence = useQuery({
    queryKey: ["sequence", id, "record"],
    queryFn: () => api<Sequence>("GET", `/api/sequences/${id}`),
  });
  const steps = useQuery({
    queryKey: ["sequence", id, "steps"],
    queryFn: () => api<Step[]>("GET", `/api/sequences/${id}/steps`),
  });
  const enrollments = useQuery({
    queryKey: ["sequence", id, "enrollments"],
    queryFn: () => api<Enrollment[]>("GET", `/api/sequences/${id}/enrollments`),
  });
  const templates = useQuery({
    queryKey: ["templates", "for-picker"],
    queryFn: () => api<Template[]>("GET", "/api/templates?limit=500"),
  });

  const [editingStep, setEditingStep] = useState<Step | "new" | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["sequence", id] });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["sequences"] });
  };
  const act = useMutation({
    mutationFn: (call: () => Promise<unknown>) => call(),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
    onMutate: () => setError(null),
  });

  if (sequence.error) {
    return <p className="p-10 text-center text-sm text-destructive">{sequence.error.message}</p>;
  }
  if (!sequence.data) return <p className="p-10 text-center text-sm">Loading…</p>;

  const seq = sequence.data;
  const canEdit = permissionsFor(me, "sequences").canEdit(seq.ownerId);
  const canEnroll = canUse(me, "sequences.enroll");
  const canManage = (ownerId: string) =>
    canEnroll && (ownerId === me?.user.id || canUse(me, "sequences.manage_others"));
  const stepList = steps.data ?? [];
  const templateName = (templateId: string | null) =>
    templates.data?.find((t) => t.id === templateId)?.name;

  const move = (index: number, by: -1 | 1) => {
    const order = stepList.map((s) => s.id);
    [order[index], order[index + by]] = [order[index + by], order[index]];
    act.mutate(() => api("PUT", `/api/sequences/${id}/steps/order`, { stepIds: order }));
  };

  return (
    <div>
      <div className="border-b bg-background px-6 py-4">
        <Link
          href="/sequences"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Sequences
        </Link>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{seq.name}</h1>
              <StatusBadge status={seq.isActive ? "Active" : "Inactive"} />
            </div>
            <p className="text-sm text-muted-foreground">
              {seq.description || "No description"} · Owner: {nameOf(users, seq.ownerId)}
            </p>
          </div>
          <div className="flex gap-2">
            {canEdit && (
              <Button
                variant="outline"
                onClick={() =>
                  act.mutate(() =>
                    api("PATCH", `/api/sequences/${id}`, { isActive: !seq.isActive }),
                  )
                }
              >
                {seq.isActive ? "Set inactive" : "Set active"}
              </Button>
            )}
            {canEnroll && (
              <Button onClick={() => setEnrolling(true)}>
                <UserPlus className="mr-2 h-4 w-4" aria-hidden />
                Enroll people
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="p-6">
        {error && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {error}
          </p>
        )}
        <Tabs defaultValue="steps">
          <TabsList>
            <TabsTrigger value="steps">Steps ({stepList.length})</TabsTrigger>
            <TabsTrigger value="people">People ({enrollments.data?.length ?? 0})</TabsTrigger>
          </TabsList>

          <TabsContent value="steps">
            <div className="rounded-lg border bg-background">
              <div className="flex items-center justify-between gap-4 border-b p-4">
                <p className="text-sm text-muted-foreground">
                  Changes never rebuild anyone's tasks. Each person picks up the current steps when
                  they finish the one they are on.
                </p>
                {canEdit && (
                  <Button variant="outline" onClick={() => setEditingStep("new")}>
                    <Plus className="mr-2 h-4 w-4" aria-hidden />
                    Add step
                  </Button>
                )}
              </div>
              {stepList.length === 0 ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  No steps yet. Add the first step to start building this sequence.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">#</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Wait</TableHead>
                      <TableHead>Message</TableHead>
                      {canEdit && <TableHead className="w-44 text-right">Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stepList.map((step, index) => (
                      <TableRow key={step.id}>
                        <TableCell>{index + 1}</TableCell>
                        <TableCell>{STEP_LABELS[step.type]}</TableCell>
                        <TableCell className="font-medium">{step.title}</TableCell>
                        <TableCell>
                          {step.waitDays === 0
                            ? index === 0
                              ? "Day of enrollment"
                              : "Same day"
                            : `${step.waitDays} day${step.waitDays === 1 ? "" : "s"}`}
                        </TableCell>
                        <TableCell className="max-w-xs truncate text-muted-foreground">
                          {step.templateId
                            ? `Template: ${templateName(step.templateId) ?? "(deleted)"}`
                            : step.type === "phone_call"
                              ? step.callObjectives || step.callScript || "—"
                              : step.subject || step.body || "—"}
                        </TableCell>
                        {canEdit && (
                          <TableCell className="whitespace-nowrap text-right">
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Move ${step.title} up`}
                              disabled={index === 0 || act.isPending}
                              onClick={() => move(index, -1)}
                            >
                              <ArrowUp className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Move ${step.title} down`}
                              disabled={index === stepList.length - 1 || act.isPending}
                              onClick={() => move(index, 1)}
                            >
                              <ArrowDown className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Edit ${step.title}`}
                              onClick={() => setEditingStep(step)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Delete ${step.title}`}
                              disabled={act.isPending}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Delete "${step.title}"? Anyone waiting on it moves to the next step.`,
                                  )
                                ) {
                                  act.mutate(() => api("DELETE", `/api/steps/${step.id}`));
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabsContent>

          <TabsContent value="people">
            <div className="rounded-lg border bg-background">
              {enrollments.data?.length === 0 ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  Nobody is enrolled yet.
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
                    {enrollments.data?.map((e) => {
                      const name = e.leadId
                        ? `${e.leadFirstName} ${e.leadLastName}`
                        : `${e.contactFirstName} ${e.contactLastName}`;
                      const current = stepList.find((s) => s.id === e.currentStepId);
                      const status =
                        e.state === "ended"
                          ? (END_REASONS[e.endReason ?? ""] ?? "Ended")
                          : e.state === "paused"
                            ? "Paused"
                            : "Active";
                      return (
                        <TableRow key={e.id}>
                          <TableCell className="font-medium">
                            {name}
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              {e.leadId ? "Lead" : "Contact"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={status} />
                          </TableCell>
                          <TableCell>{current?.title ?? "—"}</TableCell>
                          <TableCell>
                            {e.nextDueOn ? formatDate(`${e.nextDueOn}T12:00:00`) : "—"}
                          </TableCell>
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
                                    act.mutate(() => api("POST", `${path}/${action}`));
                                  } else {
                                    act.mutate(() =>
                                      api("POST", `${path}/stop`, { reason: action }),
                                    );
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
          </TabsContent>
        </Tabs>
      </div>

      {editingStep && (
        <StepDialog
          sequenceId={id}
          step={editingStep}
          templates={templates.data ?? []}
          onClose={() => setEditingStep(null)}
        />
      )}
      {enrolling && <EnrollDialog sequenceId={id} onClose={() => setEnrolling(false)} />}
    </div>
  );
}
