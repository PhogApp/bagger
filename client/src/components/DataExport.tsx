import { Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

/**
 * The full data export: every record and its history as CSV files in a ZIP.
 * Admins can run it any time, including on a locked or cancelled account.
 */
export function useFullExport() {
  const { authHeaders } = useSession();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/export", { headers: await authHeaders() });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(
          res.status === 403
            ? "Only admins can export all of the organization's data."
            : (body.message ?? "The export didn't finish. Try again in a minute."),
        );
      }
      const blob = await res.blob();
      const name =
        /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ??
        "bagger-export.zip";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(`Downloaded ${name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The export didn't finish.");
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

export function FullExportButton({ variant = "outline" }: { variant?: "outline" | "default" }) {
  const { run, busy } = useFullExport();
  return (
    <Button type="button" variant={variant} disabled={busy} onClick={() => void run()}>
      <Download className="mr-2 h-4 w-4" aria-hidden />
      {busy ? "Preparing the download…" : "Download all data"}
    </Button>
  );
}
