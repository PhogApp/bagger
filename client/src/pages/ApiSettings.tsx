import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, CircleAlert, Copy, KeyRound, Send, Webhook } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { canUse, useApi, useMe } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn, formatDateTime } from "@/lib/utils";

/**
 * Admin › API and webhooks: keys for other systems to use Bagger's API, and
 * the API's documentation.
 */

interface ApiKey {
  id: string;
  name: string;
  access: "read" | "read_write";
  prefix: string;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const apiBase = () => `${window.location.origin}/api/v1`;

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.warning("Couldn't copy; select the text and copy it instead");
        }
      }}
    >
      {copied ? (
        <Check className="mr-1.5 h-4 w-4" aria-hidden />
      ) : (
        <Copy className="mr-1.5 h-4 w-4" aria-hidden />
      )}
      {copied ? "Copied" : label}
    </Button>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-background">
      <div className="border-b p-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

function ApiKeys() {
  const api = useApi();
  const queryClient = useQueryClient();
  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api<ApiKey[]>("GET", "/api/api-keys"),
  });
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"read" | "read_write">("read_write");
  const [made, setMade] = useState<{ name: string; key: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api<{ name: string; key: string }>("POST", "/api/api-keys", { name, access }),
    onSuccess: async (r) => {
      setMade({ name: r.name, key: r.key });
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api("DELETE", `/api/api-keys/${id}`),
    onSuccess: async () => {
      toast.success("Key revoked");
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const live = (keys.data ?? []).filter((k) => !k.revokedAt);
  const revoked = (keys.data ?? []).filter((k) => k.revokedAt);

  return (
    <Panel
      title="API keys"
      description="One key per system that connects to Bagger, so each can be revoked on its own. A key can do everything an Admin can with records, or only read them."
    >
      {made && (
        <div
          role="status"
          className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950"
        >
          <p className="font-medium">
            Your new key "{made.name}". Copy it now: Bagger won't show it again.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1.5 font-mono text-xs">
              {made.key}
            </code>
            <CopyButton text={made.key} />
          </div>
          <p className="text-xs">
            Keep it somewhere safe, like the other system's settings or a password manager. Anyone
            with it can use your Bagger data.
          </p>
          <button
            type="button"
            className="text-xs font-medium underline"
            onClick={() => setMade(null)}
          >
            I've copied it
          </button>
        </div>
      )}

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label className="min-w-48 flex-1 space-y-1 text-sm">
          <span className="block font-medium">Name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What will use it, e.g. Zapier"
            maxLength={80}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block font-medium">Can</span>
          <select
            value={access}
            onChange={(e) => setAccess(e.target.value as "read" | "read_write")}
            className="flex h-10 rounded-md border border-input bg-background px-3 pr-9 text-sm"
          >
            <option value="read_write">Read and change records</option>
            <option value="read">Only read records</option>
          </select>
        </label>
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          <KeyRound className="mr-1.5 h-4 w-4" aria-hidden />
          Create key
        </Button>
      </form>

      {keys.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : live.length === 0 ? (
        <p className="text-sm text-muted-foreground">No keys yet.</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {live.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0">
                <span className="font-medium">{k.name}</span>{" "}
                <span className="font-mono text-xs text-muted-foreground">{k.prefix}…</span>
                <span className="block text-xs text-muted-foreground">
                  {k.access === "read" ? "Only reads" : "Reads and changes"} · made by{" "}
                  {k.createdBy ?? "someone who has left"} {formatDateTime(k.createdAt)} ·{" "}
                  {k.lastUsedAt ? `last used ${formatDateTime(k.lastUsedAt)}` : "never used"}
                </span>
              </span>
              {revoking === k.id ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs">Anything using it stops working.</span>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(k.id)}
                  >
                    Revoke
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(null)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-destructive hover:underline"
                  onClick={() => setRevoking(k.id)}
                >
                  Revoke…
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revoked.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {revoked.length} revoked {revoked.length === 1 ? "key" : "keys"}
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {revoked.map((k) => (
              <li key={k.id}>
                {k.name} <span className="font-mono">{k.prefix}…</span>, revoked{" "}
                {formatDateTime(k.revokedAt!)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}

export function ApiSettingsPage() {
  const { data: me } = useMe();
  if (me && !canUse(me, "setup.api")) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Admins only</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask an admin in your organization for an API key.
        </p>
      </div>
    );
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
        <h1 className="text-2xl font-semibold tracking-tight">API and webhooks</h1>
      </div>
      <div className="max-w-4xl space-y-6 p-6">
        <Panel
          title="Bagger's API"
          description="Other systems can read and change your leads, contacts, accounts, opportunities and activities, and enroll people in sequences."
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Address</span>
            <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{apiBase()}</code>
            <CopyButton text={apiBase()} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/api/docs" className={cn(buttonVariants({ variant: "outline" }))}>
              Read the documentation
            </Link>
            <a
              href="/api/v1/openapi.json"
              download="bagger-openapi.json"
              className={cn(buttonVariants({ variant: "ghost" }))}
            >
              Download the OpenAPI file
            </a>
          </div>
        </Panel>
        <ApiKeys />
        <Webhooks />
      </div>
    </div>
  );
}

// ------------------------------------------------------------ webhooks

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  status: "active" | "disabled";
  disabledReason: string | null;
  failingSince: string | null;
  createdBy: string | null;
  createdAt: string;
  viaApi: boolean;
  lastDelivery: { status: string; code: number | null; at: string } | null;
}
interface Delivery {
  id: string;
  eventType: string;
  eventId: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
}

const RECORDS = [
  ["lead", "Leads"],
  ["contact", "Contacts"],
  ["account", "Accounts"],
  ["opportunity", "Opportunities"],
  ["activity", "Activities"],
] as const;
const ACTIONS = ["created", "updated", "deleted"] as const;

function eventsText(events: string[]): string {
  if (events.length === 0) return "Every change";
  return events.join(", ");
}

function EventPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const all = value.length === 0;
  const toggle = (e: string) =>
    onChange(value.includes(e) ? value.filter((x) => x !== e) : [...value, e]);
  return (
    <fieldset className="space-y-2 text-sm">
      <legend className="font-medium">Send</legend>
      <label className="flex items-center gap-2">
        <input type="radio" checked={all} onChange={() => onChange([])} />
        Every change to leads, contacts, accounts, opportunities and activities
      </label>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          checked={!all}
          onChange={() => onChange(all ? ["contact.created"] : value)}
        />
        Only these:
      </label>
      {!all && (
        <div className="grid gap-x-4 gap-y-1 pl-6 sm:grid-cols-[auto_repeat(3,auto)] sm:justify-start">
          {RECORDS.map(([type, label]) => (
            <div key={type} className="contents">
              <span className="text-muted-foreground">{label}</span>
              {ACTIONS.map((a) => (
                <label key={a} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={value.includes(`${type}.${a}`)}
                    onChange={() => toggle(`${type}.${a}`)}
                  />
                  {a}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function DeliveryLog({ endpointId }: { endpointId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const log = useQuery({
    queryKey: ["webhooks", endpointId, "deliveries"],
    queryFn: () => api<Delivery[]>("GET", `/api/webhooks/${endpointId}/deliveries`),
    refetchInterval: 5000,
  });
  const resend = useMutation({
    mutationFn: (id: string) => api("POST", `/api/webhook-deliveries/${id}/resend`),
    onSuccess: async () => {
      toast.success("Sending again");
      await queryClient.invalidateQueries({ queryKey: ["webhooks", endpointId, "deliveries"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (log.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!log.data?.length) return <p className="text-sm text-muted-foreground">Nothing sent yet.</p>;
  return (
    <ul className="divide-y rounded-md border text-sm">
      {log.data.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
          <span className="min-w-0">
            <span className="font-mono text-xs">{d.eventType}</span>{" "}
            <span
              className={cn(
                "text-xs",
                d.status === "delivered"
                  ? "text-emerald-700"
                  : d.status === "failed"
                    ? "text-destructive"
                    : "text-amber-700",
              )}
            >
              {d.status === "delivered"
                ? `Delivered${d.lastStatusCode ? ` (${d.lastStatusCode})` : ""}`
                : d.status === "failed"
                  ? "Gave up"
                  : d.attempts > 0
                    ? `Trying again (${d.attempts} ${d.attempts === 1 ? "try" : "tries"})`
                    : "Sending"}
            </span>
            {d.lastError && d.status !== "delivered" && (
              <span className="block truncate text-xs text-muted-foreground">{d.lastError}</span>
            )}
          </span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {formatDateTime(d.createdAt)}
            {d.status === "failed" && (
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={() => resend.mutate(d.id)}
              >
                Send again
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function EndpointRow({ endpoint }: { endpoint: Endpoint }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["webhooks"] });
  const act = useMutation({
    mutationFn: (job: { method: string; path: string; body?: unknown; done: string }) =>
      api(job.method, job.path, job.body).then(() => job.done),
    onSuccess: async (done) => {
      if (done) toast.success(done);
      setConfirming(false);
      await refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reveal = useMutation({
    mutationFn: () => api<{ secret: string }>("POST", `/api/webhooks/${endpoint.id}/secret`),
    onSuccess: (r) => setSecret(r.secret),
    onError: (e: Error) => toast.error(e.message),
  });
  const failing = endpoint.status === "active" && endpoint.failingSince;
  return (
    <li className="space-y-3 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-xs">{endpoint.url}</span>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs font-medium",
                endpoint.status === "disabled"
                  ? "border-slate-300 bg-slate-100 text-slate-700"
                  : failing
                    ? "border-amber-300 bg-amber-50 text-amber-800"
                    : "border-emerald-200 bg-emerald-50 text-emerald-800",
              )}
            >
              {endpoint.status === "disabled" ? "Off" : failing ? "Failing" : "On"}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {endpoint.description ? `${endpoint.description} · ` : ""}
            {eventsText(endpoint.events)}
            {endpoint.viaApi
              ? " · added through the API"
              : endpoint.createdBy
                ? ` · added by ${endpoint.createdBy}`
                : ""}
          </p>
          {endpoint.disabledReason && endpoint.status === "disabled" && (
            <p className="text-xs text-muted-foreground">{endpoint.disabledReason}</p>
          )}
          {failing && (
            <p className="flex items-center gap-1 text-xs text-amber-800">
              <CircleAlert className="h-3.5 w-3.5" aria-hidden />
              Not answering since {formatDateTime(endpoint.failingSince!)}. Bagger keeps trying;
              after 3 days it switches the webhook off.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={act.isPending}
            onClick={() =>
              act.mutate({
                method: "POST",
                path: `/api/webhooks/${endpoint.id}/test`,
                done: "Test event sent",
              })
            }
          >
            <Send className="mr-1.5 h-4 w-4" aria-hidden />
            Send test
          </Button>
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Less" : "More"}
          </Button>
        </div>
      </div>
      {open && (
        <div className="space-y-3 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Signing secret</span>
            {secret ? (
              <>
                <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {secret}
                </code>
                <CopyButton text={secret} />
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => reveal.mutate()}>
                Show
              </Button>
            )}
          </div>
          <DeliveryLog endpointId={endpoint.id} />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() =>
                act.mutate({
                  method: "PATCH",
                  path: `/api/webhooks/${endpoint.id}`,
                  body: { status: endpoint.status === "active" ? "disabled" : "active" },
                  done:
                    endpoint.status === "active" ? "Webhook switched off" : "Webhook switched on",
                })
              }
            >
              {endpoint.status === "active" ? "Switch off" : "Switch on"}
            </button>
            {confirming ? (
              <span className="flex items-center gap-2">
                <span>Delete this webhook and its log?</span>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    act.mutate({
                      method: "DELETE",
                      path: `/api/webhooks/${endpoint.id}`,
                      done: "Webhook deleted",
                    })
                  }
                >
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive hover:underline"
                onClick={() => setConfirming(true)}
              >
                Delete…
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function Webhooks() {
  const api = useApi();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["webhooks"],
    queryFn: () => api<Endpoint[]>("GET", "/api/webhooks"),
    refetchInterval: 15_000,
  });
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [made, setMade] = useState<{ url: string; secret: string } | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api<{ url: string; secret: string }>("POST", "/api/webhooks", { url, description, events }),
    onSuccess: async (r) => {
      setMade({ url: r.url, secret: r.secret });
      setAdding(false);
      setUrl("");
      setDescription("");
      setEvents([]);
      await queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Panel
      title="Webhooks"
      description="Bagger tells another system's address the moment records change: created, updated or deleted. Each message is signed so the receiver can tell it came from Bagger."
    >
      {made && (
        <div
          role="status"
          className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950"
        >
          <p className="font-medium">Webhook added. Its signing secret:</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1.5 font-mono text-xs">
              {made.secret}
            </code>
            <CopyButton text={made.secret} />
          </div>
          <p className="text-xs">
            Give it to whoever runs the receiving end, to check each message's Bagger-Signature. You
            can see it again under More.
          </p>
          <button
            type="button"
            className="text-xs font-medium underline"
            onClick={() => setMade(null)}
          >
            Done
          </button>
        </div>
      )}
      {adding ? (
        <form
          className="space-y-3 rounded-md border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="block space-y-1 text-sm">
            <span className="block font-medium">Send to</span>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hooks.example.com/bagger"
              inputMode="url"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="block font-medium">Description (optional)</span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. New contacts to our warehouse"
              maxLength={200}
            />
          </label>
          <EventPicker value={events} onChange={setEvents} />
          <div className="flex gap-2">
            <Button type="submit" disabled={!url.trim() || create.isPending}>
              Add webhook
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Webhook className="mr-1.5 h-4 w-4" aria-hidden />
          Add webhook
        </Button>
      )}
      {list.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.data?.length ? (
        <ul className="divide-y rounded-md border">
          {list.data.map((e) => (
            <EndpointRow key={e.id} endpoint={e} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No webhooks yet.</p>
      )}
      <p className="text-xs text-muted-foreground">
        How to receive them, check the signature, and what each message holds:{" "}
        <Link href="/admin/api/docs#webhooks" className="text-primary hover:underline">
          webhook documentation
        </Link>
        .
      </p>
    </Panel>
  );
}
