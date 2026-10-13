import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApi, useMe } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { cn, formatDate, formatDay } from "@/lib/utils";

/**
 * The people in the organization. Nobody is deleted: removing someone ends
 * their seat (at the end of the month unless chosen otherwise), hands their
 * records to someone else and keeps everything they did under their name.
 * Inactive people aren't charged and can be reinstated.
 */

interface Person {
  id: string;
  name: string;
  email: string;
  role: string;
  roleId: string;
  status: "active" | "ending" | "removed";
  statusLabel: string;
  endsOn: string | null;
  endedAt: string | null;
  handToUserId: string | null;
  handToName: string | null;
  isOwner: boolean;
}
interface PeopleList {
  people: Person[];
  seats: { active: number; ending: number; inactive: number };
}
interface Role {
  id: string;
  name: string;
}

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

/** The last day of this month, as the server will set it (close enough to show). */
function monthEndLocal(): string {
  const d = new Date();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
}

export function PeopleSettings({ canManage }: { canManage: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const { manageMembers } = useSession();
  const list = useQuery({
    queryKey: ["people"],
    queryFn: () => api<PeopleList>("GET", "/api/people"),
  });
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api<Role[]>("GET", "/api/roles") });
  const [removing, setRemoving] = useState<string | null>(null);
  const [handTo, setHandTo] = useState("");
  const [when, setWhen] = useState<"end_of_month" | "now">("end_of_month");
  const [showInactive, setShowInactive] = useState(false);

  const refresh = async () => {
    for (const key of [
      "people",
      "users",
      "me",
      "leads",
      "contacts",
      "accounts",
      "opportunities",
      "activities",
      "tasks",
    ]) {
      await queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
  const act = useMutation({
    mutationFn: (job: { call: () => Promise<unknown>; done: string }) => job.call(),
    onSuccess: async (_r, job) => {
      setRemoving(null);
      await refresh();
      toast.success(job.done);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const people = list.data?.people ?? [];
  const current = people.filter((p) => p.status !== "removed");
  const inactive = people.filter((p) => p.status === "removed");
  const activeOthers = (id: string) => people.filter((p) => p.status === "active" && p.id !== id);

  const startRemoving = (p: Person) => {
    const owner = people.find((x) => x.isOwner && x.id !== p.id);
    setHandTo(owner?.id ?? me?.user.id ?? "");
    setWhen("end_of_month");
    setRemoving(p.id);
  };

  return (
    <section className="rounded-lg border bg-background">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div>
          <h2 className="text-lg font-semibold">Users and roles</h2>
          <p className="text-sm text-muted-foreground">
            {list.data
              ? `${list.data.seats.active + list.data.seats.ending} paid seat${list.data.seats.active + list.data.seats.ending === 1 ? "" : "s"}` +
                (list.data.seats.ending ? `, ${list.data.seats.ending} ending this month` : "") +
                (canManage && list.data.seats.inactive
                  ? ` · ${list.data.seats.inactive} inactive, not charged`
                  : "")
              : "Loading…"}
          </p>
        </div>
        {canManage && manageMembers && (
          <Button variant="outline" onClick={manageMembers}>
            <UserPlus className="mr-2 h-4 w-4" aria-hidden />
            Invite people
          </Button>
        )}
      </div>

      <div className="p-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead className="w-48">Role</TableHead>
              {canManage && <TableHead className="w-64">Seat</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {current.map((p) => (
              <Fragment key={p.id}>
                <TableRow>
                  <TableCell className="font-medium">
                    {p.name}
                    {p.id === me?.user.id && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">you</span>
                    )}
                    {p.isOwner && (
                      <span className="ml-2 rounded-full bg-brand-ocean/15 px-2 py-0.5 text-xs font-medium text-brand-deep">
                        Owner
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{p.email}</TableCell>
                  <TableCell>
                    {canManage && p.status === "active" ? (
                      <select
                        aria-label={`Role for ${p.name}`}
                        className={selectClass}
                        value={p.roleId}
                        // The owner must stay an Admin until ownership is transferred.
                        disabled={act.isPending || p.isOwner}
                        title={p.isOwner ? "The owner is always an Admin" : undefined}
                        onChange={(e) => {
                          const role = roles.data?.find((r) => r.id === e.target.value)?.name ?? "";
                          act.mutate({
                            call: () =>
                              api("PUT", `/api/users/${p.id}/role`, { roleId: e.target.value }),
                            done: `${p.name} is now ${/^[AEIOU]/i.test(role) ? "an" : "a"} ${role}`,
                          });
                        }}
                      >
                        {roles.data?.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      p.role
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      {p.status === "ending" ? (
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-brand-mauve/25 px-2 py-0.5 text-xs font-medium">
                              Ending on {p.endsOn ? formatDay(p.endsOn) : "—"}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7"
                              disabled={act.isPending}
                              onClick={() =>
                                act.mutate({
                                  call: () => api("POST", `/api/people/${p.id}/undo`),
                                  done: `${p.name} stays`,
                                })
                              }
                            >
                              Undo
                            </Button>
                          </div>
                          <label className="flex items-center gap-1 text-xs text-muted-foreground">
                            <span className="whitespace-nowrap">Records go to</span>
                            <select
                              aria-label={`Who takes over ${p.name}'s records`}
                              className={cn(selectClass, "h-7 text-xs")}
                              value={p.handToUserId ?? ""}
                              disabled={act.isPending}
                              onChange={(e) => {
                                const name = people.find((x) => x.id === e.target.value)?.name;
                                act.mutate({
                                  call: () =>
                                    api("PUT", `/api/people/${p.id}/hand-to`, {
                                      handTo: e.target.value,
                                    }),
                                  done: `${p.name}'s records will go to ${name}`,
                                });
                              }}
                            >
                              {activeOthers(p.id).map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      ) : p.isOwner || p.id === me?.user.id ? (
                        <span className="text-xs text-muted-foreground">
                          {p.isOwner ? "The owner can't be removed" : "Active"}
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 text-destructive hover:text-destructive"
                          onClick={() => (removing === p.id ? setRemoving(null) : startRemoving(p))}
                        >
                          Remove…
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
                {removing === p.id && (
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={4}>
                      <form
                        aria-label={`Remove ${p.name}`}
                        className="space-y-3 py-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const name = people.find((x) => x.id === handTo)?.name;
                          act.mutate({
                            call: () => api("POST", `/api/people/${p.id}/remove`, { handTo, when }),
                            done:
                              when === "now"
                                ? `${p.name} is inactive. Their records went to ${name}.`
                                : `${p.name}'s seat ends on ${formatDay(monthEndLocal())}`,
                          });
                        }}
                      >
                        <p className="text-sm">
                          <strong>Remove {p.name}.</strong> Nothing they did is deleted; it keeps
                          their name. They stop being a paid seat once access ends, and you can
                          reinstate them later.
                        </p>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="space-y-1 text-sm">
                            <span className="font-medium">Who takes over their records?</span>
                            <select
                              className={selectClass}
                              value={handTo}
                              onChange={(e) => setHandTo(e.target.value)}
                            >
                              {activeOthers(p.id).map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.name}
                                </option>
                              ))}
                            </select>
                            <span className="block text-xs text-muted-foreground">
                              Leads, contacts, accounts, opportunities, templates, sequences, open
                              activities and their Roll the Calls queue.
                            </span>
                          </label>
                          <fieldset className="space-y-1 text-sm">
                            <legend className="font-medium">When does access end?</legend>
                            <label className="flex items-center gap-2">
                              <input
                                type="radio"
                                name={`when-${p.id}`}
                                checked={when === "end_of_month"}
                                onChange={() => setWhen("end_of_month")}
                              />
                              At the end of the month ({formatDay(monthEndLocal())}), already paid
                            </label>
                            <label className="flex items-center gap-2">
                              <input
                                type="radio"
                                name={`when-${p.id}`}
                                checked={when === "now"}
                                onChange={() => setWhen("now")}
                              />
                              Right away
                            </label>
                          </fieldset>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            type="submit"
                            variant="destructive"
                            size="sm"
                            disabled={act.isPending || !handTo}
                          >
                            Remove {p.name}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setRemoving(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </form>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>

        {canManage && inactive.length > 0 && (
          <div className="mt-4 rounded-md border">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium hover:bg-muted/50"
              aria-expanded={showInactive}
              onClick={() => setShowInactive((v) => !v)}
            >
              <span>Inactive people ({inactive.length})</span>
              <span className="text-xs font-normal text-muted-foreground">
                {showInactive ? "Hide" : "Show"}
              </span>
            </button>
            {showInactive && (
              <ul className="divide-y border-t">
                {inactive.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">
                        {p.name}{" "}
                        <span className="font-normal text-muted-foreground">· {p.email}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {p.role}
                        {p.endedAt && ` · left ${formatDate(p.endedAt)}`}
                        {p.handToName && ` · records went to ${p.handToName}`}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={act.isPending}
                      onClick={() =>
                        act.mutate({
                          call: () => api("POST", `/api/people/${p.id}/reinstate`),
                          done: `${p.name} is active again as ${/^[AEIOU]/i.test(p.role) ? "an" : "a"} ${p.role}. If they were removed from sign-in too, invite them again.`,
                        })
                      }
                    >
                      Reinstate
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <dl className="mt-4 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
          <div>
            <dt className="inline font-medium text-foreground">Admin: </dt>
            <dd className="inline">everything, including settings, users and billing.</dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">Manager: </dt>
            <dd className="inline">all records, delete, export, and other people's queues.</dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">Rep: </dt>
            <dd className="inline">view and edit all records, run their own queue. No delete.</dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">Read-only: </dt>
            <dd className="inline">view records and reports only.</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
