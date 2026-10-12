import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { accounts } from "../../shared/schema";
import type { Actor } from "../auth/actor";
import { scopeFor, type ObjectName } from "../auth/permissions";
import type { Db } from "../db/types";
import { accountService, contactService, leadService, opportunityService } from "../records";

/**
 * The search box at the top of every page: the first few leads, contacts,
 * accounts and opportunities that match, with how many match in all. Each
 * record type follows the person's view rights and its list's own search.
 */

const searchQuery = z.object({
  q: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export interface SearchHit {
  id: string;
  title: string;
  detail: string | null;
}
export interface SearchGroup {
  object: "leads" | "contacts" | "accounts" | "opportunities";
  total: number;
  hits: SearchHit[];
}

const join = (...parts: (string | null | undefined)[]) =>
  parts.filter((p) => p && p.trim()).join(" · ") || null;
const person = (r: { firstName: string | null; lastName: string | null }) =>
  [r.firstName, r.lastName].filter(Boolean).join(" ") || "(no name)";
const money = (amount: string | null) =>
  amount === null
    ? null
    : Number(amount).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });

export async function globalSearch(db: Db, actor: Actor, raw: unknown): Promise<SearchGroup[]> {
  const { q, limit } = searchQuery.parse(raw);
  if (q.length < 2) return [];
  const can = (object: ObjectName) => scopeFor(actor.permissions, object, "view") !== "none";
  const options = { q, limit };
  const groups: SearchGroup[] = [];

  // Account names for the contacts and opportunities found, looked up once.
  const accountNames = async (ids: string[]) => {
    if (ids.length === 0) return new Map<string, string>();
    const rows = await db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.orgId, actor.orgId), inArray(accounts.id, ids)));
    return new Map(rows.map((r) => [r.id, r.name]));
  };

  if (can("leads")) {
    const [rows, total] = await Promise.all([
      leadService.list(db, actor, options),
      leadService.count(db, actor, options),
    ]);
    groups.push({
      object: "leads",
      total,
      hits: rows.map((r) => ({ id: r.id, title: person(r), detail: join(r.company, r.email) })),
    });
  }
  if (can("contacts")) {
    const [rows, total] = await Promise.all([
      contactService.list(db, actor, options),
      contactService.count(db, actor, options),
    ]);
    const names = await accountNames(rows.map((r) => r.accountId));
    groups.push({
      object: "contacts",
      total,
      hits: rows.map((r) => ({
        id: r.id,
        title: person(r),
        detail: join(names.get(r.accountId), r.email),
      })),
    });
  }
  if (can("accounts")) {
    const [rows, total] = await Promise.all([
      accountService.list(db, actor, options),
      accountService.count(db, actor, options),
    ]);
    groups.push({
      object: "accounts",
      total,
      hits: rows.map((r) => ({ id: r.id, title: r.name, detail: join(r.website, r.status) })),
    });
  }
  if (can("opportunities")) {
    const [rows, total] = await Promise.all([
      opportunityService.list(db, actor, options),
      opportunityService.count(db, actor, options),
    ]);
    const names = await accountNames(rows.map((r) => r.accountId));
    groups.push({
      object: "opportunities",
      total,
      hits: rows.map((r) => ({
        id: r.id,
        title: r.name,
        detail: join(names.get(r.accountId), r.status, money(r.amount)),
      })),
    });
  }
  return groups;
}
