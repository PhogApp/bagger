import { AccountRelated } from "@/components/AccountRelated";
import { RecordDetail } from "@/components/RecordDetail";
import { useLayout } from "@/lib/fields";
import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { StatusBadge } from "@/components/StatusBadge";
import { useMe, useOrgUsers, useStatuses } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import {
  csvLast,
  LastSequenceCell,
  SequenceCountCell,
  SequenceHistory,
  type SequenceSummary,
} from "@/components/SequenceBits";
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
  return useLayout("accounts", [
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
  ]);
}

export function AccountsPage() {
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();
  const { data: statuses } = useStatuses();
  const fields = useAccountFields();

  const columns: Column<Account>[] = [
    {
      header: "Name",
      sort: "name",
      csv: (a) => a.name,
      cell: (a) => <span className="font-medium">{a.name}</span>,
    },
    { header: "Website", sort: "website", cell: (a) => a.website ?? "—" },
    { header: "Owner", sort: "owner", cell: (a) => nameOf(users, a.ownerId) },
    {
      header: "Status",
      sort: "status",
      csv: (a) => a.status,
      cell: (a) => (
        <StatusBadge status={a.status} color={statusColor(statuses, "accounts", a.status)} />
      ),
    },
    {
      key: "sequences",
      header: "Sequences",
      sort: "sequence",
      fresh: true,
      csv: (a) => {
        const s = a.sequences as SequenceSummary | undefined;
        return s ? `${s.inNow} in one now; ${s.total} run${s.total === 1 ? "" : "s"}` : "";
      },
      cell: (a) => <SequenceCountCell summary={a.sequences as SequenceSummary} account />,
    },
    {
      key: "lastSequence",
      header: "Last sequence",
      sort: "lastSequence",
      hidden: true,
      csv: (a) => csvLast(a.sequences as SequenceSummary),
      cell: (a) => <LastSequenceCell summary={a.sequences as SequenceSummary} />,
    },
    { header: "Created", sort: "createdAt", cell: (a) => formatDate(a.createdAt) },
    {
      header: "Last Modified",
      sort: "updatedAt",
      hidden: true,
      cell: (a) => formatDate(a.updatedAt as string),
    },
  ];

  return (
    <RecordPage<Account>
      object="accounts"
      recordType="account"
      title="Accounts"
      singular="Account"
      searchPlaceholder="Search accounts by name or website…"
      fields={fields}
      columns={columns}
      defaults={{ status: defaultStatus(statuses, "accounts"), ownerId: me?.user.id ?? "" }}
      detailPath={(id) => `/accounts/${id}`}
      listTools={{ statusObject: "accounts", customObject: "accounts", sequences: "accounts" }}
      importKind="accounts"
      addFromTopBar
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
        <>
          <section className="rounded-lg border bg-background p-5">
            <AccountRelated accountId={a.id} />
          </section>
          <SequenceHistory kind="accounts" id={a.id} />
        </>
      )}
      activity={(a) => ({ accountId: a.id })}
    />
  );
}
