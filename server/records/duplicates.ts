import { and, eq, isNull } from "drizzle-orm";
import { accounts, contacts, leads } from "../../shared/schema";
import type { Db } from "../db/types";
import type { DuplicateMatch } from "../errors";

/**
 * What counts as "already in Bagger", in one place:
 *   - a person: a lead or a contact with the same email address. A lead that
 *     was converted no longer counts; the contact it became does.
 *   - an account: the same name (ignoring capitals and extra spaces) or the
 *     same website, compared by domain so "https://www.acme.com/about"
 *     matches "acme.com".
 */

/** "https://www.Acme.com/about" -> "acme.com". Null when there is nothing usable. */
export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const host = url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "");
  return host === "" ? null : host;
}

export const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

export interface AccountRef {
  id: string;
  ownerId: string;
  name: string;
}

/** Every live account in the organization, findable by name or by website domain. */
export class AccountIndex {
  private byName = new Map<string, AccountRef>();
  private byDomain = new Map<string, AccountRef>();

  static async load(tx: Db, orgId: string): Promise<AccountIndex> {
    const index = new AccountIndex();
    const rows = await tx
      .select({
        id: accounts.id,
        ownerId: accounts.ownerId,
        name: accounts.name,
        website: accounts.website,
      })
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), isNull(accounts.deletedAt)));
    for (const row of rows) index.add(row, row.website);
    return index;
  }

  add(ref: AccountRef, website: string | null | undefined) {
    const key = nameKey(ref.name);
    if (!this.byName.has(key)) this.byName.set(key, ref);
    const domain = domainOf(website);
    if (domain && !this.byDomain.has(domain)) this.byDomain.set(domain, ref);
  }

  /** The account with this name and the account with this website, when they differ. */
  findAll(name: string | null | undefined, website: string | null | undefined): AccountRef[] {
    const domain = domainOf(website);
    const hits = [
      name ? this.byName.get(nameKey(name)) : undefined,
      domain ? this.byDomain.get(domain) : undefined,
    ].filter((ref): ref is AccountRef => Boolean(ref));
    return hits.filter((ref, i) => hits.findIndex((h) => h.id === ref.id) === i);
  }

  find(name: string | null | undefined, website: string | null | undefined): AccountRef | undefined {
    const domain = domainOf(website);
    return (
      (name ? this.byName.get(nameKey(name)) : undefined) ??
      (domain ? this.byDomain.get(domain) : undefined)
    );
  }
}

/** Leads and contacts with this email address. */
export async function personMatches(
  tx: Db,
  orgId: string,
  email: string,
  among: ("lead" | "contact")[],
): Promise<DuplicateMatch[]> {
  const address = email.trim().toLowerCase();
  const matches: DuplicateMatch[] = [];
  if (among.includes("contact")) {
    const rows = await tx
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        account: accounts.name,
      })
      .from(contacts)
      .innerJoin(accounts, eq(contacts.accountId, accounts.id))
      .where(and(eq(contacts.orgId, orgId), isNull(contacts.deletedAt), eq(contacts.email, address)));
    for (const r of rows) {
      matches.push({ type: "contact", id: r.id, label: `${r.firstName} ${r.lastName}, ${r.account}` });
    }
  }
  if (among.includes("lead")) {
    const rows = await tx
      .select({
        id: leads.id,
        firstName: leads.firstName,
        lastName: leads.lastName,
        company: leads.company,
      })
      .from(leads)
      .where(
        and(
          eq(leads.orgId, orgId),
          isNull(leads.deletedAt),
          isNull(leads.convertedAt),
          eq(leads.email, address),
        ),
      );
    for (const r of rows) {
      const name = `${r.firstName} ${r.lastName}`;
      matches.push({ type: "lead", id: r.id, label: r.company ? `${name}, ${r.company}` : name });
    }
  }
  return matches;
}

/** The account with this name or website, if there is one. */
export async function accountMatches(
  tx: Db,
  orgId: string,
  name: string | null | undefined,
  website: string | null | undefined,
): Promise<DuplicateMatch[]> {
  const found = (await AccountIndex.load(tx, orgId)).find(name, website);
  return found ? [{ type: "account", id: found.id, label: found.name }] : [];
}
