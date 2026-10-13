import { CheckCircle2, CircleAlert, TriangleAlert, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * The one way Bagger says an action worked or didn't: a short message in the
 * bottom corner. Successes fade on their own (a little later when they offer
 * Undo); warnings stay longer; errors stay until closed.
 *
 *   toast.success("Lead deleted")
 *   toast.success("Email saved", { undo: () => putBack() })
 *   toast.warning("10 updated. 2 skipped: …")
 *   toast.error(e.message)
 */

type Tone = "success" | "warning" | "error";

interface Toast {
  id: number;
  tone: Tone;
  message: string;
  undo?: () => unknown;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function show(tone: Tone, message: string, options: { undo?: () => unknown } = {}) {
  const id = nextId++;
  // Newest last; keep the stack short.
  toasts = [...toasts, { id, tone, message, undo: options.undo }].slice(-4);
  emit();
  return id;
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (message: string, options?: { undo?: () => unknown }) =>
    show("success", message, options),
  warning: (message: string) => show("warning", message),
  error: (message: string) => show("error", message),
  dismiss,
};

/** "1 lead" / "3 leads". */
export const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

const LIFETIME: Record<Tone, number | null> = { success: 5000, warning: 10000, error: null };

function ToastItem({ t }: { t: Toast }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const life = t.undo && t.tone === "success" ? 8000 : LIFETIME[t.tone];
    if (life === null || paused) return;
    const timer = setTimeout(() => dismiss(t.id), life);
    return () => clearTimeout(timer);
  }, [t, paused]);
  const Icon =
    t.tone === "success" ? CheckCircle2 : t.tone === "warning" ? TriangleAlert : CircleAlert;
  return (
    <li
      role={t.tone === "error" ? "alert" : "status"}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-3 rounded-lg border bg-background px-4 py-3 text-sm shadow-lg",
        t.tone === "error" && "border-destructive/40",
        t.tone === "warning" && "border-amber-300",
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          t.tone === "success" && "text-brand-teal",
          t.tone === "warning" && "text-amber-600",
          t.tone === "error" && "text-destructive",
        )}
        aria-hidden
      />
      <p className="min-w-0 flex-1 break-words">{t.message}</p>
      {t.undo && (
        <button
          type="button"
          className="shrink-0 font-medium text-primary hover:underline"
          onClick={() => {
            dismiss(t.id);
            void t.undo?.();
          }}
        >
          Undo
        </button>
      )}
      <button
        type="button"
        aria-label="Close message"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => dismiss(t.id)}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </li>
  );
}

/** Where the messages appear. Rendered once, at the top of the app. */
export function Toaster() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
  );
  // At the top of the page and a live region, so messages stay visible and are
  // read out even while a dialog hides the rest of the app.
  return createPortal(
    <ol
      aria-label="Messages"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {current.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </ol>,
    document.body,
  );
}
