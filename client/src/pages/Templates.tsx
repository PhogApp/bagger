import { useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { useState } from "react";
import { applyMergeFields } from "../../../shared/merge";
import { LINKEDIN_NOTE_LIMIT } from "../../../shared/linkedin";
import { htmlToText, looksLikeHtml, textToHtml } from "../../../shared/richtext";
import { RecordDetail } from "@/components/RecordDetail";
import { RichText } from "@/components/RichTextEditor";
import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

const TYPE_LABEL = { email: "Email", linkedin: "LinkedIn" } as const;

function templateFields(users: OrgUser[] | undefined, type: string = "email"): Field[] {
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
    // LinkedIn messages have no subject.
    ...(type === "email" ? [{ name: "subject", label: "Subject", span: 6 as const }] : []),
    type === "email"
      ? {
          name: "body",
          label: "Message",
          kind: "richtext" as const,
          required: true,
          span: 6 as const,
        }
      : {
          name: "body",
          label: "Message",
          kind: "plaintext" as const,
          required: true,
          span: 6 as const,
          rows: 6,
          maxLength: LINKEDIN_NOTE_LIMIT,
        },
    ownerField(users),
  ];
}

/** Switching a new template between Email and LinkedIn keeps what's written. */
function adjustForType(next: Record<string, string>, changed: string) {
  if (changed !== "type") return next;
  if (next.type === "linkedin") {
    return { ...next, subject: "", body: htmlToText(next.body ?? "") };
  }
  return {
    ...next,
    body: looksLikeHtml(next.body ?? "") ? next.body : textToHtml(next.body ?? ""),
  };
}

export function TemplatesPage() {
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();

  const columns: Column<Template>[] = [
    {
      key: "name",
      header: "Template Name",
      sort: "name",
      opens: true,
      cell: (t) => t.name,
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
      formFields={(values) => templateFields(users, values.type)}
      adjust={adjustForType}
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

/** The message as one person would get it, in a window. */
function PreviewButton({ t }: { t: Template }) {
  const [open, setOpen] = useState(false);
  const fill = (text: string) => applyMergeFields(text, SAMPLE);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Eye className="mr-2 h-4 w-4" aria-hidden />
        Preview
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Preview</DialogTitle>
            <DialogDescription>
              As {SAMPLE.firstName} {SAMPLE.lastName}, {SAMPLE.title} at {SAMPLE.company}, would get
              it. Custom fields stay as written here and fill in for each person.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto rounded-md border bg-muted/30 p-4 text-sm">
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
        </DialogContent>
      </Dialog>
    </>
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
      actions={(t) => <PreviewButton t={t} />}
    />
  );
}
