import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Link } from "wouter";
import { StatusBadge } from "@/components/StatusBadge";
import { permissionsFor, useApi, useMe, useStatuses, type StatusObject } from "@/lib/api";
import { formatDay, formatMoney } from "@/lib/utils";

/**
 * The records that belong to an account, shown under the account's own
 * fields: its contacts and its opportunities. Each row opens that record.
 */

interface ContactRow {
  id: string;
  firstName: string;
  lastName: string;
  title: string | null;
  email: string;
  status: string;
}
interface OpportunityRow {
  id: string;
  name: string;
  amount: string | null;
  closeDate: string | null;
  status: string;
}

function Section(props: {
  title: string;
  /** Opens a new record already on this account. */
  addHref?: string;
  addLabel?: string;
  count: number | undefined;
  loading: boolean;
  error: Error | null;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {props.title}
          {props.count !== undefined && (
            <span className="ml-2 font-normal text-muted-foreground">{props.count}</span>
          )}
        </h3>
        {props.addHref && (
          <Link
            href={props.addHref}
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {props.addLabel}
          </Link>
        )}
      </div>
      {props.error ? (
        <p className="text-sm text-destructive">{props.error.message}</p>
      ) : props.loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : props.count === 0 ? (
        <p className="text-sm text-muted-foreground">{props.empty}</p>
      ) : (
        <ul className="max-h-56 divide-y overflow-y-auto rounded-md border">{props.children}</ul>
      )}
    </section>
  );
}

const rowClass =
  "flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/60 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

export function AccountRelated({ accountId }: { accountId: string }) {
  const api = useApi();
  const { data: statuses } = useStatuses();
  const { data: me } = useMe();
  const color = (object: StatusObject, name: string) =>
    statuses?.find((s) => s.object === object && s.name === name)?.color;

  const contacts = useQuery({
    queryKey: ["contacts", "by-account", accountId],
    queryFn: () => api<ContactRow[]>("GET", `/api/contacts?accountId=${accountId}&limit=500`),
  });
  const opportunities = useQuery({
    queryKey: ["opportunities", "by-account", accountId],
    queryFn: () =>
      api<OpportunityRow[]>("GET", `/api/opportunities?accountId=${accountId}&limit=500`),
  });

  return (
    <div className="mt-2 border-t">
      <Section
        title="Contacts"
        addHref={
          permissionsFor(me, "contacts").canCreate
            ? `/contacts?new=1&accountId=${accountId}`
            : undefined
        }
        addLabel="Add contact"
        count={contacts.data?.length}
        loading={contacts.isLoading}
        error={contacts.error}
        empty="No contacts on this account yet."
      >
        {contacts.data?.map((c) => (
          <li key={c.id}>
            <Link href={`/contacts?open=${c.id}`} className={rowClass}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {c.firstName} {c.lastName}
                </span>
                <span className="block truncate text-muted-foreground">
                  {[c.title, c.email].filter(Boolean).join(" · ")}
                </span>
              </span>
              <StatusBadge status={c.status} color={color("contacts", c.status)} />
            </Link>
          </li>
        ))}
      </Section>

      <Section
        title="Opportunities"
        addHref={
          permissionsFor(me, "opportunities").canCreate
            ? `/opportunities?new=1&accountId=${accountId}`
            : undefined
        }
        addLabel="Add opportunity"
        count={opportunities.data?.length}
        loading={opportunities.isLoading}
        error={opportunities.error}
        empty="No opportunities on this account yet."
      >
        {opportunities.data?.map((o) => (
          <li key={o.id}>
            <Link href={`/opportunities?open=${o.id}`} className={rowClass}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{o.name}</span>
                <span className="block truncate text-muted-foreground">
                  {[
                    o.amount === null ? "No amount" : formatMoney(Number(o.amount)),
                    o.closeDate ? `closes ${formatDay(o.closeDate)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <StatusBadge status={o.status} color={color("opportunities", o.status)} />
            </Link>
          </li>
        ))}
      </Section>
    </div>
  );
}
