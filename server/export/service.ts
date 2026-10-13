import { asc, eq, getTableColumns } from "drizzle-orm";
import type { AnyPgColumn, PgTableWithColumns } from "drizzle-orm/pg-core";
import { strToU8, Zip, ZipDeflate } from "fflate";
import {
  accounts,
  activities,
  contacts,
  customFields,
  doNotContact,
  enrollments,
  events,
  fieldHistory,
  leads,
  memberships,
  opportunities,
  opportunityStageHistory,
  organizations,
  orgSettings,
  roles,
  savedReports,
  sequenceSteps,
  sequences,
  statusOptions,
  stepTasks,
  templates,
  users,
  type CustomFieldObject,
} from "../../shared/schema";
import type { Actor } from "../auth/actor";
import { requireTool } from "../auth/permissions";
import type { Db } from "../db/types";

/**
 * The full data export: every record the organization has, as one CSV file
 * per kind of record plus its change history, in a ZIP. Admins can run it at
 * any time, including when the account is locked or cancelled, so a customer
 * can always take their data with them.
 *
 * Deleted records are included (with their deleted_at) because their history
 * is. Rows are read a page at a time and the ZIP is streamed as it is built,
 * so a large organization doesn't have to fit in memory.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = PgTableWithColumns<any>;

interface Sheet {
  file: string;
  table: AnyTable;
  order: AnyPgColumn;
  /** Expand the `custom` column into one column per custom field. */
  custom?: CustomFieldObject;
  about: string;
}

const SHEETS: Sheet[] = [
  {
    file: "leads.csv",
    table: leads,
    order: leads.createdAt,
    custom: "leads",
    about: "Leads, including ones converted to contacts (converted_at, converted_contact_id).",
  },
  {
    file: "contacts.csv",
    table: contacts,
    order: contacts.createdAt,
    custom: "contacts",
    about: "Contacts; account_id points to accounts.csv.",
  },
  {
    file: "accounts.csv",
    table: accounts,
    order: accounts.createdAt,
    custom: "accounts",
    about: "Accounts.",
  },
  {
    file: "opportunities.csv",
    table: opportunities,
    order: opportunities.createdAt,
    custom: "opportunities",
    about: "Opportunities; status is the pipeline stage.",
  },
  {
    file: "opportunity_stage_history.csv",
    table: opportunityStageHistory,
    order: opportunityStageHistory.changedAt,
    about: "Every move of an opportunity from one stage to another.",
  },
  {
    file: "activities.csv",
    table: activities,
    order: activities.createdAt,
    about: "Calls, emails, LinkedIn touches, meetings and notes, open and completed.",
  },
  {
    file: "templates.csv",
    table: templates,
    order: templates.createdAt,
    about: "Email and LinkedIn templates. Email bodies are HTML.",
  },
  { file: "sequences.csv", table: sequences, order: sequences.createdAt, about: "Sequences." },
  {
    file: "sequence_steps.csv",
    table: sequenceSteps,
    order: sequenceSteps.createdAt,
    about: "The steps of each sequence, in position order.",
  },
  {
    file: "enrollments.csv",
    table: enrollments,
    order: enrollments.enrolledAt,
    about: "Who was enrolled in which sequence, and how it ended.",
  },
  {
    file: "step_tasks.csv",
    table: stepTasks,
    order: stepTasks.createdAt,
    about:
      "Each step as it came due for a person: done, skipped or open, with the message sent and call outcomes.",
  },
  {
    file: "do_not_contact.csv",
    table: doNotContact,
    order: doNotContact.createdAt,
    about: "Email addresses and domains marked Do Not Contact.",
  },
  {
    file: "statuses.csv",
    table: statusOptions,
    order: statusOptions.position,
    about: "Your status lists for each kind of record, and what each status does.",
  },
  {
    file: "custom_fields.csv",
    table: customFields,
    order: customFields.createdAt,
    about: "Your custom fields. Their values are columns in the record files.",
  },
  {
    file: "saved_reports.csv",
    table: savedReports,
    order: savedReports.createdAt,
    about: "Saved reports; definition is the report as JSON.",
  },
  {
    file: "history.csv",
    table: fieldHistory,
    order: fieldHistory.createdAt,
    about: "Every change to every record: who, when, which field, old and new value.",
  },
  {
    file: "events.csv",
    table: events,
    order: events.occurredAt,
    about: "Sequence events (enrolled, step completed or skipped, ended) and exports.",
  },
];

/** Columns holding a user's id get the user's name beside them. */
const USER_COLUMNS = new Set([
  "ownerId",
  "userId",
  "createdBy",
  "actorId",
  "changedBy",
  "closedBy",
  "doneBy",
]);

const PAGE = 2000;

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** One CSV value. Text a spreadsheet would run as a formula is kept as text. */
function cell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (value instanceof Date) text = value.toISOString();
  else if (Array.isArray(value)) text = value.map((v) => String(v)).join("; ");
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  if (/^[=@\t\r]/.test(text) || /^[+-][^\d\s.(]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const line = (values: unknown[]) => `${values.map(cell).join(",")}\r\n`;

/** A file name that is safe everywhere: "Phog, Inc." becomes "phog-inc". */
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "organization";

export async function exportFileName(db: Db, actor: Actor): Promise<string> {
  requireTool(actor.permissions, "account.full_export");
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, actor.orgId));
  return `bagger-export-${slug(org?.name ?? "")}-${new Date().toISOString().slice(0, 10)}.zip`;
}

/**
 * Build the export, handing the ZIP to `write` a piece at a time. Resolves
 * when the last piece has been written.
 */
export async function writeExport(
  db: Db,
  actor: Actor,
  write: (chunk: Uint8Array) => void,
): Promise<{ files: string[]; rows: number }> {
  requireTool(actor.permissions, "account.full_export");
  const orgId = actor.orgId;

  let finished!: () => void;
  let failed!: (e: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finished = resolve;
    failed = reject;
  });
  const zip = new Zip((err, chunk, final) => {
    if (err) return failed(err);
    write(chunk);
    if (final) finished();
  });
  const files: string[] = [];
  let rows = 0;
  const addFile = (name: string) => {
    const file = new ZipDeflate(name, { level: 6 });
    zip.add(file);
    files.push(name);
    // A byte-order mark so Excel opens the files as UTF-8.
    file.push(strToU8("﻿"));
    return {
      push: (text: string) => file.push(strToU8(text)),
      end: () => file.push(new Uint8Array(0), true),
    };
  };

  // People are named, not just numbered, wherever they appear.
  const people = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: roles.name,
      status: memberships.status,
      endsOn: memberships.endsOn,
      joined: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .leftJoin(roles, eq(memberships.roleId, roles.id))
    .where(eq(memberships.orgId, orgId))
    .orderBy(asc(users.name));
  const nameOf = new Map(people.map((p) => [p.id, p.name]));

  const defs = await db
    .select()
    .from(customFields)
    .where(eq(customFields.orgId, orgId))
    .orderBy(asc(customFields.createdAt));

  for (const sheet of SHEETS) {
    const columns = Object.entries(getTableColumns(sheet.table)).filter(
      ([key]) => key !== "orgId" && !(sheet.custom && key === "custom"),
    );
    const fields = sheet.custom ? defs.filter((d) => d.object === sheet.custom) : [];
    // Custom fields are headed by their label; a repeated label gets its key too.
    const labels = fields.map((d) =>
      fields.filter((x) => x.label === d.label).length > 1 ? `${d.label} (${d.key})` : d.label,
    );
    const header: string[] = [];
    for (const [key] of columns) {
      header.push(snake(key));
      if (USER_COLUMNS.has(key)) header.push(`${snake(key).replace(/_id$|_by$/, "")}_name`);
    }
    header.push(...labels);

    const out = addFile(sheet.file);
    out.push(line(header));
    for (let offset = 0; ; offset += PAGE) {
      const page = (await db
        .select()
        .from(sheet.table)
        .where(eq(sheet.table.orgId, orgId))
        .orderBy(asc(sheet.order), asc(sheet.table.id))
        .limit(PAGE)
        .offset(offset)) as Record<string, unknown>[];
      for (const row of page) {
        const values: unknown[] = [];
        for (const [key] of columns) {
          values.push(row[key]);
          if (USER_COLUMNS.has(key))
            values.push(row[key] ? (nameOf.get(String(row[key])) ?? "") : "");
        }
        const custom = (row.custom ?? {}) as Record<string, unknown>;
        for (const d of fields) values.push(custom[d.key]);
        out.push(line(values));
      }
      rows += page.length;
      if (page.length < PAGE) break;
    }
    out.end();
  }

  const team = addFile("users.csv");
  team.push(line(["id", "name", "email", "role", "status", "ends_on", "joined_at"]));
  for (const p of people) {
    team.push(line([p.id, p.name, p.email, p.role, p.status, p.endsOn, p.joined]));
  }
  team.end();

  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
  const about = addFile("organization.csv");
  about.push(
    line([
      "name",
      "owner",
      "billing_email",
      "time_zone",
      "wait_days",
      "postal_address",
      "created_at",
    ]),
  );
  about.push(
    line([
      org.name,
      org.ownerUserId ? (nameOf.get(org.ownerUserId) ?? "") : "",
      org.billingEmail,
      settings?.timezone,
      settings?.waitDayMode,
      settings?.postalAddress,
      org.createdAt,
    ]),
  );
  about.end();

  const readme = new ZipDeflate("README.txt", { level: 6 });
  zip.add(readme);
  files.push("README.txt");
  readme.push(
    strToU8(
      [
        `Bagger export for ${org.name}, made ${new Date().toISOString()}.`,
        "",
        "One CSV file per kind of record. Dates and times are UTC (ISO 8601). Each row's",
        "id is how other files point to it: contacts.csv account_id is an id in",
        "accounts.csv, and so on. Deleted records are included; deleted_at says when.",
        "Columns holding a person's id have their name beside them (owner_id, owner_name).",
        "Text that a spreadsheet would treat as a formula starts with an apostrophe.",
        "",
        ...SHEETS.map((s) => `${s.file}: ${s.about}`),
        "users.csv: Everyone in the organization, with their role.",
        "organization.csv: The organization and its settings.",
        "",
      ].join("\r\n"),
    ),
    true,
  );
  zip.end();
  await done;

  // Who took the data, and when, is kept with the organization's events.
  await db.insert(events).values({
    orgId,
    type: "data.exported",
    actorId: actor.userId,
    data: { files: files.length, rows },
  });
  return { files, rows };
}
