import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, activities, contacts, events, leads } from "../../shared/schema";
import { recordLifecycle, recordUpdate } from "../audit/history";
import type { Actor } from "../auth/actor";
import { canCreate, PermissionError, requireRecord, scopeFor } from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError, ValidationError } from "../errors";
import { stopForPerson } from "../sequences/engine";
import { loadDefs } from "../fields/service";
import { defaultStatus, listStatusNames } from "../statuses/service";
import { AccountIndex, personMatches } from "./duplicates";
import { optionalUrl } from "./index";

/**
 * Lead conversion: a lead becomes a contact on an account.
 *
 * The contact takes the lead's details, owner and status. Converting means
 * something has happened (a meeting, a real conversation), so a sequence the
 * lead is in ends with the reason "converted". The lead's sequence history
 * stays with the lead and is shown on the account; the contact starts with
 * none. The lead row is kept, marked as converted and hidden from the Leads
 * list, so its history stays readable from the contact.
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
  /** The web domain the lead's email is at, unless it's a personal address (gmail.com…). */
  domain: string | null;
  /**
   * Other leads at the same domain that could be converted along with this
   * one, into the same account: not converted yet, changeable by the person
   * converting, and not already a contact.
   */
  sameDomain: {
    id: string;
    name: string;
    email: string;
    title: string | null;
    company: string | null;
  }[];
}

export interface ConvertResult {
  contactId: string;
  accountId: string;
  accountCreated: boolean;
  /** The lead was in a sequence, and converting ended it. */
  endedSequence: boolean;
  /** The other leads at the same domain that were converted too. */
  also: { converted: number; skipped: { id: string; reason: string }[] };
}

/** How many other leads at the same domain the dialog offers at most. */
export const SAME_DOMAIN_LIMIT = 200;

async function leadsAtDomain(db: Db, actor: Actor, domain: string, exceptId: string) {
  const scope = scopeFor(actor.permissions, "leads", "edit");
  if (scope === "none") return [];
  const rows = await db
    .select({
      id: leads.id,
      firstName: leads.firstName,
      lastName: leads.lastName,
      email: leads.email,
      title: leads.title,
      company: leads.company,
    })
    .from(leads)
    .where(
      and(
        eq(leads.orgId, actor.orgId),
        isNull(leads.deletedAt),
        isNull(leads.convertedAt),
        ne(leads.id, exceptId),
        sql`lower(split_part(${leads.email}, '@', 2)) = ${domain}`,
        scope === "own" ? eq(leads.ownerId, actor.userId) : undefined,
        // Someone who is already a contact can't be converted again.
        sql`not exists (select 1 from contacts c where c.org_id = ${actor.orgId}
          and c.deleted_at is null and lower(c.email) = lower(${leads.email}))`,
      ),
    )
    .orderBy(leads.lastName, leads.firstName)
    .limit(SAME_DOMAIN_LIMIT);
  return rows.map((r) => ({
    id: r.id,
    name: `${r.firstName} ${r.lastName}`,
    email: r.email,
    title: r.title,
    company: r.company,
  }));
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
    domain,
    sameDomain: domain ? await leadsAtDomain(db, actor, domain, lead.id) : [],
  };
}

export const convertInput = z
  .object({
    accountId: z.uuid().optional(),
    newAccount: z.object({ name: z.string().trim().min(1), website: optionalUrl }).optional(),
    /** Other leads at the same domain to convert into the same account. */
    alsoLeadIds: z.array(z.uuid()).max(SAME_DOMAIN_LIMIT).default([]),
  })
  .refine((v) => Boolean(v.accountId) !== Boolean(v.newAccount), {
    message: "Choose an existing account or name a new one",
  });

/**
 * Convert a lead, and any others at the same domain chosen with it. The first
 * lead is converted on its own; each of the others is then converted into the
 * same account on its own, so one that can't be (say, someone just converted
 * it) is reported and skipped without undoing the rest.
 */
export async function convertLead(
  db: Db,
  actor: Actor,
  leadId: string,
  raw: unknown,
): Promise<ConvertResult> {
  const input = convertInput.parse(raw);
  if (!canCreate(actor.permissions, "contacts")) throw new PermissionError("contacts.create");
  const first = await convertOne(db, actor, leadId, input);
  const also: ConvertResult["also"] = { converted: 0, skipped: [] };
  const others = [...new Set(input.alsoLeadIds)].filter((id) => id !== leadId);
  if (others.length > 0) {
    const domain = companyDomain(first.email);
    for (const id of others) {
      try {
        const lead = await loadLead(db, actor, id);
        if (!domain || companyDomain(lead.email) !== domain) {
          also.skipped.push({ id, reason: "Not at the same company" });
          continue;
        }
        await convertOne(db, actor, id, { accountId: first.accountId });
        also.converted += 1;
      } catch (e) {
        if (e instanceof ValidationError || e instanceof NotFoundError) {
          also.skipped.push({ id, reason: e.message });
        } else if (e instanceof PermissionError) {
          also.skipped.push({ id, reason: "Your role can't change this lead" });
        } else throw e;
      }
    }
  }
  const { email: _email, ...result } = first;
  return { ...result, also };
}

async function convertOne(
  db: Db,
  actor: Actor,
  leadId: string,
  input: { accountId?: string; newAccount?: { name: string; website?: string | null } },
) {
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

    // Custom fields carry over to a contact (or new account) field with the
    // same key and type; anything without a match stays on the lead's history.
    const carry = async (object: "contacts" | "accounts") => {
      const leadDefs = new Map(
        (await loadDefs(tx, actor.orgId, "leads")).map((d) => [d.key, d.type]),
      );
      const out: Record<string, unknown> = {};
      for (const d of await loadDefs(tx, actor.orgId, object)) {
        const value = (lead.custom as Record<string, unknown>)[d.key];
        if (value !== undefined && leadDefs.get(d.key) === d.type) out[d.key] = value;
      }
      return out;
    };

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
        .values({
          orgId: actor.orgId,
          ownerId: lead.ownerId,
          name,
          website: website ?? null,
          status: await defaultStatus(tx, actor.orgId, "accounts"),
          custom: await carry("accounts"),
        })
        .returning({ id: accounts.id });
      await recordLifecycle(tx, actor, "account", created.id, "create");
      accountId = created.id;
    }

    // Leads and contacts have separate status lists. The contact keeps the
    // lead's status when contacts have one of the same name, and otherwise
    // starts on the default contact status.
    const contactStatuses = await listStatusNames(tx, actor.orgId, "contacts");
    const status =
      contactStatuses.find((s) => s.toLowerCase() === lead.status.toLowerCase()) ??
      (await defaultStatus(tx, actor.orgId, "contacts"));

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
        status,
        custom: await carry("contacts"),
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

    const endedSequence = await stopForPerson(tx, actor, { leadId: lead.id }, "converted");
    // What was done while they were a lead now shows on the contact and its account.
    await tx
      .update(activities)
      .set({ leadId: null, contactId: contact.id, accountId })
      .where(and(eq(activities.orgId, actor.orgId), eq(activities.leadId, lead.id)));
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
      endedSequence,
      email: lead.email,
    };
  });
}
