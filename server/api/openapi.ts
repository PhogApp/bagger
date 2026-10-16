import { z } from "zod";
import { activityInput } from "../activities/service";
import { accountInput, contactInput, leadInput, opportunityInput } from "../records";
import { enrollInput } from "../sequences/service";
import { RESOURCES, responseSchema, type ResourceName } from "./resources";

/**
 * The OpenAPI 3.1 description of /api/v1, made from the same field checks
 * the API runs, so the docs can't drift from what it accepts. Served at
 * /api/v1/openapi.json (no key needed) for Postman, code generators and the
 * docs page in Admin.
 */

/** JSON Schema for what a request may send, without the regex noise. */
function requestSchema(schema: z.ZodType, partial = false) {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  // A change sends only the fields that change.
  if (partial) delete json.required;
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => k !== "pattern" && k !== "$schema")
          .map(([k, x]) => [k, clean(x)]),
      );
    }
    return v;
  };
  return clean(json);
}

const error = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", examples: ["invalid_input", "duplicate", "not_found"] },
        message: { type: "string" },
        details: { type: "object", additionalProperties: true },
      },
    },
  },
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errors = {
  "400": {
    description: "Something in the request isn't right",
    content: { "application/json": { schema: ref("Error") } },
  },
  "401": {
    description: "Missing or wrong API key",
    content: { "application/json": { schema: ref("Error") } },
  },
  "402": {
    description: "The Bagger account is locked or cancelled",
    content: { "application/json": { schema: ref("Error") } },
  },
  "403": {
    description: "This key can't do that (a read-only key writing, say)",
    content: { "application/json": { schema: ref("Error") } },
  },
  "429": {
    description: "Too many requests; wait Retry-After seconds",
    content: { "application/json": { schema: ref("Error") } },
  },
};
const idParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const listParams = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    description: "How many to return.",
  },
  {
    name: "cursor",
    in: "query",
    schema: { type: "string" },
    description: "The nextCursor from the previous page.",
  },
  {
    name: "updatedSince",
    in: "query",
    schema: { type: "string", format: "date-time" },
    description:
      "Only records changed after this time. Results come oldest change first, so a sync can remember the last updatedAt it saw.",
  },
  {
    name: "includeDeleted",
    in: "query",
    schema: { type: "boolean" },
    description: "Include deleted records (with deletedAt set).",
  },
];
const idempotency = {
  name: "Idempotency-Key",
  in: "header",
  schema: { type: "string", maxLength: 200 },
  description:
    "Any unique value. Sending the same request again with the same key returns the first answer instead of doing it twice. Remembered for a day.",
};

const titles: Record<string, string> = {
  leads: "Leads",
  contacts: "Contacts",
  accounts: "Accounts",
  opportunities: "Opportunities",
  activities: "Activities",
};
const inputs: Record<string, z.ZodType> = {
  leads: leadInput,
  contacts: contactInput,
  accounts: accountInput,
  opportunities: opportunityInput,
  activities: activityInput,
};
const schemaName = (name: ResourceName) =>
  RESOURCES[name].singular.charAt(0).toUpperCase() + RESOURCES[name].singular.slice(1);

function crud(name: "leads" | "contacts" | "accounts" | "opportunities" | "activities") {
  const one = RESOURCES[name].singular;
  const model = schemaName(name);
  const filters = RESOURCES[name].filters.map((f) => ({
    name: f,
    in: "query",
    schema: { type: "string" },
    description: f === "email" ? "Exact email address (any case)." : `Only ${name} with this ${f}.`,
  }));
  const dup =
    name === "activities"
      ? {}
      : {
          "409": {
            description: `Bagger already has a ${one} like this (same email, or for accounts the same name or website). Add ?allowDuplicate=true to create it anyway.`,
            content: { "application/json": { schema: ref("Error") } },
          },
        };
  return {
    [`/${name}`]: {
      get: {
        tags: [titles[name]],
        summary: `List ${name}`,
        parameters: [...listParams, ...filters],
        responses: {
          "200": {
            description: `A page of ${name}, oldest change first.`,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "nextCursor"],
                  properties: {
                    data: { type: "array", items: ref(model) },
                    nextCursor: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
          ...errors,
        },
      },
      post: {
        tags: [titles[name]],
        summary: `Create a ${one}`,
        parameters: [
          idempotency,
          ...(name === "activities"
            ? []
            : [
                {
                  name: "allowDuplicate",
                  in: "query",
                  schema: { type: "boolean" },
                  description: "Create it even if it looks like a duplicate.",
                },
              ]),
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: requestSchema(inputs[name]) } },
        },
        responses: {
          "201": {
            description: `The new ${one}`,
            content: { "application/json": { schema: ref(model) } },
          },
          ...dup,
          ...errors,
        },
      },
    },
    [`/${name}/{id}`]: {
      get: {
        tags: [titles[name]],
        summary: `Get a ${one}`,
        parameters: [idParam],
        responses: {
          "200": {
            description: `The ${one}`,
            content: { "application/json": { schema: ref(model) } },
          },
          "404": { description: "No such record" },
          ...errors,
        },
      },
      patch: {
        tags: [titles[name]],
        summary: `Change a ${one}`,
        description:
          "Send only the fields to change. Custom field values merge into the ones it has.",
        parameters: [idParam, idempotency],
        requestBody: {
          required: true,
          content: { "application/json": { schema: requestSchema(inputs[name], true) } },
        },
        responses: {
          "200": {
            description: `The ${one} as it is now`,
            content: { "application/json": { schema: ref(model) } },
          },
          "404": { description: "No such record" },
          ...errors,
        },
      },
      delete: {
        tags: [titles[name]],
        summary: `Delete a ${one}`,
        description:
          "Deleted records keep their history and still appear with includeDeleted=true.",
        parameters: [idParam, idempotency],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "No such record" },
          ...errors,
        },
      },
    },
  };
}

let cached: Record<string, unknown> | null = null;

export function openApiDocument(): Record<string, unknown> {
  if (cached) return cached;
  const simpleList = (items: Record<string, unknown>) => ({
    type: "object",
    properties: { data: { type: "array", items } },
  });
  cached = {
    openapi: "3.1.0",
    info: {
      title: "Bagger API",
      version: "1",
      description:
        "Read and change your Bagger leads, contacts, accounts, opportunities and activities, and enroll people in sequences. " +
        "Authenticate with an API key from Admin › API and webhooks: `Authorization: Bearer bgr_…`. " +
        'Up to 120 requests a minute per key. Errors always look like `{ "error": { "code", "message", "details" } }`. ' +
        'Changes made through the API follow the same rules as the app and show in History as "via API: <key name>".',
    },
    servers: [{ url: "/api/v1" }],
    security: [{ apiKey: [] }],
    tags: [
      { name: "Leads" },
      { name: "Contacts" },
      { name: "Accounts" },
      { name: "Opportunities" },
      { name: "Activities" },
      { name: "Sequences" },
      {
        name: "Reference",
        description:
          "Your users, statuses and custom fields, for filling in ownerId, status and custom.",
      },
    ],
    paths: {
      "/me": {
        get: {
          tags: ["Reference"],
          summary: "Check a key",
          description: "Which organization the key belongs to and what it can do.",
          responses: { "200": { description: "The organization and key" }, ...errors },
        },
      },
      ...crud("leads"),
      ...crud("contacts"),
      ...crud("accounts"),
      ...crud("opportunities"),
      ...crud("activities"),
      "/sequences": {
        get: {
          tags: ["Sequences"],
          summary: "List sequences",
          parameters: listParams,
          responses: {
            "200": {
              description: "A page of sequences",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: { type: "array", items: ref("Sequence") },
                      nextCursor: { type: ["string", "null"] },
                    },
                  },
                },
              },
            },
            ...errors,
          },
        },
      },
      "/sequences/{id}/enrollments": {
        post: {
          tags: ["Sequences"],
          summary: "Enroll a lead or contact",
          description:
            "Starts the person on the sequence's first step, in the owner's Roll the Calls queue. Exactly one of leadId or contactId.",
          parameters: [idParam, idempotency],
          requestBody: {
            required: true,
            content: { "application/json": { schema: requestSchema(enrollInput) } },
          },
          responses: {
            "201": {
              description: "The enrollment",
              content: { "application/json": { schema: ref("Enrollment") } },
            },
            ...errors,
          },
        },
      },
      "/users": {
        get: {
          tags: ["Reference"],
          summary: "List users",
          description: "Everyone who can own records.",
          responses: {
            "200": {
              description: "Users",
              content: {
                "application/json": {
                  schema: simpleList({
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      name: { type: "string" },
                      email: { type: "string" },
                      role: { type: "string" },
                      status: { type: "string", enum: ["active", "ending"] },
                    },
                  }),
                },
              },
            },
            ...errors,
          },
        },
      },
      "/statuses": {
        get: {
          tags: ["Reference"],
          summary: "List statuses",
          description:
            "Each kind of record's status list, in order. Opportunities' statuses are pipeline stages.",
          responses: { "200": { description: "Statuses by kind of record" }, ...errors },
        },
      },
      "/custom-fields": {
        get: {
          tags: ["Reference"],
          summary: "List custom fields",
          description: "Send and read custom values in each record's `custom`, by the field's key.",
          responses: { "200": { description: "Custom fields" }, ...errors },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "An API key from Admin › API and webhooks.",
        },
      },
      schemas: {
        Error: error,
        ...Object.fromEntries(
          (Object.keys(RESOURCES) as ResourceName[]).map((n) => [schemaName(n), responseSchema(n)]),
        ),
      },
    },
  };
  return cached;
}
