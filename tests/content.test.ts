import { describe, expect, it } from "vitest";
import { applyMergeFields, resolveContent } from "../server/sequences/content";

const person = {
  firstName: "Jill",
  lastName: "Rude",
  email: "jrude@redfield.example",
  title: "CFO",
  company: "Redfield Energy",
};
const noOverride = { overrideSubject: null, overrideBody: null };

describe("merge fields", () => {
  it("fills known fields in either capitalization", () => {
    expect(applyMergeFields("Hi {firstName} {LastName} at {company}", person)).toBe(
      "Hi Jill Rude at Redfield Energy",
    );
  });
  it("leaves unknown fields alone and blanks missing values", () => {
    expect(applyMergeFields("{unknown} {title}", { ...person, title: null })).toBe("{unknown} ");
  });
  it("uses the real first name even when it has a space", () => {
    expect(applyMergeFields("Hi {firstName},", { ...person, firstName: "Mary Ann" })).toBe(
      "Hi Mary Ann,",
    );
  });
});

describe("resolveContent", () => {
  const step = { subject: "Inline subject", body: "Inline {firstName}" };
  const template = { subject: "Template subject", body: "Template {firstName}" };

  it("uses the step's own content when there is no template", () => {
    const c = resolveContent({ task: noOverride, step, template: null }, person);
    expect(c).toEqual({ subject: "Inline subject", body: "Inline Jill", edited: false });
  });
  it("lets the template drive the content when linked", () => {
    const c = resolveContent({ task: noOverride, step, template }, person);
    expect(c.subject).toBe("Template subject");
    expect(c.body).toBe("Template Jill");
  });
  it("lets the rep's edit win, one field at a time", () => {
    const c = resolveContent(
      { task: { overrideSubject: null, overrideBody: "Custom for {firstName}" }, step, template },
      person,
    );
    expect(c).toEqual({ subject: "Template subject", body: "Custom for Jill", edited: true });
  });
});
