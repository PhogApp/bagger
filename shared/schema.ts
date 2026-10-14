import { sql } from "drizzle-orm";
import type { CallOutcome } from "./calls";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
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
  /**
   * The one person answerable for the organization: billing, cancelling,
   * handing it on. Always an Admin. Set when the organization is created.
   */
  ownerUserId: uuid("owner_user_id"),
  /** Optional extra address for invoices and payment notices. */
  billingEmail: text("billing_email"),
  /** Stripe's customer for this organization, and the card it charges. */
  stripeCustomerId: text("stripe_customer_id"),
  cardBrand: text("card_brand"),
  cardLast4: text("card_last4"),
  cardExpires: text("card_expires"),
  /**
   * The first day that's paid for: the free week runs from the day the first
   * card is saved up to (not including) this day. Null until there's a card.
   */
  trialEndsOn: date("trial_ends_on", { mode: "string" }),
  /** The day of the first bill (the rest of the month the trial ended in). */
  firstBilledOn: date("first_billed_on", { mode: "string" }),
  /** The owner asked to cancel: access lasts through this day, then the account is cancelled. */
  cancelsOn: date("cancels_on", { mode: "string" }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  clerkUserId: text("clerk_user_id").unique(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  /** The user's own IANA time zone. Null until set; the org default applies. */
  timezone: text("timezone"),
  createdAt: createdAt(),
});

export const orgSettings = pgTable("org_settings", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  waitDayMode: waitDayModeEnum("wait_day_mode").notNull().default("business"),
  /** Default IANA time zone for users who have not chosen their own. */
  timezone: text("timezone").notNull().default("America/Chicago"),
  postalAddress: text("postal_address"),
  updatedAt: updatedAt(),
});

/**
 * The statuses each organization offers for its records. Records store the
 * status name; renaming an option renames it on every record that has it.
 * "opportunities" holds the pipeline stages.
 */
export const STATUS_OBJECTS = ["leads", "contacts", "accounts", "opportunities"] as const;
export type StatusObject = (typeof STATUS_OBJECTS)[number];
/**
 * What a status does beyond being a label.
 *   people:        "ends_sequence" stops the person's sequence when they get
 *                  this status; "do_not_contact" does that and also blocks
 *                  enrolling them.
 *   opportunities: "won" and "lost" mark the closed stages.
 */
export const STATUS_EFFECTS = ["none", "ends_sequence", "do_not_contact", "won", "lost"] as const;
export type StatusEffect = (typeof STATUS_EFFECTS)[number];
export const STATUS_COLORS = ["ocean", "teal", "sage", "mauve", "rose", "neutral"] as const;
export type StatusColor = (typeof STATUS_COLORS)[number];

export const statusOptions = pgTable(
  "status_options",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    object: text("object").$type<StatusObject>().notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    /** The status a new record gets when none is chosen. One per object. */
    isDefault: boolean("is_default").notNull().default(false),
    effect: text("effect").$type<StatusEffect>().notNull().default("none"),
    color: text("color").$type<StatusColor>().notNull().default("neutral"),
    /** Opportunities only: the chance of winning at this stage, 0 to 100. */
    probability: integer("probability"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("status_options_org_object_name_uq").on(t.orgId, t.object, sql`lower(${t.name})`),
    uniqueIndex("status_options_one_default_uq")
      .on(t.orgId, t.object)
      .where(sql`${t.isDefault}`),
  ],
);

/** The record types that can have custom fields. */
export const CUSTOM_FIELD_OBJECTS = ["leads", "contacts", "accounts", "opportunities"] as const;
export type CustomFieldObject = (typeof CUSTOM_FIELD_OBJECTS)[number];
export const CUSTOM_FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "currency",
  "date",
  "checkbox",
  "picklist",
  "multipicklist",
  "url",
  "email",
  "phone",
  "user",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/**
 * A field an organization adds to one record type. Values are stored on the
 * record under `custom[key]`. The key is fixed when the field is made, so
 * renaming the label never breaks templates, imports or reports.
 */
export const customFields = pgTable(
  "custom_fields",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    object: text("object").$type<CustomFieldObject>().notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: text("type").$type<CustomFieldType>().notNull(),
    /** Must be filled in on the Add form and the record page. Not enforced on import. */
    required: boolean("required").notNull().default(false),
    /** The choices, for picklists. */
    options: jsonb("options").$type<string[]>().notNull().default([]),
    /** Hidden everywhere; the values are kept and come back if it is restored. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("custom_fields_org_object_key_uq").on(t.orgId, t.object, t.key)],
);

export interface LayoutEntry {
  /** A built-in field name such as "website", or "custom.<key>". */
  field: string;
  width: "third" | "half" | "full";
  hidden?: boolean;
}

/** How one record type's page is laid out for an organization: order, width, hidden. */
export const fieldLayouts = pgTable(
  "field_layouts",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    object: text("object").$type<CustomFieldObject>().notNull(),
    entries: jsonb("entries").$type<LayoutEntry[]>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("field_layouts_org_object_uq").on(t.orgId, t.object)],
);

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
    endsOn: date("ends_on", { mode: "string" }),
    /** The day this seat started being paid for: joining, or being reinstated. */
    seatStartedOn: date("seat_started_on", { mode: "string" }).notNull().default(sql`current_date`),
    /** Who receives this person's records and sequences when the seat ends. */
    handToUserId: uuid("hand_to_user_id").references(() => users.id),
    /** Who removed them, and when the seat actually ended. */
    removedBy: uuid("removed_by").references(() => users.id),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId),
    index("memberships_ending_idx").on(t.orgId, t.status, t.endsOn),
  ],
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
    /** One of the organization's status options for this kind of record. */
    status: text("status").notNull(),
    convertedContactId: uuid("converted_contact_id"),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    /** Values of the organization's custom fields, by field key. */
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
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
    /** One of the organization's status options for accounts. */
    status: text("status").notNull(),
    /** Values of the organization's custom fields, by field key. */
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
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
    /** One of the organization's status options for this kind of record. */
    status: text("status").notNull(),
    /** Values of the organization's custom fields, by field key. */
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("contacts_org_idx").on(t.orgId),
    index("contacts_org_email_idx").on(t.orgId, t.email),
  ],
);

// ------------------------------------------------------------- pipeline

export const opportunities = pgTable(
  "opportunities",
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
    /** The main person on the deal, if one is named. */
    contactId: uuid("contact_id").references(() => contacts.id),
    name: text("name").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    /** Expected close date, a calendar date. */
    closeDate: date("close_date"),
    /** The pipeline stage: one of the organization's opportunity statuses. */
    status: text("status").notNull(),
    notes: text("notes"),
    /** Set while the stage is a won or lost one; null while the deal is open. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** Values of the organization's custom fields, by field key. */
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("opportunities_org_idx").on(t.orgId),
    index("opportunities_account_idx").on(t.accountId),
  ],
);

/** One row each time an opportunity enters a stage, for conversion and velocity reports. */
export const opportunityStageHistory = pgTable(
  "opportunity_stage_history",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    /** Null for the stage the opportunity was created in. */
    fromStage: text("from_stage"),
    toStage: text("to_stage").notNull(),
    /** The amount at the moment of the move. */
    amount: numeric("amount", { precision: 14, scale: 2 }),
    changedBy: uuid("changed_by").references(() => users.id),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("opportunity_stage_history_opp_idx").on(t.opportunityId, t.changedAt)],
);

// ----------------------------------------------------------- activities

export { CALL_OUTCOME_LABELS, CALL_OUTCOMES, type CallOutcome } from "./calls";

export const ACTIVITY_TYPES = ["call", "email", "linkedin", "meeting", "note"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
/** Open: still to do, with a due date. Completed: done, with the time it happened. */
export const ACTIVITY_STATUSES = ["open", "completed"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/**
 * Something a rep did: a call, an email, a LinkedIn touch, a meeting, or a
 * note. Logged by hand, or written by the sequence engine when a step is
 * completed. It hangs off a lead or a contact and, for a contact, its
 * account too, so the account's timeline shows everyone's activity.
 */
export const activities = pgTable(
  "activities",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Who did it. */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    type: text("type").$type<ActivityType>().notNull(),
    subject: text("subject"),
    body: text("body"),
    status: text("status").$type<ActivityStatus>().notNull().default("completed"),
    /** Open activities: the calendar day it is due, in the owner's time zone. */
    dueOn: date("due_on", { mode: "string" }),
    /** When it happened. Empty while the activity is open. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow(),
    leadId: uuid("lead_id").references(() => leads.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    accountId: uuid("account_id").references(() => accounts.id),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id),
    /** Set when the sequence engine wrote it for a completed step. */
    stepTaskId: uuid("step_task_id").references(() => stepTasks.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("activities_org_time_idx").on(t.orgId, t.occurredAt),
    index("activities_open_idx").on(t.orgId, t.ownerId, t.status, t.dueOn),
    index("activities_lead_idx").on(t.leadId),
    index("activities_contact_idx").on(t.contactId),
    index("activities_account_idx").on(t.accountId),
    index("activities_opportunity_idx").on(t.opportunityId),
    check(
      "activities_about_someone",
      sql`${t.leadId} is not null or ${t.contactId} is not null or ${t.accountId} is not null or ${t.opportunityId} is not null`,
    ),
    check(
      "activities_status_dates",
      sql`(${t.status} = 'open' and ${t.dueOn} is not null and ${t.occurredAt} is null) or (${t.status} = 'completed' and ${t.occurredAt} is not null)`,
    ),
  ],
);

// -------------------------------------------------------------- reports

/** A report someone built and saved: what it shows is in `definition`. */
export const savedReports = pgTable(
  "saved_reports",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    /** Visible to everyone in the organization, not just its owner. */
    shared: boolean("shared").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("saved_reports_org_idx").on(t.orgId)],
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
    /** Calendar date in the task owner's time zone. */
    dueOn: date("due_on").notNull(),
    /** The rep's edit for this one person; wins over the template. */
    overrideSubject: text("override_subject"),
    overrideBody: text("override_body"),
    /** What was actually used, saved when the task is completed. */
    finalSubject: text("final_subject"),
    finalBody: text("final_body"),
    /** Phone Call steps: how the call went, chosen by the rep on completing. */
    callOutcome: text("call_outcome").$type<CallOutcome>(),
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

// --------------------------------------------------------------- billing

/**
 * One bill per organization per month, made on the 1st for the month ahead:
 * full seats plus seats added during the month before, prorated by day.
 * `lines` keeps exactly what was charged. Collected through Stripe.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The month paid for, "2026-11". */
    period: text("period").notNull(),
    status: text("status").$type<"open" | "paid" | "failed" | "void">().notNull().default("open"),
    amountCents: integer("amount_cents").notNull(),
    lines: jsonb("lines")
      .$type<{ description: string; amountCents: number; seats?: number }[]>()
      .notNull(),
    stripeInvoiceId: text("stripe_invoice_id"),
    hostedUrl: text("hosted_url"),
    pdfUrl: text("pdf_url"),
    failureMessage: text("failure_message"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invoices_org_period_uq").on(t.orgId, t.period),
    index("invoices_stripe_idx").on(t.stripeInvoiceId),
  ],
);

// ----------------------------------------------------------------- staff

/**
 * What Bagger staff did in the staff console, such as deleting an
 * organization's data. Deliberately not tied to an organization, so the record
 * outlives the organization it describes.
 */
export const staffActions = pgTable(
  "staff_actions",
  {
    id: id(),
    staffEmail: text("staff_email").notNull(),
    action: text("action").notNull(),
    orgId: uuid("org_id"),
    orgName: text("org_name"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("staff_actions_created_idx").on(t.createdAt)],
);
