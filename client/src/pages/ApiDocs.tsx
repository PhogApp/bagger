import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { apiBase, CopyButton } from "./ApiSettings";

/**
 * The API's documentation, drawn from /api/v1/openapi.json: the same
 * description code generators and Postman use, made from the checks the API
 * actually runs, so it's always current.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Schema = Record<string, any>;
interface Operation {
  tags?: string[];
  summary: string;
  description?: string;
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: Schema;
  }[];
  requestBody?: { content: { "application/json": { schema: Schema } } };
  responses: Record<
    string,
    { description: string; content?: { "application/json": { schema: Schema } } }
  >;
}
interface Doc {
  info: { title: string; description: string };
  tags: { name: string; description?: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
}

const METHOD_TONE: Record<string, string> = {
  get: "bg-sky-50 text-sky-800 border-sky-200",
  post: "bg-emerald-50 text-emerald-800 border-emerald-200",
  patch: "bg-amber-50 text-amber-800 border-amber-200",
  delete: "bg-red-50 text-red-800 border-red-200",
};

function typeOf(s: Schema | undefined): string {
  if (!s) return "";
  if (s.$ref) return String(s.$ref).split("/").pop()!;
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (s.anyOf) return s.anyOf.map(typeOf).filter(Boolean).join(" or ");
  const t = Array.isArray(s.type)
    ? s.type.filter((x: string) => x !== "null").join(" or ")
    : s.type;
  const nullable = Array.isArray(s.type) && s.type.includes("null");
  const fmt =
    s.format && s.format !== "email" ? ` (${s.format})` : s.format === "email" ? " (email)" : "";
  return `${t ?? "any"}${fmt}${nullable ? ", or null" : ""}`;
}

function Fields({ schema, title }: { schema: Schema; title: string }) {
  const props = Object.entries((schema.properties ?? {}) as Record<string, Schema>);
  if (props.length === 0) return null;
  const required = new Set<string>(schema.required ?? []);
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <tbody className="divide-y">
            {props.map(([name, s]) => (
              <tr key={name}>
                <td className="whitespace-nowrap px-3 py-1.5 align-top font-mono text-xs">
                  {name}
                  {required.has(name) && <span className="ml-1 text-destructive">*</span>}
                </td>
                <td className="px-3 py-1.5 align-top text-xs text-muted-foreground">{typeOf(s)}</td>
                <td className="px-3 py-1.5 align-top text-xs">{s.description ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function curlFor(method: string, path: string, op: Operation): string {
  const url = `${apiBase()}${path.replace("{id}", "<id>")}`;
  const lines = [
    `curl${method === "get" ? "" : ` -X ${method.toUpperCase()}`} "${url}"`,
    `  -H "Authorization: Bearer $BAGGER_API_KEY"`,
  ];
  if (op.requestBody) {
    const schema = op.requestBody.content["application/json"].schema;
    const example: Record<string, string> = {};
    const names: string[] = schema.required?.length
      ? schema.required.slice(0, 4)
      : Object.keys(schema.properties ?? {}).filter((n) => n !== "custom").slice(2, 3);
    for (const name of names) example[name] = "…";
    lines.push(`  -H "Content-Type: application/json"`, `  -d '${JSON.stringify(example)}'`);
  }
  return lines.join(" \\\n");
}

function Endpoint({ method, path, op }: { method: string; path: string; op: Operation }) {
  const ok = Object.entries(op.responses).find(([code]) => code.startsWith("2"));
  const okSchema = ok?.[1].content?.["application/json"].schema;
  const params = (op.parameters ?? []).filter((p) => p.in !== "path");
  const curl = curlFor(method, path, op);
  return (
    <section id={`${method}-${path}`} className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded border px-2 py-0.5 font-mono text-xs font-semibold uppercase",
            METHOD_TONE[method],
          )}
        >
          {method}
        </span>
        <code className="font-mono text-sm">{path}</code>
        <span className="text-sm text-muted-foreground">· {op.summary}</span>
      </div>
      {op.description && <p className="text-sm">{op.description}</p>}
      {params.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Options
          </h4>
          <ul className="space-y-1 text-sm">
            {params.map((p) => (
              <li key={`${p.in}-${p.name}`}>
                <code className="font-mono text-xs">{p.name}</code>
                <span className="text-xs text-muted-foreground">
                  {" "}
                  ({p.in === "header" ? "header" : "query"}, {typeOf(p.schema)})
                </span>
                {p.description && <span className="text-xs"> {p.description}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {op.requestBody && (
        <Fields schema={op.requestBody.content["application/json"].schema} title="Send" />
      )}
      {ok && (
        <p className="text-sm">
          <span className="font-mono text-xs">{ok[0]}</span>{" "}
          <span className="text-muted-foreground">
            {ok[1].description}
            {okSchema && ` (${typeOf(okSchema.properties?.data?.items ?? okSchema)})`}
          </span>
        </p>
      )}
      <div className="relative">
        <pre className="overflow-x-auto rounded-md bg-slate-950 p-3 pr-24 font-mono text-xs text-slate-100">
          {curl}
        </pre>
        <div className="absolute right-2 top-2">
          <CopyButton text={curl} />
        </div>
      </div>
    </section>
  );
}

export function ApiDocsPage() {
  const doc = useQuery({
    queryKey: ["openapi"],
    queryFn: async () => (await fetch("/api/v1/openapi.json")).json() as Promise<Doc>,
    staleTime: Infinity,
  });
  const d = doc.data;
  const byTag = new Map<string, { method: string; path: string; op: Operation }[]>();
  for (const [path, ops] of Object.entries(d?.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      const tag = op.tags?.[0] ?? "Other";
      byTag.set(tag, [...(byTag.get(tag) ?? []), { method, path, op }]);
    }
  }
  const tags = (d?.tags ?? []).map((t) => t.name).filter((t) => byTag.has(t));
  return (
    <div>
      <div className="space-y-1 border-b bg-background px-6 py-4">
        <Link
          href="/admin/api"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> API and webhooks
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">API documentation</h1>
      </div>
      <div className="flex gap-8 p-6">
        <nav
          aria-label="Sections"
          className="sticky top-6 hidden w-44 shrink-0 self-start lg:block"
        >
          <ul className="space-y-1 text-sm">
            <li>
              <a href="#start" className="text-muted-foreground hover:text-foreground">
                Getting started
              </a>
            </li>
            {tags.map((t) => (
              <li key={t}>
                <a href={`#tag-${t}`} className="text-muted-foreground hover:text-foreground">
                  {t}
                </a>
              </li>
            ))}
            <li>
              <a href="#models" className="text-muted-foreground hover:text-foreground">
                What records look like
              </a>
            </li>
          </ul>
        </nav>
        <div className="min-w-0 max-w-4xl flex-1 space-y-8">
          {doc.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {d && (
            <>
              <section id="start" className="space-y-3 text-sm">
                <h2 className="text-lg font-semibold">Getting started</h2>
                <p>{d.info.description}</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Address: <code className="font-mono text-xs">{apiBase()}</code>
                  </li>
                  <li>
                    Every request sends a key from{" "}
                    <Link href="/admin/api" className="text-primary hover:underline">
                      API and webhooks
                    </Link>
                    : <code className="font-mono text-xs">Authorization: Bearer bgr_…</code>
                  </li>
                  <li>
                    Lists come a page at a time, oldest change first: follow{" "}
                    <code className="font-mono text-xs">nextCursor</code> until it's null. To keep
                    another system in step, remember the last{" "}
                    <code className="font-mono text-xs">updatedAt</code> you saw and ask with{" "}
                    <code className="font-mono text-xs">updatedSince</code>.
                  </li>
                  <li>
                    Send an <code className="font-mono text-xs">Idempotency-Key</code> header on
                    writes you might retry, so a retry never creates a record twice.
                  </li>
                  <li>
                    Status, owner and custom fields: see Reference for your statuses, users and
                    custom field keys.
                  </li>
                </ul>
              </section>
              {tags.map((t) => (
                <section key={t} id={`tag-${t}`} className="space-y-3">
                  <h2 className="text-lg font-semibold">{t}</h2>
                  {d.tags.find((x) => x.name === t)?.description && (
                    <p className="text-sm text-muted-foreground">
                      {d.tags.find((x) => x.name === t)!.description}
                    </p>
                  )}
                  {byTag.get(t)!.map((e) => (
                    <Endpoint key={`${e.method} ${e.path}`} {...e} />
                  ))}
                </section>
              ))}
              <section id="models" className="space-y-4">
                <h2 className="text-lg font-semibold">What records look like</h2>
                {Object.entries(d.components.schemas)
                  .filter(([name]) => name !== "Error")
                  .map(([name, schema]) => (
                    <div key={name} className="space-y-1">
                      <h3 className="font-medium">{name}</h3>
                      <Fields schema={schema} title="Fields" />
                    </div>
                  ))}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
