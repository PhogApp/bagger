import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { money } from "@/components/BillingPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn, formatDate, formatDay } from "@/lib/utils";

/**
 * The staff console: every customer organization, where it stands with
 * trial and payment, and deleting the data of one that has left. Only Bagger
 * staff (STAFF_EMAILS on the server) can open it.
 */

type Status = "no_card" | "trial" | "paying" | "cancelling" | "locked" | "cancelled";

interface OrgSummary {
  id: string;
  name: string;
  createdAt: string;
  owner: { name: string; email: string } | null;
  status: Status;
  seats: number;
  removedSeats: number;
  monthlyCents: number;
  card: { brand: string; last4: string } | null;
  trialEndsOn: string | null;
  firstBilledOn: string | null;
  cancelsOn: string | null;
  cancelledAt: string | null;
  lastBill: { period: string; amountCents: number; status: string } | null;
  owedCents: number;
  paidCents: number;
  lastActive: string | null;
  canDelete: boolean;
}
interface StaffAction {
  id: string;
  staffEmail: string;
  action: string;
  orgId: string | null;
  orgName: string | null;
  data: Record<string, unknown> | null;
  createdAt: string;
}
interface Overview {
  billingOn: boolean;
  totals: {
    organizations: number;
    trial: number;
    paying: number;
    locked: number;
    cancelled: number;
    noCard: number;
    users: number;
    monthlyCents: number;
    trialMonthlyCents: number;
    owedCents: number;
  };
  organizations: OrgSummary[];
  recentActions: StaffAction[];
}
interface OrgDetail extends OrgSummary {
  timezone: string;
  billingEmail: string | null;
  stripeCustomerId: string | null;
  clerkOrgId: string | null;
  cardExpires: string | null;
  counts: Record<
    "leads" | "contacts" | "accounts" | "opportunities" | "activities" | "sequences" | "templates",
    number
  >;
  people: {
    id: string;
    name: string;
    email: string;
    role: string | null;
    status: "active" | "ending" | "removed";
    seatStartedOn: string;
    endsOn: string | null;
    joinedAt: string;
  }[];
  invoices: {
    id: string;
    period: string;
    status: "open" | "paid" | "failed" | "void";
    amountCents: number;
    hostedUrl: string | null;
    failureMessage: string | null;
    paidAt: string | null;
    createdAt: string;
  }[];
  staffActions: StaffAction[];
}

const STATUS_LABEL: Record<Status, string> = {
  trial: "Trial",
  paying: "Paying",
  cancelling: "Cancelling",
  locked: "Locked",
  no_card: "No card",
  cancelled: "Cancelled",
};
const STATUS_TONE: Record<Status, string> = {
  trial: "bg-sky-50 text-sky-800 border-sky-200",
  paying: "bg-emerald-50 text-emerald-800 border-emerald-200",
  cancelling: "bg-amber-50 text-amber-800 border-amber-200",
  locked: "bg-red-50 text-red-800 border-red-200",
  no_card: "bg-slate-50 text-slate-700 border-slate-200",
  cancelled: "bg-slate-100 text-slate-600 border-slate-300",
};
const FILTERS: (Status | "all")[] = [
  "all",
  "trial",
  "paying",
  "locked",
  "no_card",
  "cancelling",
  "cancelled",
];
const BILL_TEXT: Record<string, string> = {
  paid: "Paid",
  failed: "Unpaid",
  open: "Processing",
  void: "Void",
};

const periodName = (period: string) =>
  new Date(`${period}-15T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** "Trial · ends Oct 21", "Locked · $9.28 owed", "Cancelling · Oct 31". */
function statusDetail(o: OrgSummary): string | null {
  if (o.status === "trial" && o.trialEndsOn) return `ends ${formatDay(o.trialEndsOn)}`;
  if (o.status === "locked" && o.owedCents > 0) return `${money(o.owedCents)} owed`;
  if (o.status === "cancelling" && o.cancelsOn) return formatDay(o.cancelsOn);
  if (o.status === "cancelled" && o.cancelledAt) return formatDate(o.cancelledAt);
  return null;
}

function StatusBadge({ org }: { org: OrgSummary }) {
  const detail = statusDetail(org);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        className={cn(
          "rounded-full border px-2 py-0.5 text-xs font-medium",
          STATUS_TONE[org.status],
        )}
      >
        {STATUS_LABEL[org.status]}
      </span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </span>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

const peopleText = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const brand = (b: string) => b.charAt(0).toUpperCase() + b.slice(1);

function ActionLog({ actions, showOrg }: { actions: StaffAction[]; showOrg: boolean }) {
  if (actions.length === 0) return <p className="text-sm text-muted-foreground">None yet.</p>;
  return (
    <ul className="divide-y rounded-md border text-sm">
      {actions.map((a) => (
        <li key={a.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
          <span>
            {a.action === "organization.deleted"
              ? `Deleted ${showOrg ? (a.orgName ?? "an organization") : "this organization"}`
              : a.action === "owner.changed" && a.data
                ? `Made ${String(a.data.to)} the owner${showOrg && a.orgName ? ` of ${a.orgName}` : ""}${a.data.from ? ` (was ${String(a.data.from)})` : ""}${a.data.madeAdmin ? ", and an Admin" : ""}`
                : a.action === "clerk.delete_failed"
                  ? "Couldn't remove the organization from sign-in (Clerk); remove it there by hand"
                  : a.action}
            {a.action === "organization.deleted" && a.data
              ? ` · ${peopleText(Number(a.data.peopleDeleted ?? 0))} removed`
              : ""}
          </span>
          <span className="text-muted-foreground">
            {a.staffEmail} · {formatDate(a.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Header({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-background px-6 py-4">
      {children}
    </div>
  );
}

export function StaffPage() {
  const api = useApi();
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<Status | "all">("all");
  const [q, setQ] = useState("");
  const overview = useQuery({
    queryKey: ["staff", "organizations"],
    queryFn: () => api<Overview>("GET", "/api/staff/organizations"),
  });

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (overview.data?.organizations ?? []).filter((o) => {
      if (filter !== "all" && o.status !== filter) return false;
      const text = `${o.name} ${o.owner?.name ?? ""} ${o.owner?.email ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [overview.data, filter, q]);

  if (overview.isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (overview.error)
    return <p className="p-6 text-sm text-destructive">{overview.error.message}</p>;
  const { totals, recentActions } = overview.data!;
  const countFor = (f: Status | "all") =>
    f === "all"
      ? totals.organizations
      : overview.data!.organizations.filter((o) => o.status === f).length;

  return (
    <div>
      <Header>
        <h1 className="text-2xl font-semibold tracking-tight">Staff console</h1>
      </Header>
      <div className="space-y-6 p-6">
        {!overview.data!.billingOn && (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Payments aren't switched on for this server (no Stripe key), so no organization has a
            card and revenue shows as nothing. "No card" doesn't mean a customer gave up here, so
            only cancelled organizations can be deleted.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Tile
            label="Monthly revenue"
            value={money(totals.monthlyCents)}
            note={`${totals.paying} paying`}
          />
          <Tile
            label="In trial"
            value={String(totals.trial)}
            note={`${money(totals.trialMonthlyCents)} a month if they stay`}
          />
          <Tile
            label="Locked"
            value={String(totals.locked)}
            note={totals.owedCents ? `${money(totals.owedCents)} owed` : "nothing owed"}
          />
          <Tile label="No card yet" value={String(totals.noCard)} note="signed up, didn't start" />
          <Tile label="Cancelled" value={String(totals.cancelled)} />
          <Tile
            label="Users"
            value={String(totals.users)}
            note={`in ${totals.organizations - totals.cancelled} open organizations`}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  "rounded-full border px-3 py-1 text-sm",
                  filter === f
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted",
                )}
              >
                {f === "all" ? "All" : STATUS_LABEL[f]}{" "}
                <span className="tabular-nums opacity-75">{countFor(f)}</span>
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-72">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Organization, owner or email"
              aria-label="Search organizations"
              className="pl-8"
            />
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border bg-background">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Organization</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Users</th>
                <th className="px-3 py-2 text-right font-medium">Monthly</th>
                <th className="px-3 py-2 font-medium">Last bill</th>
                <th className="px-3 py-2 text-right font-medium">Paid to date</th>
                <th className="px-3 py-2 font-medium">Last active</th>
                <th className="px-3 py-2 font-medium">Signed up</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {shown.map((o) => (
                <tr
                  key={o.id}
                  className="cursor-pointer hover:bg-muted/40"
                  onClick={() => navigate(`/staff/${o.id}`)}
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/staff/${o.id}`}
                      className="font-medium text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {o.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {o.owner ? `${o.owner.name} · ${o.owner.email}` : "No owner"}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge org={o} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{o.seats}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {o.status === "cancelled" ? "—" : money(o.monthlyCents)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {o.lastBill ? (
                      <>
                        {periodName(o.lastBill.period)} · {money(o.lastBill.amountCents)}{" "}
                        <span className="text-xs text-muted-foreground">
                          {BILL_TEXT[o.lastBill.status]}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(o.paidCents)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {o.lastActive ? formatDate(o.lastActive) : "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDate(o.createdAt)}</td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                    No organizations match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <section>
          <h2 className="mb-2 text-sm font-semibold">Recent staff actions</h2>
          <ActionLog actions={recentActions} showOrg />
        </section>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-background">
      <h2 className="border-b px-4 py-3 text-base font-semibold">{title}</h2>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Hand the organization to someone else, when the owner has left or can't be reached. */
function ChangeOwner({ org }: { org: OrgDetail }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const candidates = org.people.filter(
    (p) => p.status === "active" && p.email !== org.owner?.email,
  );
  const [userId, setUserId] = useState("");
  const chosen = candidates.find((p) => p.id === userId);
  const change = useMutation({
    mutationFn: () =>
      api<{ owner: string; madeAdmin: boolean }>(
        "POST",
        `/api/staff/organizations/${org.id}/owner`,
        { userId },
      ),
    onSuccess: async (r) => {
      toast.success(`${r.owner} now owns ${org.name}${r.madeAdmin ? " and is an Admin" : ""}`);
      setUserId("");
      await queryClient.invalidateQueries({ queryKey: ["staff", "organizations"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Panel title="Change the owner">
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">There's nobody else active to hand it to.</p>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            For when the owner has left or can't be reached. The new owner gets billing and the
            Organization tab.
          </p>
          <select
            aria-label="New owner"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 pr-9 text-sm"
          >
            <option value="">Choose someone…</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.role ?? "No role"}
              </option>
            ))}
          </select>
          {chosen && chosen.role !== "Admin" && (
            <p className="text-xs text-muted-foreground">
              {chosen.name} will be made an Admin too: the owner always is.
            </p>
          )}
          <Button
            variant="outline"
            className="w-full"
            disabled={!userId || change.isPending}
            onClick={() => change.mutate()}
          >
            {change.isPending ? "Changing…" : "Make owner"}
          </Button>
        </div>
      )}
    </Panel>
  );
}

export function StaffOrgPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { id } = useParams<{ id: string }>();
  const [confirmName, setConfirmName] = useState("");
  const org = useQuery({
    queryKey: ["staff", "organizations", id],
    queryFn: () => api<OrgDetail>("GET", `/api/staff/organizations/${id}`),
  });
  const remove = useMutation({
    mutationFn: () =>
      api<{ name: string; peopleDeleted: number; signIn: "removed" | "failed" | "none" }>(
        "POST",
        `/api/staff/organizations/${id}/delete`,
        { confirmName },
      ),
    onSuccess: async (r) => {
      const people = `${peopleText(r.peopleDeleted)} removed`;
      if (r.signIn === "failed") {
        toast.warning(
          `${r.name} deleted (${people}), but it couldn't be removed from Clerk. Delete it there by hand.`,
        );
      } else {
        toast.success(`${r.name} deleted · ${people}`);
      }
      queryClient.removeQueries({ queryKey: ["staff", "organizations", id] });
      await queryClient.invalidateQueries({ queryKey: ["staff", "organizations"] });
      navigate("/staff");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const back = (
    <Link
      href="/staff"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden /> All organizations
    </Link>
  );
  if (org.isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (org.error)
    return (
      <div className="space-y-3 p-6">
        {back}
        <p className="text-sm text-destructive">{org.error.message}</p>
      </div>
    );
  const o = org.data!;
  const active = o.people.filter((p) => p.status !== "removed");

  return (
    <div>
      <Header>
        <div className="space-y-1">
          {back}
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{o.name}</h1>
            <StatusBadge org={o} />
          </div>
        </div>
      </Header>
      <div className="grid max-w-6xl gap-6 p-6 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-6">
          <Panel title="Account">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label="Owner">
                {o.owner ? (
                  <>
                    {o.owner.name}
                    <div className="text-muted-foreground">{o.owner.email}</div>
                  </>
                ) : (
                  "—"
                )}
              </Fact>
              <Fact label="Signed up">{formatDate(o.createdAt)}</Fact>
              <Fact label="Last active">{o.lastActive ? formatDate(o.lastActive) : "—"}</Fact>
              <Fact label="Users">
                {o.seats}
                {o.status !== "cancelled" && ` · ${money(o.monthlyCents)} a month`}
                {o.removedSeats > 0 && (
                  <div className="text-muted-foreground">{o.removedSeats} removed</div>
                )}
              </Fact>
              <Fact label="Card">
                {o.card
                  ? `${brand(o.card.brand)} ending ${o.card.last4}${o.cardExpires ? ` · ${o.cardExpires}` : ""}`
                  : "None"}
              </Fact>
              <Fact label="Free week">
                {o.trialEndsOn
                  ? `${o.firstBilledOn ? "Ended" : "Ends"} ${formatDay(o.trialEndsOn)}`
                  : "Not started"}
              </Fact>
              <Fact label="Paid to date">{money(o.paidCents)}</Fact>
              <Fact label="Owed">{o.owedCents ? money(o.owedCents) : "Nothing"}</Fact>
              <Fact label="Time zone">{o.timezone}</Fact>
              <Fact label="Extra billing email">{o.billingEmail ?? "—"}</Fact>
              <Fact label="Stripe customer">
                <span className="font-mono text-xs">{o.stripeCustomerId ?? "—"}</span>
              </Fact>
              <Fact label="Clerk organization">
                <span className="font-mono text-xs">{o.clerkOrgId ?? "—"}</span>
              </Fact>
            </dl>
          </Panel>

          <Panel title={`People (${active.length})`}>
            <ul className="divide-y text-sm">
              {o.people.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className={cn(p.status === "removed" && "text-muted-foreground")}>
                    <span className="font-medium">{p.name}</span> · {p.email}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {p.role ?? "No role"} ·{" "}
                    {p.status === "removed"
                      ? "Removed"
                      : p.status === "ending"
                        ? `Ending ${p.endsOn ? formatDay(p.endsOn) : ""}`
                        : `Since ${formatDay(p.seatStartedOn)}`}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Bills">
            {o.invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {o.invoices.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {periodName(b.period)}
                      {b.failureMessage && b.status !== "paid" && (
                        <span className="ml-2 text-xs text-destructive">{b.failureMessage}</span>
                      )}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="tabular-nums">{money(b.amountCents)}</span>
                      <span className="text-xs text-muted-foreground">{BILL_TEXT[b.status]}</span>
                      {b.hostedUrl && (
                        <a
                          href={b.hostedUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          Invoice <ExternalLink className="h-3 w-3" aria-hidden />
                        </a>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Staff actions">
            <ActionLog actions={o.staffActions} showOrg={false} />
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="What it holds">
            <dl className="grid grid-cols-2 gap-3">
              {(
                [
                  ["Leads", o.counts.leads],
                  ["Contacts", o.counts.contacts],
                  ["Accounts", o.counts.accounts],
                  ["Opportunities", o.counts.opportunities],
                  ["Activities", o.counts.activities],
                  ["Sequences", o.counts.sequences],
                  ["Templates", o.counts.templates],
                ] as const
              ).map(([label, n]) => (
                <Fact key={label} label={label}>
                  <span className="tabular-nums">{n.toLocaleString()}</span>
                </Fact>
              ))}
            </dl>
          </Panel>

          {o.status !== "cancelled" && <ChangeOwner org={o} />}

          <section className="rounded-lg border border-red-200 bg-background">
            <h2 className="border-b border-red-200 px-4 py-3 text-base font-semibold text-red-900">
              Delete its data
            </h2>
            <div className="space-y-3 p-4 text-sm">
              {o.canDelete ? (
                <>
                  <p>
                    Permanently deletes {o.name}: every record, its history, its bills here, and its
                    people (unless they belong to another organization). It's removed from sign-in
                    too. This can't be undone.
                  </p>
                  <p className="text-muted-foreground">
                    Stripe keeps its own copy of the customer and past invoices.
                  </p>
                  <label className="block space-y-1">
                    <span className="text-xs text-muted-foreground">
                      Type <span className="font-medium text-foreground">{o.name}</span> to confirm
                    </span>
                    <Input
                      value={confirmName}
                      onChange={(e) => setConfirmName(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <Button
                    variant="destructive"
                    className="w-full"
                    disabled={confirmName.trim() !== o.name.trim() || remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    {remove.isPending ? "Deleting…" : "Delete permanently"}
                  </Button>
                </>
              ) : (
                <p className="text-muted-foreground">
                  Only a cancelled organization, or a sign-up that never added a card, can be
                  deleted. Customers keep their data until then.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
