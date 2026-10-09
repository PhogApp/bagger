import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { StatusBadge } from "@/components/StatusBadge";
import { useMe, useOrgUsers } from "@/lib/api";
import { formatPhone } from "@/lib/utils";
import { nameOf, ownerField, PERSON_STATUSES, toOptions } from "./shared";

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
    { name: "linkedin", label: "LinkedIn", kind: "url", placeholder: "https://linkedin.com/in/…" },
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

  const columns: Column<Lead>[] = [
    {
      header: "Name",
      cell: (l) => <span className="font-medium">{`${l.firstName} ${l.lastName}`}</span>,
    },
    { header: "Title", cell: (l) => l.title ?? "—" },
    { header: "Company", cell: (l) => l.company ?? "—" },
    { header: "Phone", cell: (l) => formatPhone(l.cellPhone ?? l.directPhone ?? l.hqPhone) },
    { header: "Owner", cell: (l) => nameOf(users, l.ownerId) },
    { header: "Status", cell: (l) => <StatusBadge status={l.status} /> },
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
      defaults={{ status: "New", ownerId: me?.user.id ?? "" }}
      describe={(l) => `${l.firstName} ${l.lastName}`}
    />
  );
}
