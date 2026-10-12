/**
 * Works out what a rep should send for a step.
 *
 * Order of precedence:
 *   1. the rep's edit for this one person (task override)
 *   2. the step's linked template, read live so template edits flow through
 *   3. the step's own inline subject/body
 */

export interface MergePerson {
  firstName: string;
  lastName: string;
  email: string;
  title?: string | null;
  company?: string | null;
  /** The person's custom field values, for {custom.<key>}. */
  custom?: Record<string, unknown>;
  /** A contact's account's custom field values, for {account.<key>}. */
  accountCustom?: Record<string, unknown>;
}

export interface ContentSources {
  task: { overrideSubject: string | null; overrideBody: string | null };
  step: { subject: string | null; body: string | null };
  template: { subject: string | null; body: string } | null;
}

export interface ResolvedContent {
  subject: string | null;
  body: string | null;
  /** True when the rep has edited this message for this person. */
  edited: boolean;
}

const FIELDS: Record<string, (p: MergePerson) => string> = {
  firstname: (p) => p.firstName,
  lastname: (p) => p.lastName,
  email: (p) => p.email,
  title: (p) => p.title ?? "",
  company: (p) => p.company ?? "",
};

function shown(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/**
 * Replace {firstName}-style fields, plus {custom.<key>} for the person's
 * custom fields and {account.<key>} for their account's. A custom field with
 * no value becomes empty; anything unknown is left untouched.
 */
export function applyMergeFields(text: string, person: MergePerson): string {
  return text.replace(/\{(\w+)(?:\.(\w+))?\}/g, (whole, first: string, key?: string) => {
    if (key) {
      const values =
        first === "custom" ? person.custom : first === "account" ? person.accountCustom : undefined;
      return values ? shown(values[key]) : whole;
    }
    const fill = FIELDS[first.toLowerCase()];
    return fill ? fill(person) : whole;
  });
}

export function resolveContent(src: ContentSources, person: MergePerson): ResolvedContent {
  const baseSubject = src.template ? src.template.subject : src.step.subject;
  const baseBody = src.template ? src.template.body : src.step.body;
  const subject = src.task.overrideSubject ?? baseSubject;
  const body = src.task.overrideBody ?? baseBody;
  return {
    subject: subject == null ? null : applyMergeFields(subject, person),
    body: body == null ? null : applyMergeFields(body, person),
    edited: src.task.overrideSubject != null || src.task.overrideBody != null,
  };
}
