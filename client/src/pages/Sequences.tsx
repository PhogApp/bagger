import { useQuery } from "@tanstack/react-query";
import { RecordPage, type Column, type Field } from "@/components/RecordPage";
import { StatusBadge } from "@/components/StatusBadge";
import { useApi, useMe, useOrgUsers } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { nameOf, ownerField } from "./shared";

export interface Sequence {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SequenceStats = Record<
  string,
  { total: number; active: number; paused: number; ended: number }
>;

export function sequenceFields(users: Parameters<typeof ownerField>[0]): Field[] {
  return [
    { name: "name", label: "Sequence Name", required: true, span: 2 },
    {
      name: "isActive",
      label: "Status",
      kind: "select",
      required: true,
      span: 2,
      options: [
        { value: "true", label: "Active" },
        { value: "false", label: "Inactive (no new enrollments)" },
      ],
      parse: (v) => v === "true",
    },
    { ...ownerField(users), span: 2 },
    { name: "description", label: "Description", kind: "textarea", span: 6, rows: 2 },
  ];
}

export function useSequenceStats() {
  const api = useApi();
  return useQuery({
    queryKey: ["sequences", "stats"],
    queryFn: () => api<SequenceStats>("GET", "/api/sequences/stats"),
  });
}

export function SequencesPage() {
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();
  const stats = useSequenceStats();
  const stat = (id: string) => stats.data?.[id] ?? { total: 0, active: 0, paused: 0, ended: 0 };

  const columns: Column<Sequence>[] = [
    {
      key: "name",
      header: "Name",
      sort: "name",
      cell: (s) => <span className="font-medium">{s.name}</span>,
      csv: (s) => s.name,
    },
    {
      key: "isActive",
      header: "Status",
      sort: "isActive",
      cell: (s) => <StatusBadge status={s.isActive ? "Active" : "Inactive"} />,
      csv: (s) => (s.isActive ? "Active" : "Inactive"),
    },
    { key: "enrolled", header: "Enrolled", cell: (s) => stat(s.id).total },
    {
      key: "inProgress",
      header: "In progress",
      cell: (s) => stat(s.id).active + stat(s.id).paused,
    },
    { key: "ended", header: "Ended", cell: (s) => stat(s.id).ended },
    { key: "owner", header: "Owner", sort: "owner", cell: (s) => nameOf(users, s.ownerId) },
    {
      key: "description",
      header: "Description",
      hidden: true,
      cell: (s) => <span className="line-clamp-1">{s.description ?? ""}</span>,
      csv: (s) => s.description,
    },
    {
      key: "createdAt",
      header: "Created",
      sort: "createdAt",
      cell: (s) => formatDate(s.createdAt),
      csv: (s) => s.createdAt,
    },
  ];

  return (
    <RecordPage<Sequence>
      object="sequences"
      recordType="sequence"
      title="Sequences"
      subtitle="Multi-step outreach, one task at a time"
      singular="Sequence"
      searchPlaceholder="Search sequences by name or description…"
      fields={sequenceFields(users)}
      columns={columns}
      defaults={{ isActive: "true", ownerId: me?.user.id ?? "" }}
      describe={(s) => s.name}
      detailPath={(id) => `/sequences/${id}`}
      listTools={{}}
    />
  );
}
