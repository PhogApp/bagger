import { beforeAll, describe, expect, it } from "vitest";
import { resolveActor, type Actor } from "../server/auth/actor";
import type { Db } from "../server/db/types";
import { sequenceService, templateService } from "../server/records";
import * as seq from "../server/sequences/service";
import { createOrg, createTestDb } from "./helpers";

let db: Db;
let actor: Actor;
const long = "x".repeat(301);
const fits = "y".repeat(300);

beforeAll(async () => {
  db = await createTestDb();
  actor = (await resolveActor(db, await createOrg(db)))!;
});

describe("LinkedIn's 300 characters", () => {
  it("hold for LinkedIn templates, made or changed", async () => {
    await expect(
      templateService.create(db, actor, { name: "Too long", type: "linkedin", body: long }),
    ).rejects.toThrow(/300 characters/);
    const ok = await templateService.create(db, actor, {
      name: "Fits",
      type: "linkedin",
      body: fits,
    });
    await expect(templateService.update(db, actor, ok.id, { body: long })).rejects.toThrow(/300/);
    // An email turned into LinkedIn has to fit too.
    const email = await templateService.create(db, actor, {
      name: "Long email",
      type: "email",
      subject: "Hi",
      body: `<p>${long}</p>`,
    });
    await expect(templateService.update(db, actor, email.id, { type: "linkedin" })).rejects.toThrow(
      /300/,
    );
    // Email templates have no such limit.
    expect(email.body).toContain(long);
  });

  it("hold for connection requests, written or from a template; messages may be longer", async () => {
    const sequence = await sequenceService.create(db, actor, { name: "LinkedIn" });
    await expect(
      seq.addStep(db, actor, sequence.id, {
        type: "linkedin_connect",
        title: "Connect",
        body: long,
      }),
    ).rejects.toThrow(/300 characters/);
    const step = await seq.addStep(db, actor, sequence.id, {
      type: "linkedin_connect",
      title: "Connect",
      body: fits,
    });
    await expect(seq.updateStep(db, actor, step.id, { body: long })).rejects.toThrow(/300/);
    const message = await seq.addStep(db, actor, sequence.id, {
      type: "linkedin_message",
      title: "Follow up",
      body: long,
    });
    expect(message.body).toBe(long);
    // A message step with a long body can't simply become a connection request.
    await expect(
      seq.updateStep(db, actor, message.id, { type: "linkedin_connect" }),
    ).rejects.toThrow(/300/);
  });
});
