import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, KeyRound } from "lucide-react";
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
      </div>
    </div>
  );
}
