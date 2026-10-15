import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, CircleAlert, Plug, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { canUse, useApi, useMe } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn, formatDateTime } from "@/lib/utils";

/**
 * Admin › Integrations: the outside services Bagger connects to, what each
 * one syncs and in which direction, syncing now, the sync log, and
 * disconnecting.
 */

type Direction = "both" | "pull" | "push" | "off";
interface Service {
  id: string;
  name: string;
  category: string;
  description: string;
  available: boolean;
  objects: { recordType: "account" | "contact"; label: string }[];
  connection: {
    id: string;
    status: "connected" | "error" | "paused";
    accountLabel: string | null;
    connectedBy: string | null;
    connectedAt: string;
    lastSyncAt: string | null;
    lastError: string | null;
    objects: Partial<Record<"account" | "contact", Direction>>;
  } | null;
}
interface Overview {
  enabled: boolean;
  services: Service[];
}
interface Run {
  id: string;
  status: "running" | "done" | "failed";
  counts: Record<"pulled" | "pushed", Record<string, Record<string, number>>> | null;
  errors: { object: string; id?: string; message: string }[] | null;
  startedAt: string;
  finishedAt: string | null;
}

const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: "both", label: "Both ways" },
  { value: "pull", label: "Into Bagger only" },
  { value: "push", label: "Out of Bagger only" },
  { value: "off", label: "Off" },
];
const NOUN: Record<string, [string, string]> = {
  account: ["account", "accounts"],
  contact: ["contact", "contacts"],
  sync: ["sync", "syncs"],
};
const plural = (n: number, type: string) => `${n} ${NOUN[type]?.[n === 1 ? 0 : 1] ?? type}`;

/** "In: 3 contacts created, 1 account updated. Out: 2 contacts created." */
function summary(run: Run): string {
  if (!run.counts) return run.status === "running" ? "Syncing…" : "";
  const part = (way: "pulled" | "pushed") =>
    Object.entries(run.counts![way] ?? {})
      .flatMap(([type, what]) =>
        Object.entries(what)
          .filter(([w]) => w !== "unchanged")
          .map(([w, n]) => `${plural(n, type)} ${w}`),
      )
      .join(", ");
  const inn = part("pulled");
  const out = part("pushed");
  const text = [inn && `In: ${inn}.`, out && `Out: ${out}.`].filter(Boolean).join(" ");
  return text || "Nothing to change.";
}

function useIntegrations() {
  const api = useApi();
  return useQuery({
    queryKey: ["integrations"],
    queryFn: () => api<Overview>("GET", "/api/integrations"),
    // While a sync is likely running, check back.
    refetchInterval: 10_000,
  });
}

function SyncLog({ connectionId }: { connectionId: string }) {
  const api = useApi();
  const runs = useQuery({
    queryKey: ["integrations", connectionId, "runs"],
    queryFn: () => api<Run[]>("GET", `/api/integrations/connections/${connectionId}/runs`),
    refetchInterval: 10_000,
  });
  if (runs.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!runs.data?.length) return <p className="text-sm text-muted-foreground">No syncs yet.</p>;
  return (
    <ul className="divide-y rounded-md border text-sm">
      {runs.data.map((r) => (
        <li key={r.id} className="space-y-1 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              {r.status === "failed" ? (
                <CircleAlert className="h-4 w-4 text-destructive" aria-hidden />
              ) : r.status === "done" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
              ) : (
                <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
              )}
              {summary(r)}
            </span>
            <span className="text-xs text-muted-foreground">{formatDateTime(r.startedAt)}</span>
          </div>
          {r.errors && r.errors.length > 0 && (
            <ul className="space-y-0.5 pl-6 text-xs text-destructive">
              {r.errors.slice(0, 5).map((e, i) => (
                <li key={i}>
                  {e.object === "sync" ? "" : `${NOUN[e.object]?.[0] ?? e.object} ${e.id ?? ""}: `}
                  {e.message}
                </li>
              ))}
              {r.errors.length > 5 && <li>…and {r.errors.length - 5} more</li>}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function ServiceCard({ service, enabled }: { service: Service; enabled: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const conn = service.connection;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["integrations"] });

  const connect = useMutation({
    mutationFn: () => api<{ url: string }>("POST", `/api/integrations/${service.id}/connect`),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e: Error) => toast.error(e.message),
  });
  const syncNow = useMutation({
    mutationFn: () => api("POST", `/api/integrations/connections/${conn!.id}/sync`),
    onSuccess: async () => {
      toast.success(`Syncing with ${service.name}`);
      setShowLog(true);
      await refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const setDirection = useMutation({
    mutationFn: (objects: Record<string, Direction>) =>
      api("PATCH", `/api/integrations/connections/${conn!.id}`, { objects }),
    onSuccess: async () => {
      toast.success("Saved");
      await refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const disconnect = useMutation({
    mutationFn: () => api("DELETE", `/api/integrations/connections/${conn!.id}`),
    onSuccess: async () => {
      toast.success(`${service.name} disconnected`);
      setConfirming(false);
      await refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const status = conn
    ? conn.status === "connected"
      ? { text: "Connected", tone: "bg-emerald-50 text-emerald-800 border-emerald-200" }
      : { text: "Needs reconnecting", tone: "bg-red-50 text-red-800 border-red-200" }
    : service.available
      ? null
      : { text: "Coming soon", tone: "bg-slate-50 text-slate-600 border-slate-200" };

  return (
    <section className="rounded-lg border bg-background">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{service.name}</h3>
            {status && (
              <span
                className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", status.tone)}
              >
                {status.text}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{service.description}</p>
          {conn && (
            <p className="text-xs text-muted-foreground">
              {conn.accountLabel ?? "Connected"}
              {conn.connectedBy && ` · connected by ${conn.connectedBy}`}
              {conn.lastSyncAt
                ? ` · last synced ${formatDateTime(conn.lastSyncAt)}`
                : " · first sync on its way"}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {!conn && service.available && (
            <Button
              size="sm"
              disabled={!enabled || connect.isPending}
              onClick={() => connect.mutate()}
            >
              <Plug className="mr-1.5 h-4 w-4" aria-hidden />
              Connect
            </Button>
          )}
          {conn?.status === "error" && (
            <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>
              Reconnect
            </Button>
          )}
          {conn?.status === "connected" && (
            <Button
              size="sm"
              variant="outline"
              disabled={syncNow.isPending}
              onClick={() => syncNow.mutate()}
            >
              <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
              Sync now
            </Button>
          )}
        </div>
      </div>

      {conn && (
        <div className="space-y-4 border-t p-4">
          {conn.lastError && (
            <p
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900"
            >
              {conn.status === "error"
                ? `${service.name} stopped accepting Bagger's connection: ${conn.lastError}. Reconnect to carry on; nothing is lost.`
                : `The last sync had a problem: ${conn.lastError}. It will try again.`}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {service.objects.map((o) => (
              <label key={o.recordType} className="space-y-1 text-sm">
                <span className="block font-medium">{o.label}</span>
                <select
                  value={conn.objects[o.recordType] ?? "both"}
                  onChange={(e) =>
                    setDirection.mutate({ [o.recordType]: e.target.value as Direction })
                  }
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 pr-9 text-sm"
                >
                  {DIRECTIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Syncs every 15 minutes. Records are matched by email (contacts) and by name or website
            (accounts) so nothing is duplicated; when a record changed on both sides, the more
            recent change wins. Deleting isn't synced. Changes from {service.name} show in History
            as "via {service.name}".
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              className="text-sm font-medium text-primary hover:underline"
              aria-expanded={showLog}
              onClick={() => setShowLog(!showLog)}
            >
              {showLog ? "Hide sync log" : "Show sync log"}
            </button>
            {confirming ? (
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <span>Stop syncing? Records stay in Bagger.</span>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                >
                  Disconnect
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
              </span>
            ) : (
              <button
                type="button"
                className="text-sm text-muted-foreground hover:text-destructive hover:underline"
                onClick={() => setConfirming(true)}
              >
                Disconnect…
              </button>
            )}
          </div>
          {showLog && <SyncLog connectionId={conn.id} />}
        </div>
      )}
    </section>
  );
}

export function IntegrationsPage() {
  const { data: me } = useMe();
  const overview = useIntegrations();
  if (me && !canUse(me, "setup.integrations")) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Admins only</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask an admin in your organization to connect other services.
        </p>
      </div>
    );
  }
  const groups = new Map<string, Service[]>();
  for (const s of overview.data?.services ?? []) {
    groups.set(s.category, [...(groups.get(s.category) ?? []), s]);
  }
  return (
    <div>
      <div className="space-y-1 border-b bg-background px-6 py-4">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Admin
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
      </div>
      <div className="max-w-4xl space-y-6 p-6">
        {overview.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {overview.error && <p className="text-sm text-destructive">{overview.error.message}</p>}
        {overview.data && !overview.data.enabled && (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Integrations aren't switched on for this server yet. Services can be connected once they
            are.
          </p>
        )}
        {[...groups.entries()].map(([category, services]) => (
          <div key={category} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {category}
            </h2>
            {services.map((s) => (
              <ServiceCard key={s.id} service={s} enabled={overview.data!.enabled} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Back from a service's sign-in page (/integrations/callback?code=…&state=…):
 * finish connecting, then show the Integrations page.
 */
export function IntegrationCallbackPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const done = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setProblem(
        params.get("error_description") ?? params.get("error") ?? "The sign-in didn't finish.",
      );
      return;
    }
    api<{ name: string; accountLabel: string | null; reconnected: boolean }>(
      "POST",
      "/api/integrations/callback",
      { code, state },
    )
      .then(async (r) => {
        toast.success(
          `${r.name} ${r.reconnected ? "reconnected" : "connected"}${r.accountLabel ? ` (${r.accountLabel})` : ""}. The first sync has started.`,
        );
        await queryClient.invalidateQueries({ queryKey: ["integrations"] });
        navigate("/admin/integrations", { replace: true });
      })
      .catch((e: Error) => setProblem(e.message));
  }, [api, navigate, queryClient]);
  return (
    <div className="p-10 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        {problem ? "Couldn't connect" : "Connecting…"}
      </h1>
      {problem && (
        <>
          <p className="mt-2 text-sm text-muted-foreground">{problem}</p>
          <Link
            href="/admin/integrations"
            className="mt-4 inline-block text-sm text-primary hover:underline"
          >
            Back to Integrations
          </Link>
        </>
      )}
    </div>
  );
}
