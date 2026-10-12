import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Building blocks shared by the dashboard and the reports. */

export function Panel(props: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border bg-background", props.className)}>
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{props.title}</h2>
        {props.action}
      </div>
      <div className="p-4">{props.children}</div>
    </section>
  );
}

/** One headline number. */
export function Stat(props: { label: string; value: string; note?: string; tone?: "alert" }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{props.label}</dt>
      <dd
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          props.tone === "alert" && "text-destructive",
        )}
      >
        {props.value}
      </dd>
      {props.note && <dd className="text-xs text-muted-foreground">{props.note}</dd>}
    </div>
  );
}

/**
 * Horizontal bars for one measure across a few categories. One hue, because
 * the bars compare size, not identity; every bar carries its own label and
 * value, and hovering shows the exact figures.
 */
export function Bars(props: {
  rows: { label: string; value: number; display: string; detail: string }[];
  empty: string;
}) {
  const max = Math.max(0, ...props.rows.map((r) => r.value));
  if (props.rows.length === 0 || max === 0) {
    return <p className="text-sm text-muted-foreground">{props.empty}</p>;
  }
  return (
    <ul className="space-y-2.5">
      {props.rows.map((r) => (
        <li
          key={r.label}
          title={r.detail}
          className="grid grid-cols-[8rem_1fr_6rem] items-center gap-3 text-sm"
        >
          <span className="truncate text-muted-foreground">{r.label}</span>
          <span className="h-3 rounded-r bg-muted/60" aria-hidden>
            <span
              className="block h-3 rounded-r bg-brand-ocean"
              style={{
                width: `${Math.max(r.value > 0 ? 2 : 0, (r.value / max) * 100)}%`,
              }}
            />
          </span>
          <span className="text-right font-medium tabular-nums">{r.display}</span>
        </li>
      ))}
    </ul>
  );
}
