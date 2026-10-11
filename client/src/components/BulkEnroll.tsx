import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

/** "Enroll in sequence" for the rows ticked on the Leads or Contacts list. */
export function BulkEnrollButton({
  kind,
  people,
  onDone,
}: {
  kind: "leads" | "contacts";
  people: Person[];
  onDone: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sequenceId, setSequenceId] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const sequences = useQuery({
    queryKey: ["sequences", "for-picker"],
    queryFn: () => api<Sequence[]>("GET", "/api/sequences?limit=500"),
    enabled: open,
  });
  const active = sequences.data?.filter((s) => s.isActive) ?? [];

  const enroll = useMutation({
    mutationFn: () =>
      api<Result>("POST", `/api/sequences/${sequenceId}/enrollments/bulk`, {
        [kind === "leads" ? "leadIds" : "contactIds"]: people.map((p) => p.id),
      }),
    onSuccess: async (res) => {
      setResult(res);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["sequences"] });
      await queryClient.invalidateQueries({ queryKey: ["sequence"] });
    },
  });

  const close = () => {
    setOpen(false);
    if (result) onDone();
    setResult(null);
    setSequenceId("");
    enroll.reset();
  };
  const nameOf = (id: string) => {
    const p = people.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : "Someone";
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Enroll in sequence
      </Button>
      {open && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && close()}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                Enroll {people.length} {people.length === 1 ? "person" : "people"}
              </DialogTitle>
              <DialogDescription>
                Each person's first step lands in your Run Steps queue. Anyone already in a
                sequence, or marked Do Not Contact, is skipped.
              </DialogDescription>
            </DialogHeader>

            {result ? (
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
                {enroll.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {enroll.error.message}
                  </p>
                )}
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={close}>
                {result ? "Done" : "Cancel"}
              </Button>
              {!result && (
                <Button disabled={!sequenceId || enroll.isPending} onClick={() => enroll.mutate()}>
                  Enroll
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
