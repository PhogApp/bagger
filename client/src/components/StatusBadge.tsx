import { cn } from "@/lib/utils";

const TONES: Record<string, string> = {
  New: "bg-blue-100 text-blue-800",
  Active: "bg-emerald-100 text-emerald-800",
  Customer: "bg-emerald-100 text-emerald-800",
  Prospecting: "bg-amber-100 text-amber-800",
  Partner: "bg-violet-100 text-violet-800",
  Vendor: "bg-slate-100 text-slate-700",
  Inactive: "bg-slate-100 text-slate-700",
  "Not Interested": "bg-slate-100 text-slate-700",
  "Do Not Contact": "bg-red-100 text-red-800",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium",
        TONES[status] ?? "bg-slate-100 text-slate-700",
      )}
    >
      {status}
    </span>
  );
}
