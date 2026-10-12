import { escapeHtml } from "./richtext";

/**
 * Merge fields in templates and steps: {firstName}, {lastName}, {email},
 * {title}, {company}, {custom.<key>} and {account.<key>}. Shared so the
 * template page can preview exactly what the server will send.
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
export function applyMergeFields(
  text: string,
  person: MergePerson,
  options: { html?: boolean } = {},
): string {
  // In an email's HTML, a value such as "Smith & Sons" must stay text.
  const out = (value: string) => (options.html ? escapeHtml(value) : value);
  return text.replace(/\{(\w+)(?:\.(\w+))?\}/g, (whole, first: string, key?: string) => {
    if (key) {
      const values =
        first === "custom" ? person.custom : first === "account" ? person.accountCustom : undefined;
      return values ? out(shown(values[key])) : whole;
    }
    const fill = FIELDS[first.toLowerCase()];
    return fill ? out(fill(person)) : whole;
  });
}
