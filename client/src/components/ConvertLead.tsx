import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
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

interface Preview {
  suggestedAccountName: string | null;
  suggestedWebsite: string | null;
  matches: { id: string; name: string }[];
  existingContact: string | null;
  canCreateAccount: boolean;
}
interface AccountRow {
  id: string;
  name: string;
}

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

/** The "Convert to contact" button in a lead's dialog, and the dialog it opens. */
export function ConvertLeadButton(props: {
  lead: { id: string; firstName: string; lastName: string };
  /** Called after a successful conversion, to close the lead's own dialog. */
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <ArrowRightLeft className="mr-2 h-4 w-4" aria-hidden />
        Convert to contact
      </Button>
      {open && <ConvertDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function ConvertDialog({
  lead,
  onDone,
  onClose,
}: {
  lead: { id: string; firstName: string; lastName: string };
  onDone: () => void;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const preview = useQuery({
    queryKey: ["leads", "conversion", lead.id],
    queryFn: () => api<Preview>("GET", `/api/leads/${lead.id}/conversion`),
    gcTime: 0,
  });
  const accounts = useQuery({
    queryKey: ["accounts", "for-picker"],
    queryFn: () => api<AccountRow[]>("GET", "/api/accounts?limit=500"),
  });

  // "match:<id>" for a suggested account, "other" for the full list, "new" for a new account.
  const [choice, setChoice] = useState("");
  const [otherId, setOtherId] = useState("");
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");

  const data = preview.data;
  useEffect(() => {
    if (!data) return;
    setName(data.suggestedAccountName ?? "");
    setWebsite(data.suggestedWebsite ?? "");
    setChoice(
      data.matches.length > 0 ? `match:${data.matches[0].id}` : data.canCreateAccount ? "new" : "other",
    );
  }, [data]);

  const convert = useMutation({
    mutationFn: () => {
      const body =
        choice === "new"
          ? { newAccount: { name, website } }
          : { accountId: choice === "other" ? otherId : choice.replace("match:", "") };
      return api("POST", `/api/leads/${lead.id}/convert`, body);
    },
    onSuccess: async () => {
      for (const key of ["leads", "contacts", "accounts", "tasks"]) {
        await queryClient.invalidateQueries({ queryKey: [key] });
      }
      onClose();
      onDone();
      navigate("/contacts");
    },
  });

  const ready =
    choice === "new" ? name.trim() !== "" : choice === "other" ? otherId !== "" : choice !== "";
  const others = (accounts.data ?? []).filter((a) => !data?.matches.some((m) => m.id === a.id));
  const option = (value: string, label: React.ReactNode) => (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="radio"
        name="convert-account"
        className="mt-1"
        checked={choice === value}
        onChange={() => setChoice(value)}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Convert {lead.firstName} {lead.lastName} to a contact
          </DialogTitle>
          <DialogDescription>
            The contact keeps this lead's details, owner, status and history. If they are in a
            sequence it carries on from the same step. The lead leaves the Leads list.
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : preview.error ? (
          <p className="text-sm text-destructive">{preview.error.message}</p>
        ) : data?.existingContact ? (
          <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            This email already belongs to a contact: {data.existingContact}. A second contact
            can't be made from this lead; delete the lead if it is no longer needed.
          </p>
        ) : data ? (
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">Which account do they belong to?</legend>
            {data.matches.map((m) => (
              <div key={m.id}>
                {option(
                  `match:${m.id}`,
                  <>
                    <span className="font-medium">{m.name}</span>{" "}
                    <span className="text-muted-foreground">(existing account that matches)</span>
                  </>,
                )}
              </div>
            ))}
            {data.canCreateAccount && (
              <div className="space-y-2">
                {option("new", <span className="font-medium">A new account</span>)}
                {choice === "new" && (
                  <div className="grid grid-cols-2 gap-3 pl-6">
                    <div className="space-y-1.5">
                      <Label htmlFor="convert-name">Account name *</Label>
                      <Input id="convert-name" value={name} onChange={(e) => setName(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="convert-website">Website</Label>
                      <Input
                        id="convert-website"
                        value={website}
                        onChange={(e) => setWebsite(e.target.value)}
                        placeholder="www.company.com"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
            {others.length > 0 && (
              <div className="space-y-2">
                {option("other", <span className="font-medium">Another existing account</span>)}
                {choice === "other" && (
                  <div className="pl-6">
                    <select
                      aria-label="Existing account"
                      className={selectClass}
                      value={otherId}
                      onChange={(e) => setOtherId(e.target.value)}
                    >
                      <option value="">Select…</option>
                      {others.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
          </fieldset>
        ) : null}

        {convert.error && (
          <p role="alert" className="text-sm text-destructive">
            {convert.error.message}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {data && !data.existingContact && (
            <Button disabled={!ready || convert.isPending} onClick={() => convert.mutate()}>
              Convert
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
