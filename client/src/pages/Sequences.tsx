import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
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
}

type Stats = Record<string, { total: number; active: number; paused: number; ended: number }>;

export function sequenceFields(users: Parameters<typeof ownerField>[0]): Field[] {
  return [
    { name: "name", label: "Sequence Name", required: true, span: 6 },
    { name: "description", label: "Description", kind: "textarea", span: 6 },
    {
      name: "isActive",
      label: "Status",
      kind: "select",
      required: true,
      options: [
        { value: "true", label: "Active" },
        { value: "false", label: "Inactive (no new enrollments)" },
      ],
      parse: (v) => v === "true",
    },
    ownerField(users),
  ];
}

export function SequencesPage() {
  const api = useApi();
  const [, navigate] = useLocation();
  const { data: users } = useOrgUsers();
  const { data: me } = useMe();
  const stats = useQuery({
    queryKey: ["sequences", "stats"],
    queryFn: () => api<Stats>("GET", "/api/sequences/stats"),
  });
  const stat = (id: string) => stats.data?.[id] ?? { total: 0, active: 0, paused: 0, ended: 0 };

  const columns: Column<Sequence>[] = [
    { header: "Name", cell: (s) => <span className="font-medium">{s.name}</span> },
    { header: "Status", cell: (s) => <StatusBadge status={s.isActive ? "Active" : "Inactive"} /> },
    { header: "Enrolled", cell: (s) => stat(s.id).total },
    { header: "In progress", cell: (s) => stat(s.id).active + stat(s.id).paused },
    { header: "Ended", cell: (s) => stat(s.id).ended },
    { header: "Owner", cell: (s) => nameOf(users, s.ownerId) },
    { header: "Created", cell: (s) => formatDate(s.createdAt) },
  ];

  return (
    <RecordPage<Sequence>
      object="sequences"
      recordType="sequence"
      title="Sequences"
      subtitle="Multi-step outreach, one task at a time"
      singular="Sequence"
      searchPlaceholder="Search sequences by name…"
      fields={sequenceFields(users)}
      columns={columns}
      defaults={{ isActive: "true", ownerId: me?.user.id ?? "" }}
      describe={(s) => s.name}
      onRowOpen={(s) => navigate(`/sequences/${s.id}`)}
    />
  );
}
