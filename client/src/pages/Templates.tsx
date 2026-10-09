import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { useMe, useOrgUsers } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { nameOf, ownerField } from "./shared";

export interface Template {
  id: string;
  ownerId: string;
  name: string;
  type: "email" | "linkedin";
  subject: string | null;
  body: string;
  createdAt: string;
}

export const MERGE_FIELD_HELP =
  "Use {firstName}, {lastName}, {company}, {title} or {email} and Bagger fills them in for each person.";

export function TemplatesPage() {
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();

  const fields: Field[] = [
    { name: "name", label: "Template Name", required: true },
    {
      name: "type",
      label: "Type",
      kind: "select",
      required: true,
      options: [
        { value: "email", label: "Email" },
        { value: "linkedin", label: "LinkedIn" },
      ],
    },
    {
      name: "subject",
      label: "Email Subject",
      span: 6,
      help: "Leave empty for LinkedIn templates.",
    },
    {
      name: "body",
      label: "Message",
      kind: "textarea",
      required: true,
      span: 6,
      rows: 10,
      help: MERGE_FIELD_HELP,
    },
    ownerField(users),
  ];

  const columns: Column<Template>[] = [
    { header: "Template Name", cell: (t) => <span className="font-medium">{t.name}</span> },
    { header: "Subject", cell: (t) => t.subject ?? "—" },
    { header: "Type", cell: (t) => (t.type === "email" ? "Email" : "LinkedIn") },
    { header: "Owner", cell: (t) => nameOf(users, t.ownerId) },
    { header: "Created", cell: (t) => formatDate(t.createdAt) },
  ];

  return (
    <RecordPage<Template>
      object="templates"
      recordType="template"
      title="Templates"
      subtitle="Email and LinkedIn messages used by your sequences"
      singular="Template"
      searchPlaceholder="Search templates by name, subject, or content…"
      fields={fields}
      columns={columns}
      defaults={{ type: "email", ownerId: me?.user.id ?? "" }}
      describe={(t) => t.name}
    />
  );
}
