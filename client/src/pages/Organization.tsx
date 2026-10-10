import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApi, useMe } from "@/lib/api";
import { useSession } from "@/lib/session";

interface Person {
  id: string;
  name: string;
  email: string;
}
interface Organization {
  name: string;
  billingEmail: string | null;
  owner: Person;
  transferCandidates: Person[];
}

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-background">
      <div className="border-b p-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** The owner's tab: the organization itself, who owns it, and billing. */
export function OrganizationPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { data: me } = useMe();
  const { orgName, manageMembers } = useSession();

  const org = useQuery({
    queryKey: ["organization"],
    queryFn: () => api<Organization>("GET", "/api/organization"),
    enabled: me?.isOwner === true,
  });

  const [billingEmail, setBillingEmail] = useState("");
  const savedBillingEmail = org.data?.billingEmail ?? "";
  useEffect(() => setBillingEmail(savedBillingEmail), [savedBillingEmail]);

  const [newOwner, setNewOwner] = useState("");
  const [confirming, setConfirming] = useState(false);

  const saveBilling = useMutation({
    mutationFn: () => api("PATCH", "/api/organization", { billingEmail }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["organization"] }),
  });
  const transfer = useMutation({
    mutationFn: () => api("POST", "/api/organization/transfer", { userId: newOwner }),
    onSuccess: async () => {
      // This tab belongs to the new owner now.
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      navigate("/settings");
    },
  });

  if (!me) return null;
  if (!me.isOwner) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Owner only</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page is for the person who owns your organization.
        </p>
      </div>
    );
  }
  if (org.error) {
    return <p className="p-10 text-center text-sm text-destructive">{org.error.message}</p>;
  }
  if (!org.data) return <p className="p-10 text-center text-sm">Loading…</p>;

  const candidates = org.data.transferCandidates;
  const chosen = candidates.find((c) => c.id === newOwner);

  return (
    <div>
      <div className="border-b bg-background px-6 py-4">
        <h1 className="text-2xl font-semibold tracking-tight">Organization</h1>
        <p className="text-sm text-muted-foreground">
          Only you see this page, as the owner of {orgName}
        </p>
      </div>
      <div className="max-w-4xl space-y-6 p-6">
        <Card title="Name and logo" description="How your organization appears to your team.">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm font-medium">{orgName}</p>
            {manageMembers && (
              <Button variant="outline" onClick={manageMembers}>
                Edit name and logo
              </Button>
            )}
          </div>
        </Card>

        <Card
          title="Owner"
          description="One person owns the organization. The owner is always an Admin."
        >
          <p className="text-sm">
            <span className="font-medium">{org.data.owner.name}</span>{" "}
            <span className="text-muted-foreground">({org.data.owner.email}) · you</span>
          </p>

          <div className="mt-4 border-t pt-4">
            <h3 className="text-sm font-medium">Transfer ownership</h3>
            {candidates.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Ownership can only pass to an Admin, and you are the only one. Make someone an
                Admin under{" "}
                <Link href="/admin" className="text-primary underline">
                  Admin
                </Link>{" "}
                first.
              </p>
            ) : (
              <>
                <p className="mt-1 text-sm text-muted-foreground">
                  The new owner takes over at once. You stay an Admin but lose this page.
                </p>
                <div className="mt-3 flex max-w-xl flex-wrap items-end gap-3">
                  <div className="min-w-56 flex-1 space-y-1.5">
                    <Label htmlFor="new-owner">New owner</Label>
                    <select
                      id="new-owner"
                      className={selectClass}
                      value={newOwner}
                      onChange={(e) => {
                        setNewOwner(e.target.value);
                        setConfirming(false);
                      }}
                    >
                      <option value="">Choose an Admin…</option>
                      {candidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.email})
                        </option>
                      ))}
                    </select>
                  </div>
                  {!confirming ? (
                    <Button
                      variant="outline"
                      disabled={!newOwner}
                      onClick={() => setConfirming(true)}
                    >
                      Transfer ownership
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="destructive"
                        disabled={transfer.isPending}
                        onClick={() => transfer.mutate()}
                      >
                        Yes, transfer to {chosen?.name}
                      </Button>
                      <Button variant="outline" onClick={() => setConfirming(false)}>
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
                {transfer.error && (
                  <p role="alert" className="mt-2 text-sm text-destructive">
                    {transfer.error.message}
                  </p>
                )}
              </>
            )}
          </div>
        </Card>

        <Card
          title="Billing"
          description="Invoices and payment notices go to you. Add a second address for a finance contact."
        >
          <div className="max-w-md space-y-1.5">
            <Label htmlFor="billing-email">Additional billing email (optional)</Label>
            <Input
              id="billing-email"
              type="email"
              value={billingEmail}
              onChange={(e) => setBillingEmail(e.target.value)}
              placeholder="accounts@yourcompany.com"
            />
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button
              onClick={() => saveBilling.mutate()}
              disabled={saveBilling.isPending || billingEmail === savedBillingEmail}
            >
              Save
            </Button>
            {saveBilling.error ? (
              <span role="alert" className="text-sm text-destructive">
                {saveBilling.error.message}
              </span>
            ) : (
              saveBilling.isSuccess && (
                <span role="status" className="text-sm text-muted-foreground">
                  Saved
                </span>
              )
            )}
          </div>
          <p className="mt-4 border-t pt-4 text-sm text-muted-foreground">
            Your card, invoices and seat count will appear here once payments are switched on.
          </p>
        </Card>
      </div>
    </div>
  );
}
