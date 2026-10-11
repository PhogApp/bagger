import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { accounts, contacts, events, leads } from "../../shared/schema";
import { recordLifecycle, recordUpdate } from "../audit/history";
import type { Actor } from "../auth/actor";
import { canCreate, PermissionError, requireRecord } from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";
import { moveEnrollmentsToContact } from "../sequences/engine";
import { AccountIndex, personMatches } from "./duplicates";
import { optionalUrl } from "./index";

/**
 * Lead conversion: a lead becomes a contact on an account.
 *
 * The contact takes the lead's details, owner and status. The lead's
 * enrollments move to the contact, so a sequence in progress carries on from
 * the same step. The lead row is kept, marked as converted and hidden from
 * the Leads list, so its history stays readable from the contact.
 *
 * The person converting always chooses the account: an existing one, or a
 * new one. Bagger suggests accounts that match the lead's company name or
 * email domain but never attaches one on its own.
 */

/** Addresses at these domains say nothing about which company someone works for. */
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

function companyDomain(email: string): string | null {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return domain && !PERSONAL_EMAIL_DOMAINS.has(domain) ? domain : null;
}

async function loadLead(tx: Db, actor: Actor, leadId: string, lock = false) {
  const query = tx
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.orgId, actor.orgId), isNull(leads.deletedAt)));
  const [lead] = lock ? await query.for("update") : await query;
  if (!lead) throw new NotFoundError("lead");
  return lead;
}

export interface ConversionPreview {
  /** What to call a new account: the lead's company. */
  suggestedAccountName: string | null;
  suggestedWebsite: string | null;
  /** Existing accounts that look like this lead's company. */
  matches: { id: string; name: string }[];
  /** Set when this email already belongs to a contact; conversion is refused. */
  existingContact: string | null;
  canCreateAccount: boolean;
}

/** What the Convert dialog needs to show before anything is changed. */
export async function conversionPreview(
  db: Db,
  actor: Actor,
  leadId: string,
): Promise<ConversionPreview> {
  const lead = await loadLead(db, actor, leadId);
  requireRecord(actor.permissions, "leads", "view", lead, actor.userId);
  const domain = companyDomain(lead.email);
  const index = await AccountIndex.load(db, actor.orgId);
  const [existing] = await personMatches(db, actor.orgId, lead.email, ["contact"]);
  return {
    suggestedAccountName: lead.company,
    suggestedWebsite: domain,
    matches: index.findAll(lead.company, domain).map((a) => ({ id: a.id, name: a.name })),
    existingContact: existing?.label ?? null,
    canCreateAccount: canCreate(actor.permissions, "accounts"),
  };
}

export const convertInput = z
  .object({
    accountId: z.uuid().optional(),
    newAccount: z.object({ name: z.string().trim().min(1), website: optionalUrl }).optional(),
  })
  .refine((v) => Boolean(v.accountId) !== Boolean(v.newAccount), {
    message: "Choose an existing account or name a new one",
  });

export async function convertLead(
  db: Db,
  actor: Actor,
  leadId: string,
  raw: unknown,
): Promise<{ contactId: string; accountId: string; accountCreated: boolean; enrollments: number }> {
  const input = convertInput.parse(raw);
  if (!canCreate(actor.permissions, "contacts")) throw new PermissionError("contacts.create");

  return db.transaction(async (tx) => {
    const lead = await loadLead(tx, actor, leadId, true);
    requireRecord(actor.permissions, "leads", "edit", lead, actor.userId);
    if (lead.convertedAt) throw new ValidationError("This lead was already converted.");

    const [existing] = await personMatches(tx, actor.orgId, lead.email, ["contact"]);
    if (existing) {
      throw new ValidationError(
        `${lead.email} is already a contact (${existing.label}). Delete this lead instead.`,
      );
    }

    let accountId: string;
    if (input.accountId) {
      const [account] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.id, input.accountId),
            eq(accounts.orgId, actor.orgId),
            isNull(accounts.deletedAt),
          ),
        );
      if (!account) throw new ValidationError("Account not found");
      accountId = account.id;
    } else {
      if (!canCreate(actor.permissions, "accounts")) throw new PermissionError("accounts.create");
      const { name, website } = input.newAccount!;
      const clash = (await AccountIndex.load(tx, actor.orgId)).find(name, website);
      if (clash) {
        throw new ValidationError(
          `An account called "${clash.name}" already has that name or website. Choose it instead.`,
        );
      }
      const [created] = await tx
        .insert(accounts)
        .values({ orgId: actor.orgId, ownerId: lead.ownerId, name, website: website ?? null })
        .returning({ id: accounts.id });
      await recordLifecycle(tx, actor, "account", created.id, "create");
      accountId = created.id;
    }

    const [contact] = await tx
      .insert(contacts)
      .values({
        orgId: actor.orgId,
        ownerId: lead.ownerId,
        accountId,
        firstName: lead.firstName,
        lastName: lead.lastName,
        title: lead.title,
        email: lead.email,
        cellPhone: lead.cellPhone,
        directPhone: lead.directPhone,
        hqPhone: lead.hqPhone,
        linkedin: lead.linkedin,
        notes: lead.notes,
        status: lead.status,
      })
      .returning({ id: contacts.id });
    await recordLifecycle(tx, actor, "contact", contact.id, "create");

    const at = new Date();
    await tx
      .update(leads)
      .set({ convertedContactId: contact.id, convertedAt: at, updatedAt: at })
      .where(eq(leads.id, lead.id));
    await recordUpdate(tx, actor, "lead", lead.id, [
      { field: "convertedContactId", oldValue: null, newValue: contact.id },
    ]);

    const moved = await moveEnrollmentsToContact(tx, actor, lead.id, contact.id);
    await tx.insert(events).values({
      orgId: actor.orgId,
      type: "lead_converted",
      actorId: actor.userId,
      leadId: lead.id,
      contactId: contact.id,
      data: { accountId, accountCreated: !input.accountId },
      occurredAt: at,
    });

    return {
      contactId: contact.id,
      accountId,
      accountCreated: !input.accountId,
      enrollments: moved,
    };
  });
}
