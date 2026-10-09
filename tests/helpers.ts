import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../shared/schema";
import type { Ctx, Db } from "../server/db/types";
import { provisionOrganization } from "../server/orgs/provision";

/** A fresh in-memory Postgres with the real migrations applied. */
export async function createTestDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: "./migrations" });
  return db as unknown as Db;
}

let counter = 0;

export async function createOrg(
  db: Db,
  options: { waitDayMode?: "business" | "calendar" } = {},
): Promise<Ctx> {
  counter++;
  const { orgId, adminUserId } = await provisionOrganization(db, {
    name: `Org ${counter}`,
    admin: { email: `admin${counter}@example.com`, name: "Admin" },
  });
  if (options.waitDayMode) {
    await db
      .update(schema.orgSettings)
      .set({ waitDayMode: options.waitDayMode })
      .where(eq(schema.orgSettings.orgId, orgId));
  }
  return { orgId, userId: adminUserId };
}

export async function createUser(db: Db, name: string): Promise<string> {
  counter++;
  const [user] = await db
    .insert(schema.users)
    .values({ email: `user${counter}@example.com`, name })
    .returning();
  return user.id;
}

export async function createLead(
  db: Db,
  ctx: Ctx,
  overrides: Partial<typeof schema.leads.$inferInsert> = {},
) {
  counter++;
  const [lead] = await db
    .insert(schema.leads)
    .values({
      orgId: ctx.orgId,
      ownerId: ctx.userId,
      firstName: "Jill",
      lastName: "Rude",
      email: `jill${counter}@redfield.example`,
      company: "Redfield Energy",
      ...overrides,
    })
    .returning();
  return lead;
}

export async function createContact(db: Db, ctx: Ctx, accountName = "Phog, Inc.") {
  counter++;
  const [account] = await db
    .insert(schema.accounts)
    .values({ orgId: ctx.orgId, ownerId: ctx.userId, name: accountName })
    .returning();
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      orgId: ctx.orgId,
      ownerId: ctx.userId,
      accountId: account.id,
      firstName: "Dan",
      lastName: "Smith",
      email: `dan${counter}@phog.example`,
    })
    .returning();
  return contact;
}

export interface StepSpec {
  type?: (typeof schema.stepTypeEnum.enumValues)[number];
  title?: string;
  waitDays: number;
  templateId?: string;
  subject?: string;
  body?: string;
}

export async function createSequence(db: Db, ctx: Ctx, steps: StepSpec[]) {
  const [sequence] = await db
    .insert(schema.sequences)
    .values({ orgId: ctx.orgId, ownerId: ctx.userId, name: "Outbound" })
    .returning();
  const created = [];
  for (const [i, s] of steps.entries()) {
    const [step] = await db
      .insert(schema.sequenceSteps)
      .values({
        orgId: ctx.orgId,
        sequenceId: sequence.id,
        position: i + 1,
        type: s.type ?? "email",
        title: s.title ?? `Step ${i + 1}`,
        waitDays: s.waitDays,
        templateId: s.templateId,
        subject: s.subject,
        body: s.body,
      })
      .returning();
    created.push(step);
  }
  return { sequence, steps: created };
}

/** 10:00 in Chicago on the given date. */
export const at = (day: string) => new Date(`${day}T15:00:00Z`);

/** Add a user to an organization with one of the preset roles. */
export async function addMember(
  db: Db,
  orgId: string,
  preset: "admin" | "manager" | "rep" | "read_only",
  name: string = preset,
): Promise<Ctx> {
  const userId = await createUser(db, name);
  const roles = await db.select().from(schema.roles).where(eq(schema.roles.orgId, orgId));
  const role = roles.find((r) => r.presetKey === preset);
  if (!role) throw new Error(`preset role ${preset} missing`);
  await db.insert(schema.memberships).values({ orgId, userId, roleId: role.id });
  return { orgId, userId };
}
