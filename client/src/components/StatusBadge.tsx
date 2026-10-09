import { cn } from "@/lib/utils";

// Tints of the brand palette, with dark text so every badge stays readable.
const TEAL = "bg-brand-teal/20 text-brand-deep";
const OCEAN = "bg-brand-ocean/15 text-brand-deep";
const SAGE = "bg-brand-sage/25 text-brand-deep";
const MAUVE = "bg-brand-mauve/25 text-[#4d3f48]";
const ROSE = "bg-brand-rose/30 text-[#6e3536]";
const NEUTRAL = "bg-slate-100 text-slate-700";

const TONES: Record<string, string> = {
  New: OCEAN,
  Active: TEAL,
  Customer: TEAL,
  Replied: TEAL,
  "Meeting booked": TEAL,
  Prospecting: SAGE,
  Partner: SAGE,
  Paused: MAUVE,
  Vendor: NEUTRAL,
  Inactive: NEUTRAL,
  Finished: NEUTRAL,
  "Not Interested": NEUTRAL,
  "Do Not Contact": ROSE,
  "Opted out": ROSE,
  Bounced: ROSE,
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium",
        TONES[status] ?? NEUTRAL,
      )}
    >
      {status}
    </span>
  );
}
