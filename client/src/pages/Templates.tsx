import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { applyMergeFields } from "../../../shared/merge";
import { RecordDetail } from "@/components/RecordDetail";
import { RichText } from "@/components/RichTextEditor";
import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { StatusBadge } from "@/components/StatusBadge";
import { useApi, useMe, useOrgUsers, type OrgUser } from "@/lib/api";
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
  updatedAt: string;
}

export const MERGE_FIELD_HELP =
  "Use {firstName}, {lastName}, {company}, {title} or {email} and Bagger fills them in for each person. Custom fields work too: {custom.key}, and {account.key} for a contact's account.";

const TYPE_LABEL = { email: "Email", linkedin: "LinkedIn" } as const;

function templateFields(users: OrgUser[] | undefined, type: Template["type"] = "email"): Field[] {
  return [
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
      // Email messages are formatted; LinkedIn has no formatting.
      kind: type === "email" ? "richtext" : "textarea",
      required: true,
      span: 6,
      rows: 10,
      help:
        type === "email"
          ? MERGE_FIELD_HELP
          : `${MERGE_FIELD_HELP} LinkedIn messages are plain text.`,
    },
    ownerField(users),
  ];
}

export function TemplatesPage() {
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();

  const columns: Column<Template>[] = [
    {
      key: "name",
      header: "Template Name",
      sort: "name",
      cell: (t) => <span className="font-medium">{t.name}</span>,
      csv: (t) => t.name,
    },
    { key: "subject", header: "Subject", sort: "subject", cell: (t) => t.subject ?? "—" },
    { key: "type", header: "Type", sort: "type", cell: (t) => TYPE_LABEL[t.type] },
    { key: "owner", header: "Owner", sort: "owner", cell: (t) => nameOf(users, t.ownerId) },
    {
      key: "createdAt",
      header: "Created",
      sort: "createdAt",
      cell: (t) => formatDate(t.createdAt),
      csv: (t) => t.createdAt,
    },
    {
      key: "updatedAt",
      header: "Last Changed",
      sort: "updatedAt",
      hidden: true,
      cell: (t) => formatDate(t.updatedAt),
      csv: (t) => t.updatedAt,
    },
  ];

  return (
    <RecordPage<Template>
      object="templates"
      recordType="template"
      title="Templates"
      singular="Template"
      searchPlaceholder="Search templates by name, subject, or content…"
      fields={templateFields(users)}
      columns={columns}
      defaults={{ type: "email", ownerId: me?.user.id ?? "" }}
      describe={(t) => t.name}
      detailPath={(id) => `/templates/${id}`}
      listTools={{}}
    />
  );
}

/** Someone to show the merge fields filled in for. */
const SAMPLE = {
  firstName: "Jordan",
  lastName: "Lee",
  email: "jordan.lee@acme.example",
  title: "Chief Financial Officer",
  company: "Acme Manufacturing",
};

/** The message as one person would get it. */
function Preview({ t }: { t: Template }) {
  const fill = (text: string) => applyMergeFields(text, SAMPLE);
  return (
    <section className="rounded-lg border bg-background p-5">
      <h2 className="text-sm font-semibold">Preview</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        As {SAMPLE.firstName} {SAMPLE.lastName}, {SAMPLE.title} at {SAMPLE.company}, would get it.
        Custom fields stay as written here and fill in for each person.
      </p>
      <div className="rounded-md border bg-muted/30 p-4 text-sm">
        {t.type === "email" && (
          <p className="mb-3 border-b pb-2">
            <span className="text-muted-foreground">Subject: </span>
            <span className="font-medium">{t.subject ? fill(t.subject) : "(no subject)"}</span>
          </p>
        )}
        {t.type === "email" ? (
          <RichText html={applyMergeFields(t.body, SAMPLE, { html: true })} />
        ) : (
          <p className="whitespace-pre-line">{fill(t.body)}</p>
        )}
      </div>
    </section>
  );
}

interface Usage {
  sequenceId: string;
  sequenceName: string;
  isActive: boolean;
  stepId: string;
  stepTitle: string;
  position: number;
}

/** The sequence steps that send this template. */
function UsedIn({ id }: { id: string }) {
  const api = useApi();
  const usage = useQuery({
    queryKey: ["templates", "usage", id],
    queryFn: () => api<Usage[]>("GET", `/api/templates/${id}/usage`),
  });
  return (
    <section className="rounded-lg border bg-background p-5">
      <h2 className="text-sm font-semibold">Used in</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Changes here reach these steps right away, including messages already waiting in Roll the Calls
        that haven't been edited for one person.
      </p>
      {usage.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !usage.data?.length ? (
        <p className="text-sm text-muted-foreground">No sequence uses this template yet.</p>
      ) : (
        <ul className="divide-y text-sm">
          {usage.data.map((u) => (
            <li key={u.stepId} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <Link href={`/sequences/${u.sequenceId}`} className="text-primary hover:underline">
                  {u.sequenceName}
                </Link>
                <span className="text-muted-foreground">
                  {" "}
                  · Step {u.position}: {u.stepTitle}
                </span>
              </span>
              <StatusBadge status={u.isActive ? "Active" : "Inactive"} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TemplateDetailPage({ params }: { params: { id: string } }) {
  const api = useApi();
  const { data: users } = useOrgUsers();
  // The same query the page itself runs: the message's editor depends on the type.
  const current = useQuery({
    queryKey: ["templates", "one", params.id],
    queryFn: () => api<Template>("GET", `/api/templates/${params.id}`),
  });
  return (
    <RecordDetail<Template & Record<string, unknown>>
      object="templates"
      recordType="template"
      id={params.id}
      listHref="/templates"
      listLabel="Templates"
      fields={templateFields(users, current.data?.type)}
      title={(t) => t.name}
      subtitle={(t) => `${TYPE_LABEL[t.type]} template · Owner: ${nameOf(users, t.ownerId)}`}
      below={(t) => (
        <>
          <Preview t={t} />
          <UsedIn id={t.id} />
        </>
      )}
    />
  );
}
