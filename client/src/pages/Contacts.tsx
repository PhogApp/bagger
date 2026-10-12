import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { BulkEnrollButton } from "@/components/BulkEnroll";
import { ImportButton } from "@/components/ImportRecords";
import { RecordDetail } from "@/components/RecordDetail";
import { useLayout } from "@/lib/fields";
import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { StatusBadge } from "@/components/StatusBadge";
import { canUse, permissionsFor, useApi, useMe, useOrgUsers, useStatuses } from "@/lib/api";
import { formatDate, formatPhone } from "@/lib/utils";
import type { Account } from "./Accounts";
import {
  confirmStatusChange,
  defaultStatus,
  nameOf,
  ownerField,
  statusColor,
  statusField,
} from "./shared";

interface Contact {
  id: string;
  ownerId: string;
  accountId: string;
  firstName: string;
  lastName: string;
  title: string | null;
  email: string;
  cellPhone: string | null;
  directPhone: string | null;
  hqPhone: string | null;
  status: string;
  [field: string]: unknown;
}

/** Every account, for the Account picker and for showing account names. */
export function useAccountPicker() {
  const api = useApi();
  const accounts = useQuery({
    queryKey: ["accounts", "for-picker"],
    queryFn: () => api<Account[]>("GET", "/api/accounts?limit=500"),
  });
  const accountName = (id: string) => accounts.data?.find((a) => a.id === id)?.name ?? "—";
  return { accounts, accountName };
}

function useContactFields(): Field[] {
  const { data: users } = useOrgUsers();
  const { data: statuses } = useStatuses();
  const { accounts } = useAccountPicker();
  return useLayout("contacts", [
    { name: "firstName", label: "First Name", required: true, span: 2 },
    { name: "lastName", label: "Last Name", required: true, span: 2 },
    { name: "title", label: "Title", span: 2 },
    { name: "email", label: "Email", kind: "email", required: true },
    {
      name: "accountId",
      label: "Account",
      kind: "select",
      required: true,
      options: (accounts.data ?? []).map((a) => ({ value: a.id, label: a.name })),
    },
    { name: "cellPhone", label: "Cell Phone", kind: "tel", placeholder: "(555) 123-4567", span: 2 },
    {
      name: "directPhone",
      label: "Direct Phone",
      kind: "tel",
      placeholder: "(555) 123-4567",
      span: 2,
    },
    { name: "hqPhone", label: "HQ Phone", kind: "tel", placeholder: "(555) 123-4567", span: 2 },
    { name: "linkedin", label: "LinkedIn", kind: "url", placeholder: "linkedin.com/in/…" },
    statusField(statuses, "contacts"),
    ownerField(users),
    { name: "notes", label: "Notes", kind: "textarea", span: 6 },
  ]);
}

export function ContactsPage() {
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();
  const { data: statuses } = useStatuses();
  const { accounts, accountName } = useAccountPicker();
  const fields = useContactFields();

  // A contact must belong to an account, so there has to be one first.
  if (accounts.data?.length === 0) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every contact belongs to an account.{" "}
          <Link href="/accounts" className="text-primary underline">
            Add an account
          </Link>{" "}
          first, then come back to add contacts.
        </p>
      </div>
    );
  }

  const columns: Column<Contact>[] = [
    {
      header: "Name",
      sort: "name",
      csv: (c) => `${c.firstName} ${c.lastName}`,
      cell: (c) => <span className="font-medium">{`${c.firstName} ${c.lastName}`}</span>,
    },
    { header: "Title", sort: "title", cell: (c) => c.title ?? "—" },
    { header: "Account", sort: "account", cell: (c) => accountName(c.accountId) },
    { header: "Phone", cell: (c) => formatPhone(c.cellPhone ?? c.directPhone ?? c.hqPhone) },
    { header: "Owner", sort: "owner", cell: (c) => nameOf(users, c.ownerId) },
    {
      header: "Status",
      sort: "status",
      csv: (c) => c.status,
      cell: (c) => (
        <StatusBadge status={c.status} color={statusColor(statuses, "contacts", c.status)} />
      ),
    },

    {
      header: "Email",
      sort: "email",
      hidden: true,
      cell: (c) => c.email,
    },
    {
      header: "Created",
      sort: "createdAt",
      hidden: true,
      cell: (c) => formatDate(c.createdAt as string),
    },
    {
      header: "Last Modified",
      sort: "updatedAt",
      hidden: true,
      cell: (c) => formatDate(c.updatedAt as string),
    },
  ];

  return (
    <RecordPage<Contact>
      object="contacts"
      recordType="contact"
      title="Contacts"
      subtitle="Manage your contact relationships"
      singular="Contact"
      searchPlaceholder="Search contacts by name, email, or phone…"
      fields={fields}
      columns={columns}
      defaults={{ status: defaultStatus(statuses, "contacts"), ownerId: me?.user.id ?? "" }}
      detailPath={(id) => `/contacts/${id}`}
      listTools={{ statusObject: "contacts", customObject: "contacts" }}
      headerActions={
        canUse(me, "data.import") && permissionsFor(me, "contacts").canCreate ? (
          <ImportButton kind="contacts" />
        ) : undefined
      }
      bulkActions={
        canUse(me, "sequences.bulk_enroll")
          ? (selected, clear) => (
              <BulkEnrollButton kind="contacts" people={selected} onDone={clear} />
            )
          : undefined
      }
      describe={(c) => `${c.firstName} ${c.lastName}`}
    />
  );
}

export function ContactDetailPage({ params }: { params: { id: string } }) {
  const { data: me } = useMe();
  const { data: statuses } = useStatuses();
  const { accountName } = useAccountPicker();
  const fields = useContactFields();
  const accountLink = (c: Contact) => (
    <Link
      href={`/accounts/${c.accountId}`}
      className="text-primary hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {accountName(c.accountId)}
    </Link>
  );
  return (
    <RecordDetail<Contact>
      object="contacts"
      recordType="contact"
      id={params.id}
      listHref="/contacts"
      listLabel="Contacts"
      fields={fields}
      title={(c) => `${c.firstName} ${c.lastName}`}
      subtitle={(c) => (
        <>
          {c.title && `${c.title} at `}
          {accountLink(c)}
        </>
      )}
      badge={(c) => (
        <StatusBadge status={c.status} color={statusColor(statuses, "contacts", c.status)} />
      )}
      display={{ accountId: accountLink }}
      actions={(c) =>
        canUse(me, "sequences.enroll") ? (
          <BulkEnrollButton kind="contacts" people={[c]} onDone={() => undefined} standalone />
        ) : null
      }
      confirm={(field, value) => confirmStatusChange(statuses, "contacts", field, value)}
      activity={(c) => ({ contactId: c.id })}
    />
  );
}
