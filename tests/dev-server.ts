/**
 * Local preview server for looking at the screens without Clerk.
 *
 *   npm run build && npx tsx tests/dev-server.ts
 *
 * It uses an in-memory database with sample data and trusts two request
 * headers to say who the user is. That is only safe on your own machine,
 * which is why this file lives under tests/ and is never part of the build
 * that Render runs. The production server ignores those headers.
 */
import path from "node:path";
import { resolveActor } from "../server/auth/actor";
import { createApp } from "../server/http/app";
import { accountService, contactService, leadService } from "../server/records";
import { addMember, createOrg, createTestDb } from "./helpers";

const db = await createTestDb();
const adminCtx = await createOrg(db);
const repCtx = await addMember(db, adminCtx.orgId, "rep", "Ray Rep");
const admin = (await resolveActor(db, adminCtx))!;
const rep = (await resolveActor(db, repCtx))!;

const phog = await accountService.create(db, admin, {
  name: "Phog, Inc.",
  website: "https://phog.example",
});
await accountService.create(db, admin, { name: "Test Company", status: "Customer" });
await contactService.create(db, admin, {
  firstName: "Dan",
  lastName: "Smith",
  title: "CEO",
  email: "dan@phog.example",
  accountId: phog.id,
  status: "Prospecting",
});
const people = [
  ["Jeremy", "Gonnon", "Director, Service Delivery", "Secured Retail Networks", ""],
  ["Preston", "Strait", "VP IT", "Secured Retail Networks", "9493906714"],
  ["Mikey", "Nichols", "Manager, Operations", "TerraMai", "5304929482"],
  ["Misty", "Russell", "Head of Accounting", "TerraMai", ""],
  ["MJ", "Rushford", "Manager, Accounting", "Connectronics", "5155093183"],
  ["Jill", "Rude", "CFO", "Redfield Energy", ""],
];
for (const [i, [firstName, lastName, title, company, cellPhone]] of people.entries()) {
  const lead = await leadService.create(db, i % 2 ? rep : admin, {
    firstName,
    lastName,
    title,
    company,
    cellPhone,
    email: `${firstName}.${lastName}@example.com`,
  });
  if (lastName === "Rude") {
    await leadService.update(db, rep, lead.id, { title: "Chief Financial Officer" });
    await leadService.update(db, admin, lead.id, { status: "Prospecting", ownerId: rep.userId });
  }
}

// PREVIEW_AS=rep shows the screens as a Rep instead of an Admin.
const viewer = process.env.PREVIEW_AS === "rep" ? repCtx : adminCtx;
const app = createApp(
  db,
  async (req) => {
    const userId = req.header("x-user");
    const orgId = req.header("x-org");
    return userId && orgId ? resolveActor(db, { userId, orgId }) : null;
  },
  {
    publicConfig: {
      devUser: viewer.userId,
      devOrg: viewer.orgId,
      devOrgName: "Sample Org",
      devUserName: viewer === repCtx ? "Ray Rep" : "Admin",
    },
    staticDir: path.resolve("dist/public"),
  },
);
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Preview at http://localhost:${port}`));
