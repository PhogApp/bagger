import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatPhoneNumber, parsePhone } from "../../../shared/phone";

/**
 * A phone number that dials: a tel: link hands it to the rep's phone or
 * softphone. Bagger places no call and can't tell whether one happened.
 * A number that can't be read stays as typed, without a link. The copy button
 * is for computers with no calling app.
 */
export function PhoneLink({
  value,
  className,
  copy = true,
}: {
  value: string | null | undefined;
  className?: string;
  /** Show the copy button. Lists leave it out to stay compact. */
  copy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (!value || !value.trim()) return <span className="text-muted-foreground">—</span>;
  const phone = parsePhone(value);
  const text = formatPhoneNumber(value);
  // Links and the button sit inside clickable rows and fields; only they should act.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-1", className)}>
      {phone ? (
        <>
          <a
            href={`tel:${phone.e164}`}
            className="whitespace-nowrap text-primary hover:underline"
            onClick={stop}
            onKeyDown={stop}
            title={`Call ${phone.display}`}
          >
            {phone.display}
          </a>
          {phone.ext && (
            <span className="whitespace-nowrap text-muted-foreground">ext. {phone.ext}</span>
          )}
        </>
      ) : (
        <span>{value.trim()}</span>
      )}
      {copy && (
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={copied ? "Copied" : `Copy ${text}`}
          title="Copy number"
          onKeyDown={stop}
          onClick={async (e) => {
            stop(e);
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              // Copying can be blocked; the number is still on screen.
            }
          }}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      )}
    </span>
  );
}
