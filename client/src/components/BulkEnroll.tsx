import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { count, toast } from "@/lib/toast";
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
import { Label } from "@/components/ui/label";
import { messageFor, useApi } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { outcomeLabel, type EndReason } from "@/components/SequenceBits";

interface Person {
  id: string;
  firstName: string;
  lastName: string;
}
interface Sequence {
  id: string;
  name: string;
  isActive: boolean;
}
interface Result {
  enrolled: number;
  skipped: { id: string; reason: string }[];
}
interface Repeat {
  id: string;
  times: number;
  last: { endReason: EndReason | null; endedAt: string | null; asLead: boolean };
}

/** "Enroll in sequence" for the rows ticked on the Leads or Contacts list. */
export function BulkEnrollButton({
  kind,
  people,
  onDone,
  standalone = false,
}: {
  kind: "leads" | "contacts";
  people: Person[];
  onDone: () => void;
  /** On a record's own page rather than in the list's selection bar. */
  standalone?: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sequenceId, setSequenceId] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  // People who have been through the chosen sequence before; asked about first.
  const [repeats, setRepeats] = useState<Repeat[] | null>(null);

  const sequences = useQuery({
    queryKey: ["sequences", "for-picker"],
    queryFn: () => api<Sequence[]>("GET", "/api/sequences?limit=500"),
    enabled: open,
  });
  const active = sequences.data?.filter((s) => s.isActive) ?? [];

  const idsKey = kind === "leads" ? "leadIds" : "contactIds";
  // Before enrolling, look for anyone who has been through this sequence.
  const check = useMutation({
    mutationFn: () =>
      api<{ repeats: Repeat[] }>("POST", `/api/sequences/${sequenceId}/enrollments/check`, {
        [idsKey]: people.map((p) => p.id),
      }),
    onSuccess: (res) => {
      if (res.repeats.length === 0) enroll.mutate(people.map((p) => p.id));
      else setRepeats(res.repeats);
    },
  });
  const enroll = useMutation({
    mutationFn: (ids: string[]) =>
      api<Result>("POST", `/api/sequences/${sequenceId}/enrollments/bulk`, { [idsKey]: ids }),
    onSuccess: async (res) => {
      setRepeats(null);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["sequences"] });
      await queryClient.invalidateQueries({ queryKey: ["sequence"] });
      await queryClient.invalidateQueries({ queryKey: [kind] });
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      await queryClient.invalidateQueries({ queryKey: ["sequence-history"] });
      const where = active.find((x) => x.id === sequenceId)?.name ?? "the sequence";
      const said = `${count(res.enrolled, "person", "people")} enrolled in ${where}`;
      if (res.skipped.length === 0) {
        // Nothing more to tell than the message: close and say so.
        toast.success(said);
        setOpen(false);
        setSequenceId("");
        enroll.reset();
        onDone();
      } else {
        // Who was skipped and why needs the room of the window.
        setResult(res);
        toast.warning(`${said}. ${res.skipped.length} skipped.`);
      }
    },
  });

  const close = () => {
    setOpen(false);
    if (result) onDone();
    setResult(null);
    setRepeats(null);
    setSequenceId("");
    enroll.reset();
    check.reset();
  };
  const sequenceName = active.find((x) => x.id === sequenceId)?.name ?? "this sequence";
  const repeatIds = new Set(repeats?.map((r) => r.id));
  const rest = people.filter((p) => !repeatIds.has(p.id));
  const busy = check.isPending || enroll.isPending;
  const nameOf = (id: string) => {
    const p = people.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : "Someone";
  };

  return (
    <>
      <Button
        size={standalone ? "default" : "sm"}
        variant={standalone ? "outline" : "default"}
        onClick={() => setOpen(true)}
      >
        Enroll in sequence
      </Button>
      {open && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && close()}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                Enroll{" "}
                {people.length === 1
                  ? `${people[0].firstName} ${people[0].lastName}`
                  : `${people.length} people`}
              </DialogTitle>
              <DialogDescription>
                Each person's first step lands in your Roll the Calls queue. Anyone already in a
                sequence, or marked Do Not Contact, is skipped.
              </DialogDescription>
            </DialogHeader>

            {repeats && !result ? (
              <div role="alert" className="space-y-2 text-sm">
                <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
                  {people.length === 1
                    ? `${people[0].firstName} ${people[0].lastName} has been through ${sequenceName} before.`
                    : `${repeats.length} of these ${people.length} people have been through ${sequenceName} before.`}{" "}
                  You can still enroll them again.
                </p>
                <ul className="max-h-48 space-y-1 overflow-y-auto">
                  {repeats.map((r) => (
                    <li key={r.id}>
                      <span className="font-medium">{nameOf(r.id)}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {r.times === 1 ? "once" : `${r.times} times`}
                        {r.last.endedAt &&
                          ` · last ${outcomeLabel(r.last.endReason).toLowerCase()} ${formatDate(r.last.endedAt)}`}
                        {r.last.asLead && " (as a lead)"}
                      </span>
                    </li>
                  ))}
                </ul>
                {enroll.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {enroll.error.message}
                  </p>
                )}
              </div>
            ) : result ? (
              <div className="space-y-2 text-sm">
                <p className="text-base font-medium">{result.enrolled} enrolled.</p>
                {result.skipped.length > 0 && (
                  <>
                    <p>{result.skipped.length} skipped:</p>
                    <ul className="max-h-48 list-disc overflow-y-auto pl-5">
                      {result.skipped.map((s) => (
                        <li key={s.id}>
                          {nameOf(s.id)}: {messageFor(s.reason)}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="bulk-sequence">Sequence</Label>
                <select
                  id="bulk-sequence"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={sequenceId}
                  onChange={(e) => setSequenceId(e.target.value)}
                >
                  <option value="">Choose a sequence…</option>
                  {active.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {sequences.data && active.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    There are no active sequences yet. Create one under Sequences.
                  </p>
                )}
                {(check.error ?? enroll.error) && (
                  <p role="alert" className="text-sm text-destructive">
                    {(check.error ?? enroll.error)!.message}
                  </p>
                )}
              </div>
            )}

            <DialogFooter>
              {repeats && !result ? (
                <>
                  <Button variant="outline" disabled={busy} onClick={() => setRepeats(null)}>
                    Back
                  </Button>
                  {rest.length > 0 && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => enroll.mutate(rest.map((p) => p.id))}
                    >
                      Leave {repeats.length === 1 ? "them" : "those"} out
                    </Button>
                  )}
                  <Button disabled={busy} onClick={() => enroll.mutate(people.map((p) => p.id))}>
                    Enroll anyway
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={close}>
                    {result ? "Done" : "Cancel"}
                  </Button>
                  {!result && (
                    <Button disabled={!sequenceId || busy} onClick={() => check.mutate()}>
                      Enroll
                    </Button>
                  )}
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
