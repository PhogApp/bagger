import { eq } from "drizzle-orm";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { resolveActor } from "../server/auth/actor";
import type { Ctx, Db } from "../server/db/types";
import { createApp } from "../server/http/app";
import * as s from "../shared/schema";
import { addMember, createOrg, createTestDb } from "./helpers";

let db: Db;
let app: ReturnType<typeof createApp>;
let admin: Ctx;
let manager: Ctx;
let rep: Ctx;
let rep2: Ctx;
let viewer: Ctx;
let outsider: Ctx; // admin of a different organization

beforeAll(async () => {
  db = await createTestDb();
  // Stand-in for Clerk: the test says who it is in two headers.
  app = createApp(db, async (req) => {
    const userId = req.header("x-user");
    const orgId = req.header("x-org");
    return userId && orgId ? resolveActor(db, { userId, orgId }) : null;
  });
  // Calendar-day mode, so "enroll now, see it in the queue now" holds on every
  // day of the week. In business-day mode a step enrolled on a Saturday is due
  // Monday, which made these tests fail when run on a weekend. That weekend
  // rule has its own test below, with the clock pinned.
  admin = await createOrg(db, { waitDayMode: "calendar" });
  manager = await addMember(db, admin.orgId, "manager", "Mia Manager");
  rep = await addMember(db, admin.orgId, "rep", "Ray Rep");
  rep2 = await addMember(db, admin.orgId, "rep", "Rita Rep");
  viewer = await addMember(db, admin.orgId, "read_only", "Vic Viewer");
  outsider = await createOrg(db);
});

const as = (who: Ctx) => ({
  get: (url: string) => request(app).get(url).set("x-user", who.userId).set("x-org", who.orgId),
  post: (url: string, body?: object) =>
    request(app).post(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
  patch: (url: string, body: object) =>
    request(app).patch(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
  put: (url: string, body: object) =>
    request(app).put(url).set("x-user", who.userId).set("x-org", who.orgId).send(body),
  del: (url: string) =>
    request(app).delete(url).set("x-user", who.userId).set("x-org", who.orgId),
});

let n = 0;
const newLead = (extra: object = {}) => ({
  firstName: "Jill",
  lastName: `Rude${++n}`,
  email: `Jill${n}@Redfield.example`,
  company: "Redfield Energy",
  ...extra,
});

describe("signing in", () => {
  it("rejects requests with no identity", async () => {
    expect((await request(app).get("/api/leads")).status).toBe(401);
  });
  it("rejects a user who is not a member of the organization they name", async () => {
    const res = await request(app)
      .get("/api/leads")
      .set("x-user", outsider.userId)
      .set("x-org", admin.orgId);
    expect(res.status).toBe(401);
  });
  it("tells the app who the user is and what they may do", async () => {
    const res = await as(rep).get("/api/me");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("Rep");
    expect(res.body.permissions["leads.delete"]).toBe("none");
    expect(res.body.user.name).toBe("Ray Rep");
  });
});

describe("leads", () => {
  it("creates a lead owned by the creator, with a tidy email", async () => {
    const res = await as(rep).post("/api/leads", newLead({ title: "  CFO " }));
    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe(rep.userId);
    expect(res.body.email).toMatch(/^jill\d+@redfield\.example$/);
    expect(res.body.title).toBe("CFO");
    expect(res.body.status).toBe("New");
  });

  it("rejects bad input with a 400", async () => {
    const res = await as(rep).post("/api/leads", { firstName: "", email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("lets a rep edit another rep's lead and records who changed what", async () => {
    const lead = (await as(rep).post("/api/leads", newLead({ title: "CFO" }))).body;
    const res = await as(rep2).patch(`/api/leads/${lead.id}`, { title: "CEO", notes: "Promoted" });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("CEO");

    const history = (await as(rep).get(`/api/history/lead/${lead.id}`)).body;
    const title = history.find((h: { field: string }) => h.field === "title");
    expect(title).toMatchObject({
      action: "update",
      oldValue: "CFO",
      newValue: "CEO",
      userId: rep2.userId,
      userName: "Rita Rep",
    });
    expect(title.at).toBeTruthy();
    expect(history.some((h: { action: string }) => h.action === "create")).toBe(true);
  });

  it("writes no history when nothing actually changed", async () => {
    const lead = (await as(rep).post("/api/leads", newLead({ title: "CFO" }))).body;
    await as(rep).patch(`/api/leads/${lead.id}`, { title: "CFO" });
    const history = (await as(rep).get(`/api/history/lead/${lead.id}`)).body;
    expect(history.filter((h: { action: string }) => h.action === "update")).toHaveLength(0);
  });

  it("stops a rep deleting, lets a manager, and keeps the history afterwards", async () => {
    const lead = (await as(rep).post("/api/leads", newLead())).body;
    expect((await as(rep).del(`/api/leads/${lead.id}`)).status).toBe(403);
    expect((await as(manager).del(`/api/leads/${lead.id}`)).status).toBe(204);
    expect((await as(rep).get(`/api/leads/${lead.id}`)).status).toBe(404);
    const history = (await as(manager).get(`/api/history/lead/${lead.id}`)).body;
    expect(history.some((h: { action: string }) => h.action === "delete")).toBe(true);
  });

  it("keeps a read-only user from creating or editing", async () => {
    const lead = (await as(rep).post("/api/leads", newLead())).body;
    expect((await as(viewer).post("/api/leads", newLead())).status).toBe(403);
    expect((await as(viewer).patch(`/api/leads/${lead.id}`, { title: "X" })).status).toBe(403);
    expect((await as(viewer).get(`/api/leads/${lead.id}`)).status).toBe(200);
  });

  it("searches by name, company, or email", async () => {
    await as(rep).post("/api/leads", newLead({ lastName: "Zebrowski", company: "Quartzite Co" }));
    const byName = await as(rep2).get("/api/leads?q=zebrow");
    expect(byName.body.map((l: { lastName: string }) => l.lastName)).toEqual(["Zebrowski"]);
    const byCompany = await as(rep2).get("/api/leads?q=quartzite");
    expect(byCompany.body).toHaveLength(1);
    expect((await as(rep2).get("/api/leads?q=100%25")).body).toHaveLength(0);
  });

  it("refuses an owner from outside the organization", async () => {
    const res = await as(rep).post("/api/leads", newLead({ ownerId: outsider.userId }));
    expect(res.status).toBe(400);
  });
});

describe("accounts and contacts", () => {
  it("requires a contact to belong to an account in the same organization", async () => {
    const account = (await as(rep).post("/api/accounts", { name: "Phog, Inc." })).body;
    const base = { firstName: "Dan", lastName: "Smith", email: "dan@phog.example" };
    expect((await as(rep).post("/api/contacts", base)).status).toBe(400);
    const foreign = (await as(outsider).post("/api/accounts", { name: "Elsewhere" })).body;
    const cross = await as(rep).post("/api/contacts", { ...base, accountId: foreign.id });
    expect(cross.status).toBe(400);
    const ok = await as(rep).post("/api/contacts", { ...base, accountId: account.id });
    expect(ok.status).toBe(201);
  });

  it("accepts a web address typed without https://", async () => {
    const account = await as(rep).post("/api/accounts", {
      name: "Dan's Auto",
      website: "www.dansauto.com",
      linkedin: "linkedin.com/company/dans-auto",
    });
    expect(account.status).toBe(201);
    expect(account.body.website).toBe("https://www.dansauto.com");
    expect(account.body.linkedin).toBe("https://linkedin.com/company/dans-auto");

    const kept = await as(rep).patch(`/api/accounts/${account.body.id}`, {
      website: "http://dansauto.com",
    });
    expect(kept.body.website).toBe("http://dansauto.com");
    const cleared = await as(rep).patch(`/api/accounts/${account.body.id}`, { website: "" });
    expect(cleared.body.website).toBeNull();
  });

  it("will not delete an account that still has contacts", async () => {
    const account = (await as(manager).post("/api/accounts", { name: "Has Contacts" })).body;
    await as(manager).post("/api/contacts", {
      firstName: "A",
      lastName: "B",
      email: "ab@example.com",
      accountId: account.id,
    });
    expect((await as(manager).del(`/api/accounts/${account.id}`)).status).toBe(400);
    expect((await as(manager).get(`/api/accounts/${account.id}`)).status).toBe(200);
  });
});

describe("organizations are isolated over the API", () => {
  it("hides one organization's records from another", async () => {
    const lead = (await as(rep).post("/api/leads", newLead({ lastName: "Private" }))).body;
    expect((await as(outsider).get(`/api/leads/${lead.id}`)).status).toBe(404);
    expect((await as(outsider).patch(`/api/leads/${lead.id}`, { title: "x" })).status).toBe(404);
    expect((await as(outsider).del(`/api/leads/${lead.id}`)).status).toBe(404);
    expect((await as(outsider).get("/api/leads?q=Private")).body).toHaveLength(0);
    expect((await as(outsider).get(`/api/history/lead/${lead.id}`)).body).toHaveLength(0);
    expect((await as(outsider).get("/api/users")).body).toHaveLength(1);
  });
});

describe("building and running a sequence", () => {
  it("runs end to end: template, steps, enroll, edit, complete, reply", async () => {
    const template = (
      await as(rep).post("/api/templates", {
        name: "Intro",
        type: "email",
        subject: "Hello {firstName}",
        body: "Thought of {company}.",
      })
    ).body;
    const sequence = (await as(rep).post("/api/sequences", { name: "Outbound V1" })).body;

    const s1 = await as(rep).post(`/api/sequences/${sequence.id}/steps`, {
      type: "email",
      title: "Intro email",
      templateId: template.id,
    });
    expect(s1.status).toBe(201);
    expect(s1.body.position).toBe(1);
    expect(s1.body.waitDays).toBe(0);
    const s2 = (
      await as(rep).post(`/api/sequences/${sequence.id}/steps`, {
        type: "phone_call",
        title: "Call",
        waitDays: 2,
        callScript: "Ask about month-end close",
      })
    ).body;
    expect(s2.position).toBe(2);

    // A LinkedIn step cannot use an email template.
    const wrong = await as(rep).post(`/api/sequences/${sequence.id}/steps`, {
      type: "linkedin_message",
      title: "LinkedIn",
      templateId: template.id,
    });
    expect(wrong.status).toBe(400);

    const lead = (await as(rep).post("/api/leads", newLead({ firstName: "Jill" }))).body;
    const enrolled = await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, {
      leadId: lead.id,
    });
    expect(enrolled.status).toBe(201);
    const again = await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, {
      leadId: lead.id,
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_enrolled");

    // The rep's queue shows the email with fields filled in.
    const queue = (await as(rep).get("/api/tasks/due")).body;
    const task = queue.find((t: { person: { leadId: string } }) => t.person.leadId === lead.id);
    expect(task.content).toMatchObject({
      subject: "Hello Jill",
      body: "Thought of Redfield Energy.",
      edited: false,
    });

    // Editing the template updates the open task.
    await as(rep).patch(`/api/templates/${template.id}`, { body: "New body for {company}." });
    expect((await as(rep).get(`/api/tasks/${task.taskId}`)).body.content.body).toBe(
      "New body for Redfield Energy.",
    );

    // The rep personalizes this one message before sending.
    const edited = await as(rep).put(`/api/tasks/${task.taskId}/message`, {
      body: "Saw your note about the audit, {firstName}.",
    });
    expect(edited.body.content.body).toBe("Saw your note about the audit, Jill.");

    const done = await as(rep).post(`/api/tasks/${task.taskId}/complete`, { note: "Sent" });
    expect(done.status).toBe(200);
    expect(done.body.nextTask.stepId).toBe(s2.id);

    const [saved] = await db.select().from(s.stepTasks).where(eq(s.stepTasks.id, task.taskId));
    expect(saved.finalBody).toBe("Saw your note about the audit, Jill.");

    // The call is not due yet, so it is not in the queue.
    const later = (await as(rep).get("/api/tasks/due")).body;
    expect(later.some((t: { taskId: string }) => t.taskId === done.body.nextTask.id)).toBe(false);

    // The lead replies; the rep logs it and the sequence ends.
    const list = (await as(rep).get(`/api/sequences/${sequence.id}/enrollments`)).body;
    expect(list[0]).toMatchObject({ state: "active", leadLastName: lead.lastName });
    const stopped = await as(rep).post(`/api/enrollments/${list[0].id}/stop`, {
      reason: "replied",
    });
    expect(stopped.status).toBe(204);
    const after = (await as(rep).get(`/api/sequences/${sequence.id}/enrollments`)).body;
    expect(after[0]).toMatchObject({ state: "ended", endReason: "replied", nextDueOn: null });
  });

  it("ends the sequence when a person is marked Not Interested", async () => {
    const sequence = (await as(rep).post("/api/sequences", { name: "Status stop" })).body;
    await as(rep).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });
    const lead = (await as(rep).post("/api/leads", newLead())).body;
    await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: lead.id });
    await as(rep).patch(`/api/leads/${lead.id}`, { status: "Not Interested" });
    const list = (await as(rep).get(`/api/sequences/${sequence.id}/enrollments`)).body;
    expect(list[0]).toMatchObject({ state: "ended", endReason: "status_change" });
  });

  it("reorders steps and moves people on when a step is deleted", async () => {
    const sequence = (await as(rep).post("/api/sequences", { name: "Reorder" })).body;
    const ids: string[] = [];
    for (const title of ["A", "B", "C"]) {
      const step = await as(rep).post(`/api/sequences/${sequence.id}/steps`, {
        type: "email",
        title,
      });
      ids.push(step.body.id);
    }
    const reordered = await as(rep).put(`/api/sequences/${sequence.id}/steps/order`, {
      stepIds: [ids[2], ids[0], ids[1]],
    });
    expect(reordered.body.map((x: { title: string }) => x.title)).toEqual(["C", "A", "B"]);
    const bad = await as(rep).put(`/api/sequences/${sequence.id}/steps/order`, {
      stepIds: [ids[0], ids[1]],
    });
    expect(bad.status).toBe(400);

    const lead = (await as(rep).post("/api/leads", newLead())).body;
    const enrolled = (
      await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: lead.id })
    ).body;
    expect(enrolled.task.stepId).toBe(ids[2]); // C is first now

    expect((await as(rep).del(`/api/steps/${ids[2]}`)).status).toBe(204);
    const list = (await as(rep).get(`/api/sequences/${sequence.id}/enrollments`)).body;
    expect(list[0].currentStepId).toBe(ids[0]); // moved on to A
    const steps = (await as(rep).get(`/api/sequences/${sequence.id}/steps`)).body;
    expect(steps.map((x: { title: string }) => x.title)).toEqual(["A", "B"]);
  });

  it("keeps reps out of each other's queues but lets a manager in", async () => {
    const sequence = (await as(rep).post("/api/sequences", { name: "Queues" })).body;
    await as(rep).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });
    const lead = (await as(rep).post("/api/leads", newLead())).body;
    const { task, enrollment } = (
      await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: lead.id })
    ).body;

    const mine = (await as(rep2).get("/api/tasks/due")).body;
    expect(mine.some((t: { taskId: string }) => t.taskId === task.id)).toBe(false);
    expect((await as(rep2).get("/api/tasks/due?owner=all")).status).toBe(403);
    expect((await as(rep2).post(`/api/tasks/${task.id}/complete`)).status).toBe(403);
    expect((await as(rep2).post(`/api/enrollments/${enrollment.id}/pause`)).status).toBe(403);
    expect((await as(viewer).post(`/api/tasks/${task.id}/skip`)).status).toBe(403);
    // A rep cannot assign work to someone else's queue.
    const lead2 = (await as(rep).post("/api/leads", newLead())).body;
    const assign = await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, {
      leadId: lead2.id,
      ownerId: rep2.userId,
    });
    expect(assign.status).toBe(403);

    const all = (await as(manager).get("/api/tasks/due?owner=all")).body;
    expect(all.some((t: { taskId: string }) => t.taskId === task.id)).toBe(true);
    expect((await as(manager).post(`/api/tasks/${task.id}/complete`)).status).toBe(200);
  });

  it("counts enrollments per sequence for the list screen", async () => {
    const sequence = (await as(rep).post("/api/sequences", { name: "Counted" })).body;
    await as(rep).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const lead = (await as(rep).post("/api/leads", newLead())).body;
      const res = await as(rep).post(`/api/sequences/${sequence.id}/enrollments`, {
        leadId: lead.id,
      });
      ids.push(res.body.enrollment.id);
    }
    await as(rep).post(`/api/enrollments/${ids[0]}/pause`);
    await as(rep).post(`/api/enrollments/${ids[1]}/stop`, { reason: "opted_out" });
    const stats = (await as(rep).get("/api/sequences/stats")).body;
    expect(stats[sequence.id]).toEqual({ total: 3, active: 1, paused: 1, ended: 1 });
    const foreign = (await as(outsider).get("/api/sequences/stats")).body;
    expect(foreign[sequence.id]).toBeUndefined();
  });

  it("holds a step enrolled on a Saturday until Monday in business-day mode", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-10T15:00:00Z")); // Saturday morning in Chicago
      const org = await createOrg(db); // business days by default
      const sequence = (await as(org).post("/api/sequences", { name: "Weekend" })).body;
      await as(org).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });
      const lead = (await as(org).post("/api/leads", newLead())).body;
      const { task } = (
        await as(org).post(`/api/sequences/${sequence.id}/enrollments`, { leadId: lead.id })
      ).body;
      expect(task.dueOn).toBe("2026-10-12");
      expect((await as(org).get("/api/tasks/due")).body).toHaveLength(0);

      vi.setSystemTime(new Date("2026-10-12T15:00:00Z")); // Monday
      expect((await as(org).get("/api/tasks/due")).body).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a read-only user from enrolling anyone", async () => {
    const sequence = (await as(rep).post("/api/sequences", { name: "No enroll" })).body;
    await as(rep).post(`/api/sequences/${sequence.id}/steps`, { type: "email", title: "One" });
    const lead = (await as(rep).post("/api/leads", newLead())).body;
    const res = await as(viewer).post(`/api/sequences/${sequence.id}/enrollments`, {
      leadId: lead.id,
    });
    expect(res.status).toBe(403);
  });
});

describe("settings", () => {
  it("lets each user choose their own time zone", async () => {
    const before = (await as(rep).get("/api/me/settings")).body;
    expect(before).toEqual({
      timezone: null,
      effectiveTimezone: "America/Chicago",
      organizationDefault: "America/Chicago",
    });
    const saved = await as(rep).patch("/api/me/settings", { timezone: "America/New_York" });
    expect(saved.body.effectiveTimezone).toBe("America/New_York");
    // One user's choice does not change anyone else's.
    expect((await as(rep2).get("/api/me/settings")).body.effectiveTimezone).toBe(
      "America/Chicago",
    );
    const bad = await as(rep).patch("/api/me/settings", { timezone: "Mars/Olympus" });
    expect(bad.status).toBe(400);
    // Clearing it goes back to the organization default.
    const cleared = await as(rep).patch("/api/me/settings", { timezone: null });
    expect(cleared.body.effectiveTimezone).toBe("America/Chicago");
  });

  it("lets only an admin change the organization's wait-day rule", async () => {
    const org = await createOrg(db);
    const member = await addMember(db, org.orgId, "manager");
    expect((await as(member).get("/api/settings")).body.waitDayMode).toBe("business");
    expect((await as(member).patch("/api/settings", { waitDayMode: "calendar" })).status).toBe(
      403,
    );
    const changed = await as(org).patch("/api/settings", { waitDayMode: "calendar" });
    expect(changed.status).toBe(200);
    expect(changed.body.waitDayMode).toBe("calendar");
    expect((await as(member).get("/api/settings")).body.waitDayMode).toBe("calendar");
    expect((await as(org).patch("/api/settings", { waitDayMode: "weekly" })).status).toBe(400);

    const history = (await as(org).get(`/api/history/org_settings/${org.orgId}`)).body;
    expect(history[0]).toMatchObject({
      field: "waitDayMode",
      oldValue: "business",
      newValue: "calendar",
    });
    // Other organizations are untouched.
    expect((await as(rep).get("/api/settings")).body.waitDayMode).toBe("calendar");
  });
});

describe("users and roles", () => {
  it("lets an admin change a user's role, and nobody else", async () => {
    const temp = await addMember(db, admin.orgId, "rep", "Temp Person");
    const roles = (await as(admin).get("/api/roles")).body;
    expect(roles.map((r: { name: string }) => r.name)).toEqual([
      "Admin",
      "Manager",
      "Rep",
      "Read-only",
    ]);
    const managerRole = roles.find((r: { name: string }) => r.name === "Manager");

    const denied = await as(manager).put(`/api/users/${temp.userId}/role`, {
      roleId: managerRole.id,
    });
    expect(denied.status).toBe(403);

    const ok = await as(admin).put(`/api/users/${temp.userId}/role`, { roleId: managerRole.id });
    expect(ok.status).toBe(204);
    expect((await as(temp).get("/api/me")).body.role).toBe("Manager");
    const listed = (await as(admin).get("/api/users")).body;
    expect(listed.find((u: { id: string }) => u.id === temp.userId).role).toBe("Manager");
  });

  it("never leaves an organization without an Admin", async () => {
    const org = await createOrg(db);
    const other = await addMember(db, org.orgId, "rep");
    const roles = (await as(org).get("/api/roles")).body;
    const repRole = roles.find((r: { name: string }) => r.name === "Rep");
    const adminRole = roles.find((r: { name: string }) => r.name === "Admin");

    const refused = await as(org).put(`/api/users/${org.userId}/role`, { roleId: repRole.id });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/only Admin/);

    // With a second Admin in place, the first can step down.
    await as(org).put(`/api/users/${other.userId}/role`, { roleId: adminRole.id });
    const allowed = await as(org).put(`/api/users/${org.userId}/role`, { roleId: repRole.id });
    expect(allowed.status).toBe(204);
    expect((await as(org).get("/api/me")).body.role).toBe("Rep");
  });

  it("cannot reach users or roles in another organization", async () => {
    const roles = (await as(admin).get("/api/roles")).body;
    const foreignRoles = (await as(outsider).get("/api/roles")).body;
    const cross = await as(admin).put(`/api/users/${outsider.userId}/role`, {
      roleId: roles[1].id,
    });
    expect(cross.status).toBe(404);
    const wrongRole = await as(admin).put(`/api/users/${rep.userId}/role`, {
      roleId: foreignRoles[1].id,
    });
    expect(wrongRole.status).toBe(400);
  });
});

describe("a locked account", () => {
  it("can still see who it is, and nothing else", async () => {
    const locked = await createOrg(db);
    await db
      .update(s.organizations)
      .set({ billingStatus: "locked" })
      .where(eq(s.organizations.id, locked.orgId));
    const me = await as(locked).get("/api/me");
    expect(me.status).toBe(200);
    expect(me.body.billingStatus).toBe("locked");
    const leads = await as(locked).get("/api/leads");
    expect(leads.status).toBe(402);
    expect(leads.body.error).toBe("account_locked");
  });
});

describe("unknown routes and ids", () => {
  it("answers 404 instead of crashing", async () => {
    expect((await as(rep).get("/api/nope")).status).toBe(404);
    expect((await as(rep).get("/api/leads/not-a-uuid")).status).toBe(404);
    expect((await request(app).get("/healthz")).body).toEqual({ ok: true });
  });
});
