import { AccountRelated } from "@/components/AccountRelated";
import { ImportButton } from "@/components/ImportRecords";
import { RecordDetail } from "@/components/RecordDetail";
import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { StatusBadge } from "@/components/StatusBadge";
import { canUse, permissionsFor, useMe, useOrgUsers, useStatuses } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { defaultStatus, nameOf, ownerField, statusColor, statusField } from "./shared";

export interface Account {
  id: string;
  ownerId: string;
  name: string;
  website: string | null;
  status: string;
  createdAt: string;
  [field: string]: unknown;
}

function useAccountFields(): Field[] {
  const { data: users } = useOrgUsers();
  const { data: statuses } = useStatuses();
  return [
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
}

export function AccountsPage() {
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();
  const { data: statuses } = useStatuses();
  const fields = useAccountFields();

  const columns: Column<Account>[] = [
    { header: "Name", cell: (a) => <span className="font-medium">{a.name}</span> },
    { header: "Website", cell: (a) => a.website ?? "—" },
    { header: "Owner", cell: (a) => nameOf(users, a.ownerId) },
    {
      header: "Status",
      cell: (a) => (
        <StatusBadge status={a.status} color={statusColor(statuses, "accounts", a.status)} />
      ),
    },
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
      detailPath={(id) => `/accounts/${id}`}
      headerActions={
        canUse(me, "data.import") && permissionsFor(me, "accounts").canCreate ? (
          <ImportButton kind="accounts" />
        ) : undefined
      }
      describe={(a) => a.name}
    />
  );
}

export function AccountDetailPage({ params }: { params: { id: string } }) {
  const { data: statuses } = useStatuses();
  const fields = useAccountFields();
  return (
    <RecordDetail<Account>
      object="accounts"
      recordType="account"
      id={params.id}
      listHref="/accounts"
      listLabel="Accounts"
      fields={fields}
      title={(a) => a.name}
      subtitle={(a) => (a.website ?? "").replace(/^https?:\/\/(www\.)?/, "")}
      badge={(a) => (
        <StatusBadge status={a.status} color={statusColor(statuses, "accounts", a.status)} />
      )}
      below={(a) => (
        <section className="rounded-lg border bg-background p-5">
          <AccountRelated accountId={a.id} />
        </section>
      )}
      activity={(a) => ({ accountId: a.id })}
    />
  );
}
