/**
 * What each kind of record looks like through the public API: exactly these
 * fields, in this form, whatever the database looks like underneath. Adding a
 * field is fine; removing or renaming one would break someone, so don't.
 */

type FieldType = "id" | "string" | "email" | "date" | "datetime" | "number" | "boolean" | "object";

interface Resource {
  singular: string;
  /** Field → type. Every field may be null except those in `required`. */
  fields: Record<string, FieldType>;
  required: string[];
  /** Exact-match filters on its list endpoint. */
  filters: string[];
}

const stamps = { createdAt: "datetime", updatedAt: "datetime", deletedAt: "datetime" } as const;
const person = {
  id: "id",
  firstName: "string",
  lastName: "string",
  title: "string",
  email: "email",
  cellPhone: "string",
  directPhone: "string",
  hqPhone: "string",
  linkedin: "string",
  notes: "string",
  status: "string",
  ownerId: "id",
  custom: "object",
} as const;

export const RESOURCES = {
  leads: {
    singular: "lead",
    fields: {
      ...person,
      company: "string",
      convertedAt: "datetime",
      convertedContactId: "id",
      ...stamps,
    },
    required: [
      "id",
      "firstName",
      "lastName",
      "email",
      "status",
      "ownerId",
      "custom",
      "createdAt",
      "updatedAt",
    ],
    filters: ["email", "status", "ownerId"],
  },
  contacts: {
    singular: "contact",
    fields: { ...person, accountId: "id", ...stamps },
    required: [
      "id",
      "firstName",
      "lastName",
      "email",
      "accountId",
      "status",
      "ownerId",
      "custom",
      "createdAt",
      "updatedAt",
    ],
    filters: ["email", "accountId", "status", "ownerId"],
  },
  accounts: {
    singular: "account",
    fields: {
      id: "id",
      name: "string",
      website: "string",
      linkedin: "string",
      hqPhone: "string",
      notes: "string",
      status: "string",
      ownerId: "id",
      custom: "object",
      ...stamps,
    },
    required: ["id", "name", "status", "ownerId", "custom", "createdAt", "updatedAt"],
    filters: ["status", "ownerId"],
  },
  opportunities: {
    singular: "opportunity",
    fields: {
      id: "id",
      name: "string",
      accountId: "id",
      contactId: "id",
      amount: "number",
      closeDate: "date",
      status: "string",
      notes: "string",
      closedAt: "datetime",
      ownerId: "id",
      custom: "object",
      ...stamps,
    },
    required: ["id", "name", "accountId", "status", "ownerId", "custom", "createdAt", "updatedAt"],
    filters: ["accountId", "contactId", "status", "ownerId"],
  },
  activities: {
    singular: "activity",
    fields: {
      id: "id",
      type: "string",
      status: "string",
      subject: "string",
      body: "string",
      dueOn: "date",
      occurredAt: "datetime",
      leadId: "id",
      contactId: "id",
      accountId: "id",
      opportunityId: "id",
      ownerId: "id",
      ...stamps,
    },
    required: ["id", "type", "status", "ownerId", "createdAt", "updatedAt"],
    filters: ["leadId", "contactId", "accountId", "opportunityId", "type", "status", "ownerId"],
  },
  sequences: {
    singular: "sequence",
    fields: {
      id: "id",
      name: "string",
      description: "string",
      isActive: "boolean",
      ownerId: "id",
      ...stamps,
    },
    required: ["id", "name", "isActive", "ownerId", "createdAt", "updatedAt"],
    filters: [],
  },
  enrollments: {
    singular: "enrollment",
    fields: {
      id: "id",
      sequenceId: "id",
      leadId: "id",
      contactId: "id",
      ownerId: "id",
      state: "string",
      endReason: "string",
      enrolledAt: "datetime",
      endedAt: "datetime",
    },
    required: ["id", "sequenceId", "ownerId", "state", "enrolledAt"],
    filters: [],
  },
} satisfies Record<string, Resource>;

export type ResourceName = keyof typeof RESOURCES;

export function serialize(
  name: ResourceName,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, type] of Object.entries(RESOURCES[name].fields)) {
    const value = row[field];
    if (value === undefined || value === null) out[field] = type === "object" ? {} : null;
    else if (type === "number") out[field] = Number(value);
    else if (value instanceof Date) out[field] = value.toISOString();
    else out[field] = value;
  }
  return out;
}

/** The JSON Schema for a record as the API returns it. */
export function responseSchema(name: ResourceName) {
  const r: Resource = RESOURCES[name];
  const json = (t: FieldType, required: boolean) => {
    const base =
      t === "id"
        ? { type: "string", format: "uuid" }
        : t === "email"
          ? { type: "string", format: "email" }
          : t === "date"
            ? { type: "string", format: "date" }
            : t === "datetime"
              ? { type: "string", format: "date-time" }
              : t === "object"
                ? { type: "object", additionalProperties: true }
                : { type: t };
    return required ? base : { ...base, type: [base.type, "null"] };
  };
  return {
    type: "object",
    required: r.required,
    properties: Object.fromEntries(
      Object.entries(r.fields).map(([f, t]) => [f, json(t, r.required.includes(f))]),
    ),
  };
}
