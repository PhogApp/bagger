import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  CircleDollarSign,
  Search,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The search box at the top of every page. Typing shows the first few
 * matching leads, contacts, accounts and opportunities; arrow keys and Enter
 * open one, and "See all" opens that list already searched. "/" jumps here
 * from anywhere that isn't a text box.
 */

type SearchObject = "leads" | "contacts" | "accounts" | "opportunities";
interface SearchGroup {
  object: SearchObject;
  total: number;
  hits: { id: string; title: string; detail: string | null }[];
}

const GROUPS: Record<SearchObject, { label: string; icon: LucideIcon }> = {
  leads: { label: "Leads", icon: UserPlus },
  contacts: { label: "Contacts", icon: Users },
  accounts: { label: "Accounts", icon: Building2 },
  opportunities: { label: "Opportunities", icon: CircleDollarSign },
};

/** One thing the keyboard can land on: a record, or a group's "See all". */
interface Target {
  key: string;
  path: string;
}

export function GlobalSearch() {
  const api = useApi();
  const [, navigate] = useLocation();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 200);
    return () => clearTimeout(timer);
  }, [text]);

  // "/" focuses the box unless someone is typing somewhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A click anywhere else closes the results.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const results = useQuery({
    queryKey: ["search", q],
    enabled: q.length >= 2,
    queryFn: () => api<SearchGroup[]>("GET", `/api/search?q=${encodeURIComponent(q)}`),
    placeholderData: (previous) => previous,
  });
  const groups = (q.length >= 2 ? results.data : undefined) ?? [];
  const found = groups.filter((g) => g.total > 0);
  const seeAll = (g: SearchGroup) => `/${g.object}?q=${encodeURIComponent(q)}`;
  const targets: Target[] = found.flatMap((g) => [
    ...g.hits.map((h) => ({ key: h.id, path: `/${g.object}/${h.id}` })),
    ...(g.total > g.hits.length ? [{ key: `all-${g.object}`, path: seeAll(g) }] : []),
  ]);
  useEffect(() => setActive(0), [q]);

  const go = (path: string) => {
    setOpen(false);
    setText("");
    input.current?.blur();
    navigate(path);
  };
  const indexOf = (key: string) => targets.findIndex((t) => t.key === key);
  const showPanel = open && q.length >= 2;

  return (
    <div ref={box} className="relative w-full max-w-xl">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls="global-search-results"
        aria-activedescendant={
          showPanel && targets[active] ? `gs-${targets[active].key}` : undefined
        }
        aria-label="Search Bagger"
        placeholder="Search leads, contacts, accounts, opportunities…"
        className="h-10 w-full rounded-md border border-input bg-muted/40 pl-9 pr-10 text-sm focus-visible:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, Math.max(targets.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && targets[active]) {
            e.preventDefault();
            go(targets[active].path);
          }
        }}
      />
      {!text && (
        <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border bg-background px-1.5 text-xs text-muted-foreground">
          /
        </kbd>
      )}
      {showPanel && (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute left-0 right-0 top-12 z-30 max-h-[70vh] overflow-y-auto rounded-md border bg-background p-1 shadow-lg"
        >
          {results.isLoading && !results.data ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
          ) : found.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">Nothing matches “{q}”.</p>
          ) : (
            found.map((g) => {
              const { label, icon: Icon } = GROUPS[g.object];
              return (
                <div key={g.object} className="py-1" role="group" aria-label={label}>
                  <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {label} <span className="font-normal">({g.total.toLocaleString()})</span>
                  </p>
                  {g.hits.map((h) => {
                    const i = indexOf(h.id);
                    return (
                      <button
                        key={h.id}
                        id={`gs-${h.id}`}
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        className={cn(
                          "flex w-full items-center gap-3 rounded px-3 py-1.5 text-left text-sm",
                          i === active ? "bg-muted" : "hover:bg-muted/60",
                        )}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => go(`/${g.object}/${h.id}`)}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{h.title}</span>
                          {h.detail && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {h.detail}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                  {g.total > g.hits.length && (
                    <button
                      id={`gs-all-${g.object}`}
                      type="button"
                      role="option"
                      aria-selected={indexOf(`all-${g.object}`) === active}
                      className={cn(
                        "w-full rounded px-3 py-1.5 pl-10 text-left text-sm text-primary",
                        indexOf(`all-${g.object}`) === active ? "bg-muted" : "hover:bg-muted/60",
                      )}
                      onMouseEnter={() => setActive(indexOf(`all-${g.object}`))}
                      onClick={() => go(seeAll(g))}
                    >
                      See all {g.total.toLocaleString()} {label.toLowerCase()}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
