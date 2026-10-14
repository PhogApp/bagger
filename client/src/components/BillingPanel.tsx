import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn, formatDate, formatDay } from "@/lib/utils";

/**
 * The owner's billing: the card, the free week, what the next bill will be, past
 * bills, paying what's owed, and cancelling. Shown on the Organization page
 * and on the screens for an account that's waiting for a card, locked or
 * cancelled.
 */

interface Line {
  description: string;
  amountCents: number;
}
interface Billing {
  enabled: boolean;
  status: "active" | "locked" | "cancelled";
  card: { brand: string; last4: string; expires: string } | null;
  cancelsOn: string | null;
  seatCents: number;
  trialEndsOn: string | null;
  inTrial: boolean;
  seats: { active: number; ending: number };
  nextInvoice: { date: string; first: boolean; lines: Line[]; amountCents: number } | null;
  invoices: {
    id: string;
    period: string;
    status: "open" | "paid" | "failed" | "void";
    amountCents: number;
    lines: Line[];
    hostedUrl: string | null;
    pdfUrl: string | null;
    failureMessage: string | null;
    createdAt: string;
  }[];
}

export const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const periodName = (period: string) =>
  new Date(`${period}-15T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
const brandName = (b: string) =>
  ({ visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover" })[b] ??
  b.charAt(0).toUpperCase() + b.slice(1);

export function useBilling(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["billing"],
    queryFn: () => api<Billing>("GET", "/api/billing"),
    enabled,
  });
}

/** Send the owner to Stripe's page to enter or change the card. */
export function useAddCard() {
  const api = useApi();
  return useMutation({
    mutationFn: () => api<{ url: string }>("POST", "/api/billing/card"),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Back from Stripe's card page (?billing=card&session_id=…): save the card,
 * then tidy the address. Rendered once, at the top of the app.
 */
export function CardReturn() {
  const api = useApi();
  const queryClient = useQueryClient();
  const done = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (params.get("billing") !== "card" || !sessionId || done.current) return;
    done.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    api<{ card: { last4: string }; unlocked: boolean; trialEndsOn: string }>(
      "POST",
      "/api/billing/card/confirm",
      {
        sessionId,
      },
    )
      .then(async (r) => {
        toast.success(
          r.unlocked
            ? `Card ending ${r.card.last4} saved and paid. Your account is open again.`
            : `Card ending ${r.card.last4} saved. Your free week has started.`,
        );
        await queryClient.invalidateQueries();
      })
      .catch((e: Error) => toast.error(e.message));
  }, [api, queryClient]);
  return null;
}

const STATUS_TONE: Record<string, string> = {
  paid: "bg-emerald-50 text-emerald-800 border-emerald-200",
  failed: "bg-red-50 text-red-800 border-red-200",
  open: "bg-sky-50 text-sky-800 border-sky-200",
  void: "bg-slate-100 text-slate-700 border-slate-200",
};
const STATUS_TEXT: Record<string, string> = {
  paid: "Paid",
  failed: "Unpaid",
  open: "Processing",
  void: "Void",
};

/** "6 days left", "last free day today". */
function trialLeft(endsOn: string): string {
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const [y, m, d] = endsOn.split("-").map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - today) / 86_400_000);
  if (days <= 1) return "last free day today";
  return `${days} days left`;
}

export function BillingPanel() {
  const api = useApi();
  const queryClient = useQueryClient();
  const billing = useBilling();
  const addCard = useAddCard();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: (job: { path: string; done: (r: unknown) => string }) =>
      api("POST", job.path).then((r) => job.done(r)),
    onSuccess: async (message) => {
      setConfirmingCancel(false);
      await queryClient.invalidateQueries();
      toast.success(message);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (billing.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (billing.error) return <p className="text-sm text-destructive">{billing.error.message}</p>;
  const b = billing.data!;
  if (!b.enabled) {
    return (
      <p className="text-sm text-muted-foreground">
        Payments aren't switched on yet. Your card, bills and seat count will appear here once they
        are.
      </p>
    );
  }
  const seatPrice = money(b.seatCents);
  const owing = b.invoices.filter((i) => i.status === "failed");
  const owed = owing.reduce((sum, i) => sum + i.amountCents, 0);

  return (
    <div className="space-y-5">
      {b.status === "locked" && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900"
        >
          <p className="font-medium">
            The last charge didn't go through, so the account is locked. {money(owed)} is owed.
          </p>
          <p className="mt-1">
            {owing[0]?.failureMessage ?? "The card was declined."} Pay with the card on file, or
            change the card.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={act.isPending}
              onClick={() =>
                act.mutate({
                  path: "/api/billing/pay",
                  done: (r) =>
                    (r as { unlocked: boolean }).unlocked
                      ? "Paid. Your account is open again."
                      : "The charge didn't go through. Try another card.",
                })
              }
            >
              Pay {money(owed)} now
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={addCard.isPending}
              onClick={() => addCard.mutate()}
            >
              Use a different card
            </Button>
          </div>
        </div>
      )}

      {b.inTrial && b.trialEndsOn && !b.cancelsOn && (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
          <p className="font-medium">
            Free trial: {trialLeft(b.trialEndsOn)}. Nothing is charged until{" "}
            {formatDay(b.trialEndsOn)}.
          </p>
          <p className="mt-1">
            On {formatDay(b.trialEndsOn)} you're charged for the rest of that month, by the day,
            then {seatPrice} per user on the 1st of each month.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <CreditCard className="h-5 w-5 text-muted-foreground" aria-hidden />
          {b.card ? (
            <p className="text-sm">
              <span className="font-medium">
                {brandName(b.card.brand)} ending {b.card.last4}
              </span>{" "}
              <span className="text-muted-foreground">· expires {b.card.expires}</span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No card yet.</p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={addCard.isPending}
          onClick={() => addCard.mutate()}
        >
          {b.card ? "Change card" : "Add a card"}
        </Button>
      </div>

      <div className="rounded-md border">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-3 py-2">
          <h3 className="text-sm font-medium">
            {b.nextInvoice
              ? `${b.nextInvoice.first ? "First bill" : "Next bill"}, ${formatDay(b.nextInvoice.date)}`
              : b.card || b.status === "cancelled" || b.cancelsOn
                ? "No more bills"
                : "No bills yet"}
          </h3>
          <span className="text-sm text-muted-foreground">
            {b.seats.active + b.seats.ending} seat
            {b.seats.active + b.seats.ending === 1 ? "" : "s"} at {seatPrice} a month
          </span>
        </div>
        {b.nextInvoice ? (
          <ul className="divide-y text-sm">
            {b.nextInvoice.lines.map((l) => (
              <li key={l.description} className="flex justify-between gap-3 px-3 py-1.5">
                <span>{l.description}</span>
                <span className="tabular-nums">{money(l.amountCents)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-3 px-3 py-1.5 font-medium">
              <span>Total, if nothing changes</span>
              <span className="tabular-nums">{money(b.nextInvoice.amountCents)}</span>
            </li>
          </ul>
        ) : (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            {b.status === "cancelled"
              ? "The account is cancelled."
              : b.cancelsOn
                ? `The account closes after ${formatDay(b.cancelsOn)}.`
                : "Add a card to start your free week."}
          </p>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-sm font-medium">Past bills</h3>
        {b.invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {b.invoices.map((i) => (
              <li key={i.id} className="px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    className="font-medium hover:underline"
                    aria-expanded={open === i.id}
                    onClick={() => setOpen(open === i.id ? null : i.id)}
                  >
                    {periodName(i.period)}
                  </button>
                  <span className="flex items-center gap-3">
                    <span className="tabular-nums">{money(i.amountCents)}</span>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs font-medium",
                        STATUS_TONE[i.status],
                      )}
                    >
                      {STATUS_TEXT[i.status]}
                    </span>
                    {i.hostedUrl && (
                      <a
                        href={i.hostedUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        Invoice <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    )}
                    {i.pdfUrl && (
                      <a
                        href={i.pdfUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        PDF
                      </a>
                    )}
                  </span>
                </div>
                {open === i.id && (
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {i.lines.map((l) => (
                      <li key={l.description} className="flex justify-between gap-3">
                        <span>{l.description}</span>
                        <span className="tabular-nums">{money(l.amountCents)}</span>
                      </li>
                    ))}
                    <li>Billed {formatDate(i.createdAt)}</li>
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {b.status !== "locked" && (
        <div className="border-t pt-4 text-sm">
          {b.status === "cancelled" ? (
            <div className="flex flex-wrap items-center gap-3">
              <span>The account is cancelled. Your data is kept.</span>
              <Button
                size="sm"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({
                    path: "/api/billing/reactivate",
                    done: () => "Welcome back. Your account is open again.",
                  })
                }
              >
                Reactivate
              </Button>
            </div>
          ) : b.cancelsOn ? (
            <div className="flex flex-wrap items-center gap-3">
              <span>
                Cancelling: the account stays open through {formatDay(b.cancelsOn)}, then closes.{" "}
                {b.inTrial ? "Nothing will be charged." : "No more bills."}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({
                    path: "/api/billing/undo-cancel",
                    done: () => "Cancellation undone",
                  })
                }
              >
                Keep my account
              </Button>
            </div>
          ) : b.status === "active" && confirmingCancel ? (
            <div className="flex flex-wrap items-center gap-3">
              <span>
                {b.inTrial
                  ? "Everyone keeps access to the end of the free week, and nothing is charged."
                  : "Everyone keeps access to the end of this month, already paid for. There are no more bills after that."}{" "}
                Your data is kept. You can reactivate any time.
              </span>
              <Button
                size="sm"
                variant="destructive"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({
                    path: "/api/billing/cancel",
                    done: (r) =>
                      `Cancelled. The account stays open through ${formatDay((r as { cancelsOn: string }).cancelsOn)}.`,
                  })
                }
              >
                Cancel the account
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingCancel(false)}>
                Keep it
              </Button>
            </div>
          ) : b.status === "active" ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-destructive hover:underline"
              onClick={() => setConfirmingCancel(true)}
            >
              Cancel the account…
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
