import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Bagger data model, foundation slice.
 *
 * Every tenant-owned table carries org_id. Records are soft-deleted
 * (deleted_at) so audit history stays readable.
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const deletedAt = () => timestamp("deleted_at", { withTimezone: true });

// ---------------------------------------------------------------- enums

export const billingStatusEnum = pgEnum("billing_status", ["active", "locked", "cancelled"]);
export const membershipStatusEnum = pgEnum("membership_status", ["active", "ending", "removed"]);
export const waitDayModeEnum = pgEnum("wait_day_mode", ["business", "calendar"]);

export const personStatusEnum = pgEnum("person_status", [
  "New",
  "Active",
  "Prospecting",
  "Not Interested",
  "Do Not Contact",
]);
export const accountStatusEnum = pgEnum("account_status", [
  "Active",
  "Customer",
  "Vendor",
  "Partner",
  "Inactive",
  "Do Not Contact",
]);

export const templateTypeEnum = pgEnum("template_type", ["email", "linkedin"]);
export const stepTypeEnum = pgEnum("sequence_step_type", [
  "email",
  "phone_call",
  "linkedin_connect",
  "linkedin_message",
]);

export const enrollmentStateEnum = pgEnum("enrollment_state", ["active", "paused", "ended"]);
export const enrollmentEndReasonEnum = pgEnum("enrollment_end_reason", [
  "finished",
  "replied",
  "meeting_booked",
  "opted_out",
  "bounced",
  "status_change",
  "removed",
]);
export const stepTaskStateEnum = pgEnum("step_task_state", [
  "open",
  "completed",
  "skipped",
  "cancelled",
]);

export const dncKindEnum = pgEnum("dnc_kind", ["email", "domain"]);
export const historyActionEnum = pgEnum("history_action", ["create", "update", "delete"]);
export const historySourceEnum = pgEnum("history_source", ["user", "import", "system"]);

// -------------------------------------------------------------- tenancy

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  clerkOrgId: text("clerk_org_id").unique(),
  billingStatus: billingStatusEnum("billing_status").notNull().default("active"),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  clerkUserId: text("clerk_user_id").unique(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const orgSettings = pgTable("org_settings", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  waitDayMode: waitDayModeEnum("wait_day_mode").notNull().default("business"),
  /** IANA time zone used to decide what "today" is for due dates. */
  timezone: text("timezone").notNull().default("America/Chicago"),
  postalAddress: text("postal_address"),
  updatedAt: updatedAt(),
});

export const roles = pgTable(
  "roles",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Set for the preset roles: admin, manager, rep, read_only. */
    presetKey: text("preset_key"),
    /** The Admin role cannot be edited or deleted. */
    locked: boolean("locked").notNull().default(false),
    permissions: jsonb("permissions").$type<Record<string, string | boolean>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("roles_org_name_uq").on(t.orgId, t.name)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    status: membershipStatusEnum("status").notNull().default("active"),
    /** Last day of access when a seat has been removed mid-month. */
    endsOn: date("ends_on"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId)],
);

// ------------------------------------------------ people and companies

export const leads = pgTable(
  "leads",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    title: text("title"),
    email: text("email").notNull(),
    cellPhone: text("cell_phone"),
    directPhone: text("direct_phone"),
    hqPhone: text("hq_phone"),
    company: text("company"),
    linkedin: text("linkedin"),
    notes: text("notes"),
    status: personStatusEnum("status").notNull().default("New"),
    convertedContactId: uuid("converted_contact_id"),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("leads_org_idx").on(t.orgId), index("leads_org_email_idx").on(t.orgId, t.email)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    website: text("website"),
    linkedin: text("linkedin"),
    hqPhone: text("hq_phone"),
    notes: text("notes"),
    status: accountStatusEnum("status").notNull().default("Active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("accounts_org_idx").on(t.orgId)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    title: text("title"),
    email: text("email").notNull(),
    cellPhone: text("cell_phone"),
    directPhone: text("direct_phone"),
    hqPhone: text("hq_phone"),
    linkedin: text("linkedin"),
    notes: text("notes"),
    status: personStatusEnum("status").notNull().default("New"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("contacts_org_idx").on(t.orgId),
    index("contacts_org_email_idx").on(t.orgId, t.email),
  ],
);

export const doNotContact = pgTable(
  "do_not_contact",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: dncKindEnum("kind").notNull(),
    /** Lower-cased email address or domain. */
    value: text("value").notNull(),
    reason: text("reason"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("dnc_org_kind_value_uq").on(t.orgId, t.kind, t.value)],
);

// ------------------------------------------- templates and sequences

export const templates = pgTable(
  "templates",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    type: templateTypeEnum("type").notNull().default("email"),
    subject: text("subject"),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("templates_org_idx").on(t.orgId)],
);

export const sequences = pgTable(
  "sequences",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("sequences_org_idx").on(t.orgId)],
);

export const sequenceSteps = pgTable(
  "sequence_steps",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: stepTypeEnum("type").notNull(),
    title: text("title").notNull(),
    waitDays: integer("wait_days").notNull().default(0),
    /** When set, the template drives the content; subject/body below are ignored. */
    templateId: uuid("template_id").references(() => templates.id),
    subject: text("subject"),
    body: text("body"),
    callScript: text("call_script"),
    callObjectives: text("call_objectives"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("steps_sequence_idx").on(t.sequenceId, t.position),
    check("steps_wait_days_nonneg", sql`${t.waitDays} >= 0`),
  ],
);

// ---------------------------------------------------------- enrollment

export const enrollments = pgTable(
  "enrollments",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => sequences.id),
    leadId: uuid("lead_id").references(() => leads.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    state: enrollmentStateEnum("state").notNull().default("active"),
    endReason: enrollmentEndReasonEnum("end_reason"),
    currentStepId: uuid("current_step_id").references(() => sequenceSteps.id),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("enrollments_org_seq_idx").on(t.orgId, t.sequenceId),
    check(
      "enrollments_one_person",
      sql`(${t.leadId} is not null and ${t.contactId} is null) or (${t.leadId} is null and ${t.contactId} is not null)`,
    ),
    // A person can be in only one sequence at a time.
    uniqueIndex("enrollments_one_live_per_lead")
      .on(t.leadId)
      .where(sql`${t.state} in ('active', 'paused')`),
    uniqueIndex("enrollments_one_live_per_contact")
      .on(t.contactId)
      .where(sql`${t.state} in ('active', 'paused')`),
  ],
);

export const stepTasks = pgTable(
  "step_tasks",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => enrollments.id, { onDelete: "cascade" }),
    stepId: uuid("step_id")
      .notNull()
      .references(() => sequenceSteps.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    state: stepTaskStateEnum("state").notNull().default("open"),
    /** Calendar date in the organization's time zone. */
    dueOn: date("due_on").notNull(),
    /** The rep's edit for this one person; wins over the template. */
    overrideSubject: text("override_subject"),
    overrideBody: text("override_body"),
    /** What was actually used, saved when the task is completed. */
    finalSubject: text("final_subject"),
    finalBody: text("final_body"),
    note: text("note"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("step_tasks_due_idx").on(t.orgId, t.state, t.dueOn),
    uniqueIndex("step_tasks_enrollment_step_uq").on(t.enrollmentId, t.stepId),
    // Only one open task per enrollment, ever.
    uniqueIndex("step_tasks_one_open_uq")
      .on(t.enrollmentId)
      .where(sql`${t.state} = 'open'`),
  ],
);

// -------------------------------------------------- history and events

export const fieldHistory = pgTable(
  "field_history",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    recordType: text("record_type").notNull(),
    recordId: uuid("record_id").notNull(),
    action: historyActionEnum("action").notNull(),
    /** Null for create and delete entries. */
    field: text("field"),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    source: historySourceEnum("source").notNull().default("user"),
    userId: uuid("user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("field_history_record_idx").on(t.orgId, t.recordType, t.recordId, t.createdAt)],
);

export const events = pgTable(
  "events",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actorId: uuid("actor_id").references(() => users.id),
    leadId: uuid("lead_id"),
    contactId: uuid("contact_id"),
    sequenceId: uuid("sequence_id"),
    enrollmentId: uuid("enrollment_id"),
    stepId: uuid("step_id"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_org_type_idx").on(t.orgId, t.type, t.occurredAt)],
);
