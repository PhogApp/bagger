import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { StatusBadge } from "@/components/StatusBadge";
import { ImportButton } from "@/components/ImportRecords";
import { canUse, permissionsFor, useMe, useStatuses, useOrgUsers } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { defaultStatus, nameOf, ownerField, statusColor, statusField } from "./shared";

export interface Account {
  id: string;
  ownerId: string;
  name: string;
  website: string | null;
  status: string;
  createdAt: string;
}

export function AccountsPage() {
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();
  const { data: statuses } = useStatuses();

  const fields: Field[] = [
    { name: "name", label: "Account Name", required: true, span: 6 },
    { name: "website", label: "Website", kind: "url", placeholder: "www.company.com" },
    {
      name: "linkedin",
      label: "LinkedIn",
      kind: "url",
      placeholder: "linkedin.com/company/…",
    },
    { name: "hqPhone", label: "HQ Phone", kind: "tel", placeholder: "(555) 123-4567", span: 2 },
    { ...statusField(statuses, "accounts"), span: 2 },
    { ...ownerField(users), span: 2 },
    { name: "notes", label: "Notes", kind: "textarea", span: 6 },
  ];

  const columns: Column<Account>[] = [
    { header: "Name", cell: (a) => <span className="font-medium">{a.name}</span> },
    { header: "Website", cell: (a) => a.website ?? "—" },
    { header: "Owner", cell: (a) => nameOf(users, a.ownerId) },
    { header: "Status", cell: (a) => <StatusBadge status={a.status} color={statusColor(statuses, "accounts", a.status)} /> },
    { header: "Created", cell: (a) => formatDate(a.createdAt) },
  ];

  return (
    <RecordPage<Account>
      object="accounts"
      recordType="account"
      title="Accounts"
      subtitle="Manage your business accounts"
      singular="Account"
      searchPlaceholder="Search accounts by name or website…"
      fields={fields}
      columns={columns}
      defaults={{ status: defaultStatus(statuses, "accounts"), ownerId: me?.user.id ?? "" }}
      headerActions={
        canUse(me, "data.import") && permissionsFor(me, "accounts").canCreate ? (
          <ImportButton kind="accounts" />
        ) : undefined
      }
      describe={(a) => a.name}
    />
  );
}
