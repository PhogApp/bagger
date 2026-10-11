import type { Field, Option } from "@/components/RecordPage";
import type { OrgUser, StatusObject, StatusOption } from "@/lib/api";

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

/** The Status picker for one kind of record, from the organization's own list. */
export function statusField(statuses: StatusOption[] | undefined, object: StatusObject): Field {
  return {
    name: "status",
    label: "Status",
    kind: "select",
    required: true,
    options: (statuses ?? [])
      .filter((s) => s.object === object)
      .map((s) => ({ value: s.name, label: s.name })),
  };
}

export const defaultStatus = (statuses: StatusOption[] | undefined, object: StatusObject) =>
  statuses?.find((s) => s.object === object && s.isDefault)?.name ?? "";

export const statusColor = (
  statuses: StatusOption[] | undefined,
  object: StatusObject,
  name: string,
) => statuses?.find((s) => s.object === object && s.name === name)?.color ?? "neutral";
