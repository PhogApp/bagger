import type { Field, Option } from "@/components/RecordPage";
import type { OrgUser } from "@/lib/api";

export const PERSON_STATUSES = ["New", "Active", "Prospecting", "Not Interested", "Do Not Contact"];
export const ACCOUNT_STATUSES = [
  "Active",
  "Customer",
  "Vendor",
  "Partner",
  "Inactive",
  "Do Not Contact",
];

export const toOptions = (values: string[]): Option[] =>
  values.map((v) => ({ value: v, label: v }));

export function ownerField(users: OrgUser[] | undefined): Field {
  return {
    name: "ownerId",
    label: "Owner",
    kind: "select",
    required: true,
    options: (users ?? []).map((u) => ({ value: u.id, label: u.name })),
  };
}

export const nameOf = (users: OrgUser[] | undefined, id: string) =>
  users?.find((u) => u.id === id)?.name ?? "—";
