import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  contacts,
  enrollments,
  leads,
  opportunities,
  opportunityStageHistory,
  sequenceSteps,
  sequences,
  templateTypeEnum,
  templates,
} from "../../shared/schema";
import { ValidationError } from "../errors";
import { stopForPerson } from "../sequences/engine";
import { messageFor } from "../sequences/html";
import { accountMatches, personMatches } from "./duplicates";
import { customInput } from "../fields/service";
import { linkedinTooLong } from "../../shared/linkedin";
import { statusEffect } from "../statuses/service";
import { recordService } from "./service";

const text = z.string().trim().min(1);
const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();
/**
 * Web addresses as people type them. "www.example.com" is accepted and
 * stored as "https://www.example.com" so it works as a link.
 */
export const optionalUrl = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`))
  .nullable()
  .optional();
const email = z.email().trim().toLowerCase();
const ownerId = z.uuid().optional();

/** A status from the organization's own list; the service checks it is on the list. */
const status = z.string().trim().min(1).optional();
/** Statuses with these effects end whatever sequence a person is in. */
const STOPS = new Set(["ends_sequence", "do_not_contact"]);

const personFields = {
  firstName: text,
  lastName: text,
  title: optionalText,
  email,
  cellPhone: optionalText,
  directPhone: optionalText,
  hqPhone: optionalText,
  linkedin: optionalUrl,
  notes: optionalText,
  status,
  ownerId,
  custom: customInput,
};

export const leadInput = z.object({ ...personFields, company: optionalText });
export const contactInput = z.object({ ...personFields, accountId: z.uuid() });
export const accountInput = z.object({
  name: text,
  website: optionalUrl,
  linkedin: optionalUrl,
  hqPhone: optionalText,
  notes: optionalText,
  status,
  ownerId,
  custom: customInput,
});
/** Money as typed ("12,500", "$12500.50") or as a number; stored with two decimals. */
const optionalAmount = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    if (typeof v === "string" && v.trim() === "") return null;
    const amount = typeof v === "number" ? v : Number(v.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(amount) || amount < 0 || amount >= 1e12) {
      ctx.addIssue({ code: "custom", message: "Enter an amount such as 12500" });
      return z.NEVER;
    }
    return amount.toFixed(2);
  })
  .nullable()
  .optional();
const optionalDate = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v === null || (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))), {
    message: "Pick a valid date",
  })
  .nullable()
  .optional();
const optionalId = z
  .union([z.uuid(), z.literal("")])
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();

export const opportunityInput = z.object({
  name: text,
  accountId: z.uuid(),
  contactId: optionalId,
  amount: optionalAmount,
  closeDate: optionalDate,
  /** The pipeline stage. */
  status,
  notes: optionalText,
  ownerId,
  custom: customInput,
});
export const templateInput = z.object({
  name: text,
  type: z.enum(templateTypeEnum.enumValues).optional(),
  subject: optionalText,
  body: z.string().min(1),
  ownerId,
});
export const sequenceInput = z.object({
  name: text,
  description: optionalText,
  isActive: z.boolean().optional(),
  ownerId,
});

export const leadService = recordService<typeof leads.$inferSelect, typeof leadInput>({
  table: leads,
  object: "leads",
  recordType: "lead",
  statusObject: "leads",
  sortable: {
    name: sql`lower(${leads.lastName} || ' ' || ${leads.firstName})`,
    title: sql`lower(${leads.title})`,
    company: sql`lower(${leads.company})`,
    email: leads.email,
    status: leads.status,
    owner: sql`(select u.name from users u where u.id = ${leads.ownerId})`,
    createdAt: leads.createdAt,
    updatedAt: leads.updatedAt,
  },
  customObject: "leads",
  input: leadInput,
  search: [leads.firstName, leads.lastName, leads.email, leads.company, leads.cellPhone],
  orderBy: [leads.lastName, leads.firstName],
  // A converted lead lives on as its contact. The row stays for its history.
  hidden: isNull(leads.convertedAt),
  frozen: (lead) => (lead.convertedAt ? "This lead was converted to a contact." : null),
  duplicates: (tx, actor, values) =>
    personMatches(tx, actor.orgId, values.email, ["contact", "lead"]),
  afterUpdate: async (tx, actor, before, after) => {
    if (before.status === after.status) return;
    if (STOPS.has(await statusEffect(tx, actor.orgId, "leads", after.status))) {
      await stopForPerson(tx, actor, { leadId: after.id }, "status_change");
    }
  },
  afterDelete: async (tx, actor, row) => {
    await stopForPerson(tx, actor, { leadId: row.id }, "removed");
  },
});

export const accountService = recordService<typeof accounts.$inferSelect, typeof accountInput>({
  table: accounts,
  object: "accounts",
  recordType: "account",
  statusObject: "accounts",
  sortable: {
    name: sql`lower(${accounts.name})`,
    website: accounts.website,
    status: accounts.status,
    owner: sql`(select u.name from users u where u.id = ${accounts.ownerId})`,
    createdAt: accounts.createdAt,
    updatedAt: accounts.updatedAt,
  },
  customObject: "accounts",
  input: accountInput,
  search: [accounts.name, accounts.website],
  orderBy: [accounts.name],
  duplicates: (tx, actor, values) => accountMatches(tx, actor.orgId, values.name, values.website),
  afterDelete: async (tx, actor, row) => {
    const [opportunity] = await tx
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(and(eq(opportunities.accountId, row.id), isNull(opportunities.deletedAt)))
      .limit(1);
    if (opportunity) {
      throw new ValidationError("This account still has opportunities. Delete them first.");
    }
    const [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.accountId, row.id), isNull(contacts.deletedAt)))
      .limit(1);
    if (contact) {
      throw new ValidationError("This account still has contacts. Move or delete them first.");
    }
  },
});

export const contactService = recordService<typeof contacts.$inferSelect, typeof contactInput>({
  table: contacts,
  object: "contacts",
  recordType: "contact",
  statusObject: "contacts",
  sortable: {
    name: sql`lower(${contacts.lastName} || ' ' || ${contacts.firstName})`,
    title: sql`lower(${contacts.title})`,
    account: sql`(select lower(a.name) from accounts a where a.id = ${contacts.accountId})`,
    email: contacts.email,
    status: contacts.status,
    owner: sql`(select u.name from users u where u.id = ${contacts.ownerId})`,
    createdAt: contacts.createdAt,
    updatedAt: contacts.updatedAt,
  },
  customObject: "contacts",
  filters: { accountId: contacts.accountId },
  input: contactInput,
  search: [
    contacts.firstName,
    contacts.lastName,
    contacts.email,
    contacts.cellPhone,
    sql`(select a.name from accounts a where a.id = ${contacts.accountId})`,
  ],
  orderBy: [contacts.lastName, contacts.firstName],
  duplicates: (tx, actor, values) => personMatches(tx, actor.orgId, values.email, ["contact"]),
  validate: async (tx, actor, values) => {
    if (!values.accountId) return;
    const [account] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, values.accountId),
          eq(accounts.orgId, actor.orgId),
          isNull(accounts.deletedAt),
        ),
      );
    if (!account) throw new ValidationError("Account not found");
  },
  afterUpdate: async (tx, actor, before, after) => {
    if (before.status === after.status) return;
    if (STOPS.has(await statusEffect(tx, actor.orgId, "contacts", after.status))) {
      await stopForPerson(tx, actor, { contactId: after.id }, "status_change");
    }
  },
  afterDelete: async (tx, actor, row) => {
    await stopForPerson(tx, actor, { contactId: row.id }, "removed");
  },
});

/** True when the stage is one of the organization's won or lost stages. */
async function isClosedStage(tx: Parameters<typeof statusEffect>[0], orgId: string, stage: string) {
  const effect = await statusEffect(tx, orgId, "opportunities", stage);
  return effect === "won" || effect === "lost";
}

/** The main contact has to be someone at the opportunity's account. */
async function checkContactOnAccount(
  tx: Parameters<typeof statusEffect>[0],
  opportunity: { contactId: string | null; accountId: string },
) {
  if (!opportunity.contactId) return;
  const [contact] = await tx
    .select({ accountId: contacts.accountId })
    .from(contacts)
    .where(eq(contacts.id, opportunity.contactId));
  if (contact?.accountId !== opportunity.accountId) {
    throw new ValidationError("That contact belongs to a different account");
  }
}

export const opportunityService = recordService<
  typeof opportunities.$inferSelect,
  typeof opportunityInput
>({
  table: opportunities,
  object: "opportunities",
  recordType: "opportunity",
  statusObject: "opportunities",
  sortable: {
    name: sql`lower(${opportunities.name})`,
    account: sql`(select lower(a.name) from accounts a where a.id = ${opportunities.accountId})`,
    amount: opportunities.amount,
    closeDate: opportunities.closeDate,
    status: opportunities.status,
    owner: sql`(select u.name from users u where u.id = ${opportunities.ownerId})`,
    createdAt: opportunities.createdAt,
    updatedAt: opportunities.updatedAt,
  },
  customObject: "opportunities",
  filters: { accountId: opportunities.accountId },
  input: opportunityInput,
  search: [
    opportunities.name,
    sql`(select a.name from accounts a where a.id = ${opportunities.accountId})`,
  ],
  orderBy: [opportunities.closeDate, opportunities.name],
  validate: async (tx, actor, values) => {
    if (values.accountId) {
      const [account] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.id, values.accountId),
            eq(accounts.orgId, actor.orgId),
            isNull(accounts.deletedAt),
          ),
        );
      if (!account) throw new ValidationError("Account not found");
    }
    if (values.contactId) {
      const [contact] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.id, values.contactId),
            eq(contacts.orgId, actor.orgId),
            isNull(contacts.deletedAt),
          ),
        );
      if (!contact) throw new ValidationError("Contact not found");
    }
  },
  afterCreate: async (tx, actor, row) => {
    await checkContactOnAccount(tx, row);
    await tx.insert(opportunityStageHistory).values({
      orgId: actor.orgId,
      opportunityId: row.id,
      toStage: row.status,
      amount: row.amount,
      changedBy: actor.userId,
    });
    if (await isClosedStage(tx, actor.orgId, row.status)) {
      await tx.update(opportunities).set({ closedAt: new Date() }).where(eq(opportunities.id, row.id));
    }
  },
  afterUpdate: async (tx, actor, before, after) => {
    if (before.contactId !== after.contactId || before.accountId !== after.accountId) {
      await checkContactOnAccount(tx, after);
    }
    if (before.status === after.status) return;
    await tx.insert(opportunityStageHistory).values({
      orgId: actor.orgId,
      opportunityId: after.id,
      fromStage: before.status,
      toStage: after.status,
      amount: after.amount,
      changedBy: actor.userId,
    });
    // Closed while in a won or lost stage; reopened when moved back out.
    const closed = await isClosedStage(tx, actor.orgId, after.status);
    if (closed !== Boolean(before.closedAt)) {
      await tx
        .update(opportunities)
        .set({ closedAt: closed ? new Date() : null })
        .where(eq(opportunities.id, after.id));
    }
  },
});

export const templateService = recordService<typeof templates.$inferSelect, typeof templateInput>({
  table: templates,
  object: "templates",
  recordType: "template",
  input: templateInput,
  sortable: {
    name: sql`lower(${templates.name})`,
    subject: sql`lower(${templates.subject})`,
    type: templates.type,
    owner: sql`(select u.name from users u where u.id = ${templates.ownerId})`,
    createdAt: templates.createdAt,
    updatedAt: templates.updatedAt,
  },
  search: [templates.name, templates.subject, templates.body],
  orderBy: [templates.name],
  // Email messages are kept as clean HTML, LinkedIn ones as plain text.
  prepare: (values, before) => {
    const kind = (values.type ?? before?.type ?? "email") as "email" | "linkedin";
    if (typeof values.body === "string") {
      values.body = messageFor(kind, values.body);
      if (values.body === "") throw new ValidationError("body: Write the message");
    } else if (before && values.type && values.type !== before.type) {
      values.body = messageFor(kind, before.body);
    }
    // LinkedIn templates go into connection requests, which allow 300 characters.
    const tooLong =
      kind === "linkedin" && typeof values.body === "string" ? linkedinTooLong(values.body) : null;
    if (tooLong) throw new ValidationError(`body: ${tooLong}`);
  },
  // A step that uses a deleted template would have nothing to send.
  afterDelete: async (tx, _actor, row) => {
    const [use] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sequenceSteps)
      .innerJoin(sequences, eq(sequenceSteps.sequenceId, sequences.id))
      .where(
        and(
          eq(sequenceSteps.templateId, row.id),
          isNull(sequenceSteps.deletedAt),
          isNull(sequences.deletedAt),
        ),
      );
    if (use.n > 0) {
      throw new ValidationError(
        `This template is used by ${use.n} sequence step${use.n === 1 ? "" : "s"}. Change ${use.n === 1 ? "that step" : "those steps"} first.`,
      );
    }
  },
});

export const sequenceService = recordService<typeof sequences.$inferSelect, typeof sequenceInput>({
  table: sequences,
  object: "sequences",
  recordType: "sequence",
  input: sequenceInput,
  sortable: {
    name: sql`lower(${sequences.name})`,
    isActive: sequences.isActive,
    owner: sql`(select u.name from users u where u.id = ${sequences.ownerId})`,
    createdAt: sequences.createdAt,
    updatedAt: sequences.updatedAt,
  },
  search: [sequences.name, sequences.description],
  orderBy: [sequences.name],
  // People still working through it would be left with steps nobody can see.
  afterDelete: async (tx, _actor, row) => {
    const [running] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(enrollments)
      .where(
        and(eq(enrollments.sequenceId, row.id), inArray(enrollments.state, ["active", "paused"])),
      );
    if (running.n > 0) {
      throw new ValidationError(
        `${running.n} ${running.n === 1 ? "person is" : "people are"} still in this sequence. Remove them or let them finish first.`,
      );
    }
  },
});
