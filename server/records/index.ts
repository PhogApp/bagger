import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  accountStatusEnum,
  accounts,
  contacts,
  leads,
  personStatusEnum,
  sequences,
  templateTypeEnum,
  templates,
} from "../../shared/schema";
import { ValidationError } from "../errors";
import { stopForPerson } from "../sequences/engine";
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
const optionalUrl = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`))
  .nullable()
  .optional();
const email = z.email().trim().toLowerCase();
const ownerId = z.uuid().optional();

/** Statuses that end whatever sequence a person is in. */
const STOP_STATUSES = new Set(["Not Interested", "Do Not Contact"]);

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
  status: z.enum(personStatusEnum.enumValues).optional(),
  ownerId,
};

export const leadInput = z.object({ ...personFields, company: optionalText });
export const contactInput = z.object({ ...personFields, accountId: z.uuid() });
export const accountInput = z.object({
  name: text,
  website: optionalUrl,
  linkedin: optionalUrl,
  hqPhone: optionalText,
  notes: optionalText,
  status: z.enum(accountStatusEnum.enumValues).optional(),
  ownerId,
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
  input: leadInput,
  search: [leads.firstName, leads.lastName, leads.email, leads.company, leads.cellPhone],
  orderBy: [leads.lastName, leads.firstName],
  afterUpdate: async (tx, actor, before, after) => {
    if (before.status !== after.status && STOP_STATUSES.has(after.status)) {
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
  input: accountInput,
  search: [accounts.name, accounts.website],
  orderBy: [accounts.name],
  afterDelete: async (tx, actor, row) => {
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
  input: contactInput,
  search: [contacts.firstName, contacts.lastName, contacts.email, contacts.cellPhone],
  orderBy: [contacts.lastName, contacts.firstName],
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
    if (before.status !== after.status && STOP_STATUSES.has(after.status)) {
      await stopForPerson(tx, actor, { contactId: after.id }, "status_change");
    }
  },
  afterDelete: async (tx, actor, row) => {
    await stopForPerson(tx, actor, { contactId: row.id }, "removed");
  },
});

export const templateService = recordService<typeof templates.$inferSelect, typeof templateInput>({
  table: templates,
  object: "templates",
  recordType: "template",
  input: templateInput,
  search: [templates.name, templates.subject, templates.body],
  orderBy: [templates.name],
});

export const sequenceService = recordService<typeof sequences.$inferSelect, typeof sequenceInput>({
  table: sequences,
  object: "sequences",
  recordType: "sequence",
  input: sequenceInput,
  search: [sequences.name],
  orderBy: [sequences.name],
});
