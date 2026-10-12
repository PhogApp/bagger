import { Link } from "wouter";
import { BulkEnrollButton } from "@/components/BulkEnroll";
import { ConvertLeadButton } from "@/components/ConvertLead";
import { ImportButton } from "@/components/ImportRecords";
import { RecordDetail } from "@/components/RecordDetail";
import { useLayout } from "@/lib/fields";
import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { StatusBadge } from "@/components/StatusBadge";
import { canUse, permissionsFor, useMe, useOrgUsers, useStatuses } from "@/lib/api";
import { formatDate, formatPhone } from "@/lib/utils";
import {
  confirmStatusChange,
  defaultStatus,
  nameOf,
  ownerField,
  statusColor,
  statusField,
} from "./shared";

interface Lead {
  id: string;
  ownerId: string;
  firstName: string;
  lastName: string;
  title: string | null;
  email: string;
  company: string | null;
  cellPhone: string | null;
  directPhone: string | null;
  hqPhone: string | null;
  status: string;
  convertedContactId: string | null;
  [field: string]: unknown;
}

function useLeadFields(): Field[] {
  const { data: users } = useOrgUsers();
  const { data: statuses } = useStatuses();
  return useLayout("leads", [
    { name: "firstName", label: "First Name", required: true, span: 2 },
    { name: "lastName", label: "Last Name", required: true, span: 2 },
    { name: "title", label: "Title", span: 2 },
    { name: "email", label: "Email", kind: "email", required: true },
    { name: "company", label: "Company" },
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
    statusField(statuses, "leads"),
    ownerField(users),
    { name: "notes", label: "Notes", kind: "textarea", span: 6 },
  ]);
}

export function LeadsPage() {
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();
  const { data: statuses } = useStatuses();
  const fields = useLeadFields();

  const columns: Column<Lead>[] = [
    {
      header: "Name",
      sort: "name",
      csv: (l) => `${l.firstName} ${l.lastName}`,
      cell: (l) => <span className="font-medium">{`${l.firstName} ${l.lastName}`}</span>,
    },
    { header: "Title", sort: "title", cell: (l) => l.title ?? "—" },
    { header: "Company", sort: "company", cell: (l) => l.company ?? "—" },
    { header: "Phone", cell: (l) => formatPhone(l.cellPhone ?? l.directPhone ?? l.hqPhone) },
    { header: "Owner", sort: "owner", cell: (l) => nameOf(users, l.ownerId) },
    {
      header: "Status",
      sort: "status",
      csv: (l) => l.status,
      cell: (l) => (
        <StatusBadge status={l.status} color={statusColor(statuses, "leads", l.status)} />
      ),
    },

    {
      header: "Email",
      sort: "email",
      hidden: true,
      cell: (l) => l.email,
    },
    {
      header: "Created",
      sort: "createdAt",
      hidden: true,
      cell: (l) => formatDate(l.createdAt as string),
    },
    {
      header: "Last Modified",
      sort: "updatedAt",
      hidden: true,
      cell: (l) => formatDate(l.updatedAt as string),
    },
  ];

  return (
    <RecordPage<Lead>
      object="leads"
      recordType="lead"
      title="Leads"
      subtitle="Manage your sales leads"
      singular="Lead"
      searchPlaceholder="Search leads by name, email, company, or phone…"
      fields={fields}
      columns={columns}
      defaults={{ status: defaultStatus(statuses, "leads"), ownerId: me?.user.id ?? "" }}
      detailPath={(id) => `/leads/${id}`}
      listTools={{ statusObject: "leads", customObject: "leads" }}
      headerActions={
        canUse(me, "data.import") && permissionsFor(me, "leads").canCreate ? (
          <ImportButton kind="leads" />
        ) : undefined
      }
      bulkActions={
        canUse(me, "sequences.bulk_enroll")
          ? (selected, clear) => <BulkEnrollButton kind="leads" people={selected} onDone={clear} />
          : undefined
      }
      describe={(l) => `${l.firstName} ${l.lastName}`}
    />
  );
}

export function LeadDetailPage({ params }: { params: { id: string } }) {
  const { data: me } = useMe();
  const { data: statuses } = useStatuses();
  const fields = useLeadFields();
  return (
    <RecordDetail<Lead>
      object="leads"
      recordType="lead"
      id={params.id}
      listHref="/leads"
      listLabel="Leads"
      fields={fields}
      title={(l) => `${l.firstName} ${l.lastName}`}
      subtitle={(l) => [l.title, l.company].filter(Boolean).join(" · ")}
      badge={(l) => (
        <StatusBadge status={l.status} color={statusColor(statuses, "leads", l.status)} />
      )}
      // A converted lead lives on as its contact; old links go there.
      redirect={(l) => (l.convertedContactId ? `/contacts/${l.convertedContactId}` : null)}
      frozen={(l) =>
        l.convertedContactId ? (
          <>
            This lead was converted to a contact and can no longer be changed.{" "}
            <Link href={`/contacts/${l.convertedContactId}`} className="font-medium underline">
              Open the contact
            </Link>
          </>
        ) : null
      }
      actions={(l) => (
        <>
          {canUse(me, "sequences.enroll") && (
            <BulkEnrollButton kind="leads" people={[l]} onDone={() => undefined} standalone />
          )}
          {permissionsFor(me, "leads").canEdit(l.ownerId) &&
            permissionsFor(me, "contacts").canCreate && (
              <ConvertLeadButton lead={l} onDone={() => undefined} />
            )}
        </>
      )}
      confirm={(field, value) => confirmStatusChange(statuses, "leads", field, value)}
      activity={(l) => ({ leadId: l.id })}
    />
  );
}
