import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { StatusBadge } from "@/components/StatusBadge";
import { BulkEnrollButton } from "@/components/BulkEnroll";
import { canUse, useApi, useMe, useOrgUsers } from "@/lib/api";
import { formatPhone } from "@/lib/utils";
import type { Account } from "./Accounts";
import { nameOf, ownerField, PERSON_STATUSES, toOptions } from "./shared";

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
}

export function ContactsPage() {
  const api = useApi();
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();
  const accounts = useQuery({
    queryKey: ["accounts", "for-picker"],
    queryFn: () => api<Account[]>("GET", "/api/accounts?limit=500"),
  });
  const accountName = (id: string) => accounts.data?.find((a) => a.id === id)?.name ?? "—";

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

  const fields: Field[] = [
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
    {
      name: "status",
      label: "Status",
      kind: "select",
      required: true,
      options: toOptions(PERSON_STATUSES),
    },
    ownerField(users),
    { name: "notes", label: "Notes", kind: "textarea", span: 6 },
  ];

  const columns: Column<Contact>[] = [
    {
      header: "Name",
      cell: (c) => <span className="font-medium">{`${c.firstName} ${c.lastName}`}</span>,
    },
    { header: "Title", cell: (c) => c.title ?? "—" },
    { header: "Account", cell: (c) => accountName(c.accountId) },
    { header: "Phone", cell: (c) => formatPhone(c.cellPhone ?? c.directPhone ?? c.hqPhone) },
    { header: "Owner", cell: (c) => nameOf(users, c.ownerId) },
    { header: "Status", cell: (c) => <StatusBadge status={c.status} /> },
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
      defaults={{ status: "New", ownerId: me?.user.id ?? "" }}
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
