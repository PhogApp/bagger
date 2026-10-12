import { ActivityTimeline } from "@/components/ActivityTimeline";
import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { StatusBadge } from "@/components/StatusBadge";
import { BulkEnrollButton } from "@/components/BulkEnroll";
import { ConvertLeadButton } from "@/components/ConvertLead";
import { ImportButton } from "@/components/ImportRecords";
import { canUse, permissionsFor, useMe, useStatuses, useOrgUsers } from "@/lib/api";
import { formatPhone } from "@/lib/utils";
import { defaultStatus, nameOf, ownerField, statusColor, statusField } from "./shared";

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
}

export function LeadsPage() {
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();
  const { data: statuses } = useStatuses();

  const fields: Field[] = [
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
  ];

  const columns: Column<Lead>[] = [
    {
      header: "Name",
      cell: (l) => <span className="font-medium">{`${l.firstName} ${l.lastName}`}</span>,
    },
    { header: "Title", cell: (l) => l.title ?? "—" },
    { header: "Company", cell: (l) => l.company ?? "—" },
    { header: "Phone", cell: (l) => formatPhone(l.cellPhone ?? l.directPhone ?? l.hqPhone) },
    { header: "Owner", cell: (l) => nameOf(users, l.ownerId) },
    { header: "Status", cell: (l) => <StatusBadge status={l.status} color={statusColor(statuses, "leads", l.status)} /> },
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
      headerActions={
        canUse(me, "data.import") && permissionsFor(me, "leads").canCreate ? (
          <ImportButton kind="leads" />
        ) : undefined
      }
      bulkActions={
        canUse(me, "sequences.bulk_enroll")
          ? (selected, clear) => (
              <BulkEnrollButton kind="leads" people={selected} onDone={clear} />
            )
          : undefined
      }
      recordActions={(lead, close) =>
        permissionsFor(me, "leads").canEdit(lead.ownerId) &&
        permissionsFor(me, "contacts").canCreate ? (
          <ConvertLeadButton lead={lead} onDone={close} />
        ) : null
      }
      tabs={[
        {
          value: "activity",
          label: "Activity",
          render: (r) => <ActivityTimeline about={{ leadId: r.id }} />,
        },
      ]}
      describe={(l) => `${l.firstName} ${l.lastName}`}
    />
  );
}
