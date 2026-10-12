import { useQuery } from "@tanstack/react-query";
import type { Field } from "@/components/RecordPage";
import { useApi, useOrgUsers } from "@/lib/api";
import { formatDay, formatMoney } from "@/lib/utils";

/** The record types that have custom fields and a layout. */
export type LayoutObject = "leads" | "contacts" | "accounts" | "opportunities";

export type CustomFieldType =
  | "text"
  | "longtext"
  | "number"
  | "currency"
  | "date"
  | "checkbox"
  | "picklist"
  | "multipicklist"
  | "url"
  | "email"
  | "phone"
  | "user";

export interface CustomField {
  id: string;
  object: LayoutObject;
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  options: string[];
  archived: boolean;
}

export interface LayoutEntry {
  field: string;
  width: "third" | "half" | "full";
  hidden?: boolean;
}

export interface FieldSetup {
  fields: CustomField[];
  layouts: Partial<Record<LayoutObject, LayoutEntry[]>>;
  builtIn: Record<LayoutObject, { name: string; locked?: boolean }[]>;
}

export const TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text",
  longtext: "Long text",
  number: "Number",
  currency: "Currency",
  date: "Date",
  checkbox: "Checkbox (yes / no)",
  picklist: "Picklist",
  multipicklist: "Multi-select picklist",
  url: "Web address",
  email: "Email",
  phone: "Phone",
  user: "User",
};

export const SPAN_FOR = { third: 2, half: 3, full: 6 } as const;
export const WIDTH_FOR = { 2: "third", 3: "half", 6: "full" } as const;

export function useFieldSetup() {
  const api = useApi();
  return useQuery({
    queryKey: ["fields"],
    queryFn: () => api<FieldSetup>("GET", "/api/fields"),
  });
}

/** How one custom field behaves in forms and on the record page. */
export function customFieldAsField(
  def: CustomField,
  users: { id: string; name: string }[] | undefined,
): Field {
  const base = { name: `custom.${def.key}`, label: def.label, required: def.required };
  switch (def.type) {
    case "longtext":
      return { ...base, kind: "textarea", span: 6 };
    case "number":
      return { ...base, kind: "number" };
    case "currency":
      return {
        ...base,
        kind: "number",
        placeholder: "12500",
        format: (v) => (typeof v === "number" ? formatMoney(v) : null),
      };
    case "date":
      return {
        ...base,
        kind: "date",
        format: (v) => (typeof v === "string" ? formatDay(v) : null),
      };
    case "checkbox":
      return {
        ...base,
        kind: "select",
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
        parse: (v) => (v === "" ? "" : v === "true"),
      };
    case "picklist":
      return { ...base, kind: "select", options: def.options.map((o) => ({ value: o, label: o })) };
    case "multipicklist":
      return {
        ...base,
        kind: "multiselect",
        span: 6,
        options: def.options.map((o) => ({ value: o, label: o })),
        parse: (v) =>
          v
            .split(";")
            .map((x) => x.trim())
            .filter(Boolean),
        format: (v) => (Array.isArray(v) && v.length > 0 ? v.join(", ") : null),
      };
    case "url":
      return { ...base, kind: "url" };
    case "email":
      return { ...base, kind: "email" };
    case "phone":
      return { ...base, kind: "tel" };
    case "user":
      return {
        ...base,
        kind: "select",
        options: (users ?? []).map((u) => ({ value: u.id, label: u.name })),
      };
    default:
      return { ...base, kind: "text" };
  }
}

/**
 * Bagger's own fields plus the organization's custom ones, in the order and
 * widths an admin set in Admin → Fields, without the hidden ones. Fields the
 * layout doesn't mention (new ones) follow at the end.
 */
export function useLayout(object: LayoutObject, builtIn: Field[]): Field[] {
  const { data: setup } = useFieldSetup();
  const { data: users } = useOrgUsers();
  const custom = (setup?.fields ?? [])
    .filter((f) => f.object === object && !f.archived)
    .map((f) => customFieldAsField(f, users));
  const all = [...builtIn, ...custom];
  const entries = setup?.layouts[object];
  if (!entries) return all;
  const byName = new Map(all.map((f) => [f.name, f]));
  const placed: Field[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const f = byName.get(e.field);
    seen.add(e.field);
    if (!f || e.hidden) continue;
    placed.push({ ...f, span: SPAN_FOR[e.width] });
  }
  return [...placed, ...all.filter((f) => !seen.has(f.name))];
}

/**
 * Names and standard widths of Bagger's own fields, for Admin → Fields. The
 * record pages define the same fields; keep the two in step.
 */
export const BUILT_IN_FIELDS: Record<
  LayoutObject,
  { name: string; label: string; span: 2 | 3 | 6 }[]
> = {
  leads: [
    { name: "firstName", label: "First Name", span: 2 },
    { name: "lastName", label: "Last Name", span: 2 },
    { name: "title", label: "Title", span: 2 },
    { name: "email", label: "Email", span: 3 },
    { name: "company", label: "Company", span: 3 },
    { name: "cellPhone", label: "Cell Phone", span: 2 },
    { name: "directPhone", label: "Direct Phone", span: 2 },
    { name: "hqPhone", label: "HQ Phone", span: 2 },
    { name: "linkedin", label: "LinkedIn", span: 3 },
    { name: "status", label: "Status", span: 3 },
    { name: "ownerId", label: "Owner", span: 3 },
    { name: "notes", label: "Notes", span: 6 },
  ],
  contacts: [
    { name: "firstName", label: "First Name", span: 2 },
    { name: "lastName", label: "Last Name", span: 2 },
    { name: "title", label: "Title", span: 2 },
    { name: "email", label: "Email", span: 3 },
    { name: "accountId", label: "Account", span: 3 },
    { name: "cellPhone", label: "Cell Phone", span: 2 },
    { name: "directPhone", label: "Direct Phone", span: 2 },
    { name: "hqPhone", label: "HQ Phone", span: 2 },
    { name: "linkedin", label: "LinkedIn", span: 3 },
    { name: "status", label: "Status", span: 3 },
    { name: "ownerId", label: "Owner", span: 3 },
    { name: "notes", label: "Notes", span: 6 },
  ],
  accounts: [
    { name: "name", label: "Account Name", span: 6 },
    { name: "website", label: "Website", span: 3 },
    { name: "linkedin", label: "LinkedIn", span: 3 },
    { name: "hqPhone", label: "HQ Phone", span: 2 },
    { name: "status", label: "Status", span: 2 },
    { name: "ownerId", label: "Owner", span: 2 },
    { name: "notes", label: "Notes", span: 6 },
  ],
  opportunities: [
    { name: "name", label: "Opportunity Name", span: 6 },
    { name: "accountId", label: "Account", span: 3 },
    { name: "contactId", label: "Main Contact", span: 3 },
    { name: "amount", label: "Amount", span: 2 },
    { name: "closeDate", label: "Expected Close", span: 2 },
    { name: "status", label: "Stage", span: 2 },
    { name: "ownerId", label: "Owner", span: 3 },
    { name: "notes", label: "Notes", span: 6 },
  ],
};
