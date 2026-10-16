import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { apiKeys, organizations, users } from "../../shared/schema";
import { resolveActor, type Actor } from "../auth/actor";
import { PRESET_ROLES, requireTool, type PermissionMap } from "../auth/permissions";
import type { Db } from "../db/types";
import { NotFoundError } from "../errors";

/**
 * API keys for Bagger's public API. An admin makes one per connected system
 * ("Zapier", "Our data warehouse"), read-only or read-and-write. The full key
 * is shown once; Bagger keeps only its SHA-256 hash and the visible prefix.
 * A key keeps working when the person who made it leaves (it then acts as the
 * organization's owner), and stops the moment it's revoked.
 */

const PREFIX = "bgr_";
const b62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const random62 = (n: number) => Array.from(randomBytes(n), (byte) => b62[byte % 62]).join("");
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

/** What a key may do: everything an Admin may do with records, or only look. */
const ADMIN = PRESET_ROLES.admin.permissions;
const KEY_TOOLS = ["sequences.enroll", "sequences.manage_others", "history.view"];
function permissionsFor(access: "read" | "read_write"): PermissionMap {
  const map: PermissionMap = {};
  for (const [name, value] of Object.entries(ADMIN)) {
    if (name.endsWith(".view")) map[name] = value;
    else if (access === "read_write" && /\.(create|edit|delete)$/.test(name)) map[name] = value;
  }
  for (const tool of KEY_TOOLS) {
    if (access === "read_write" || tool === "history.view") map[tool] = true;
  }
  return map;
}

function manage(actor: Actor) {
  requireTool(actor.permissions, "setup.api");
}

const createBody = z.object({
  name: z.string().trim().min(1, "Give the key a name").max(80),
  access: z.enum(["read", "read_write"]),
});

export async function createKey(db: Db, actor: Actor, raw: unknown) {
  manage(actor);
  const { name, access } = createBody.parse(raw);
  const prefix = `${PREFIX}${random62(10)}`;
  const key = `${prefix}_${random62(40)}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId: actor.orgId,
      name,
      access,
      prefix,
      secretHash: hash(key),
      createdBy: actor.userId,
    })
    .returning();
  // The only time the whole key leaves the server.
  return { id: row.id, name, access, prefix, key, createdAt: row.createdAt };
}

export async function listKeys(db: Db, actor: Actor) {
  manage(actor);
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      access: apiKeys.access,
      prefix: apiKeys.prefix,
      createdBy: users.name,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.createdBy))
    .where(eq(apiKeys.orgId, actor.orgId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function revokeKey(db: Db, actor: Actor, rawId: string) {
  manage(actor);
  const parsed = z.uuid().safeParse(rawId);
  if (!parsed.success) throw new NotFoundError("API key");
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(apiKeys.orgId, actor.orgId), eq(apiKeys.id, parsed.data), isNull(apiKeys.revokedAt)),
    )
    .returning({ id: apiKeys.id });
  if (!row) throw new NotFoundError("API key");
}

export interface KeyActor {
  key: { id: string; name: string; access: "read" | "read_write" };
  actor: Actor;
}

/**
 * The key in an `Authorization: Bearer bgr_…` header, and who it acts as.
 * Null for a missing, unknown or revoked key.
 */
export async function authenticateKey(
  db: Db,
  header: string | undefined,
): Promise<KeyActor | null> {
  const key = header?.match(/^Bearer\s+(bgr_[A-Za-z0-9]+_[A-Za-z0-9]+)\s*$/)?.[1];
  if (!key) return null;
  const prefix = key.slice(0, key.lastIndexOf("_"));
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix));
  if (!row || row.revokedAt) return null;
  const want = Buffer.from(row.secretHash, "hex");
  const got = Buffer.from(hash(key), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;

  // Acts as whoever made it, or the owner once they've left.
  let base = row.createdBy
    ? await resolveActor(db, { orgId: row.orgId, userId: row.createdBy })
    : null;
  if (!base) {
    const [org] = await db
      .select({ owner: organizations.ownerUserId })
      .from(organizations)
      .where(eq(organizations.id, row.orgId));
    base = org?.owner ? await resolveActor(db, { orgId: row.orgId, userId: org.owner }) : null;
  }
  if (!base) return null;

  // Note the use, at most once a minute.
  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(apiKeys.id, row.id),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, sql`now() - interval '1 minute'`)),
      ),
    );
  return {
    key: { id: row.id, name: row.name, access: row.access },
    actor: { ...base, permissions: permissionsFor(row.access), roleName: "API key" },
  };
}
