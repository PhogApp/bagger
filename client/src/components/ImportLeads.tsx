import { useMutation, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { Upload } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApi } from "@/lib/api";

/** The lead fields a CSV column can be mapped to, and headers that usually mean them. */
const TARGETS: { name: string; label: string; required?: boolean; guesses: string[] }[] = [
  {
    name: "firstName",
    label: "First Name",
    required: true,
    guesses: ["firstname", "first", "givenname"],
  },
  {
    name: "lastName",
    label: "Last Name",
    required: true,
    guesses: ["lastname", "last", "surname", "familyname"],
  },
  {
    name: "email",
    label: "Email",
    required: true,
    guesses: ["email", "emailaddress", "workemail", "businessemail"],
  },
  { name: "title", label: "Title", guesses: ["title", "jobtitle", "position"] },
  {
    name: "company",
    label: "Company",
    guesses: ["company", "companyname", "account", "accountname", "organization"],
  },
  {
    name: "cellPhone",
    label: "Cell Phone",
    guesses: ["cellphone", "cell", "mobile", "mobilephone", "phone", "phonenumber"],
  },
  {
    name: "directPhone",
    label: "Direct Phone",
    guesses: ["directphone", "direct", "directdial", "workphone"],
  },
  { name: "hqPhone", label: "HQ Phone", guesses: ["hqphone", "hq", "companyphone", "mainphone"] },
  {
    name: "linkedin",
    label: "LinkedIn",
    guesses: ["linkedin", "linkedinurl", "linkedinprofile", "personlinkedinurl"],
  },
  { name: "notes", label: "Notes", guesses: ["notes", "note", "comments", "description"] },
];

const BATCH = 2000;
const normalize = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

interface Parsed {
  fileName: string;
  headers: string[];
  rows: Record<string, string>[];
  /** The line of the file each row came from, for error messages. */
  lines: number[];
}
interface Result {
  created: number;
  duplicates: { row: number; email: string }[];
  errors: { row: number; message: string }[];
}

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function ImportLeadsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Upload className="mr-2 h-4 w-4" aria-hidden />
        Import CSV
      </Button>
      {open && <ImportDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [fileError, setFileError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<Result | null>(null);

  function readFile(file: File) {
    setFileError(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      complete: (out) => {
        const headers = (out.meta.fields ?? []).filter((h) => h.trim() !== "");
        // Blank lines are dropped here rather than by the parser so that each
        // row keeps the line number it has in the file (line 1 is the header).
        const rows: Record<string, string>[] = [];
        const lines: number[] = [];
        out.data.forEach((row, index) => {
          if (Object.values(row).some((cell) => String(cell ?? "").trim() !== "")) {
            rows.push(row);
            lines.push(index + 2);
          }
        });
        if (headers.length === 0 || rows.length === 0) {
          setFileError("That file has no rows, or no header row naming its columns.");
          return;
        }
        // Guess each field's column from the header text; the user can change any of them.
        const taken = new Set<string>();
        const guess: Record<string, string> = {};
        for (const target of TARGETS) {
          const match = headers.find(
            (h) => !taken.has(h) && target.guesses.includes(normalize(h)),
          );
          if (match) {
            guess[target.name] = match;
            taken.add(match);
          }
        }
        setMapping(guess);
        setParsed({ fileName: file.name, headers, rows, lines });
      },
      error: () => setFileError("That file could not be read as a CSV."),
    });
  }

  const missing = TARGETS.filter((t) => t.required && !mapping[t.name]);

  const run = useMutation({
    mutationFn: async () => {
      const rows = parsed!.rows.map((source) =>
        Object.fromEntries(
          Object.entries(mapping)
            .filter(([, column]) => column)
            .map(([field, column]) => [field, (source[column] ?? "").trim()]),
        ),
      );
      const total: Result = { created: 0, duplicates: [], errors: [] };
      for (let start = 0; start < rows.length; start += BATCH) {
        const part = await api<Result>("POST", "/api/leads/import", {
          rows: rows.slice(start, start + BATCH),
        });
        // Row numbers come back relative to the batch.
        total.created += part.created;
        total.duplicates.push(...part.duplicates.map((d) => ({ ...d, row: d.row + start })));
        total.errors.push(...part.errors.map((e) => ({ ...e, row: e.row + start })));
        setProgress(Math.min(start + BATCH, rows.length));
      }
      return total;
    },
    onSuccess: async (total) => {
      setResult(total);
      await queryClient.invalidateQueries({ queryKey: ["leads"] });
    },
  });

  const line = (row: number) => parsed?.lines[row - 1] ?? row + 1;

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import leads from a CSV file</DialogTitle>
          <DialogDescription>
            The first line of the file must name its columns. Leads whose email is already in
            Bagger are skipped, so importing the same file twice is safe.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3 text-sm">
            <p className="text-base font-medium">
              {result.created.toLocaleString()} lead{result.created === 1 ? "" : "s"} imported.
            </p>
            {result.duplicates.length > 0 && (
              <p>
                {result.duplicates.length.toLocaleString()} skipped because the email is already
                in Bagger or appeared earlier in the file.
              </p>
            )}
            {result.errors.length > 0 && (
              <div>
                <p className="text-destructive">
                  {result.errors.length.toLocaleString()} row
                  {result.errors.length === 1 ? "" : "s"} could not be imported:
                </p>
                <ul className="mt-1 max-h-48 list-disc overflow-y-auto pl-5">
                  {result.errors.slice(0, 100).map((e) => (
                    <li key={e.row}>
                      Line {line(e.row)}: {e.message}
                    </li>
                  ))}
                </ul>
                {result.errors.length > 100 && (
                  <p className="mt-1 text-muted-foreground">Showing the first 100.</p>
                )}
              </div>
            )}
          </div>
        ) : !parsed ? (
          <div>
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="CSV file"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-2 file:text-sm"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) readFile(file);
              }}
            />
            {fileError && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {fileError}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              <span className="font-medium">{parsed.fileName}</span>:{" "}
              {parsed.rows.length.toLocaleString()} rows. Match each Bagger field to a column in
              your file.
            </p>
            <div className="grid grid-cols-[10rem_1fr_1fr] items-center gap-x-3 gap-y-2 text-sm">
              <span className="text-xs font-medium uppercase text-muted-foreground">
                Bagger field
              </span>
              <span className="text-xs font-medium uppercase text-muted-foreground">
                Column in your file
              </span>
              <span className="text-xs font-medium uppercase text-muted-foreground">
                First row
              </span>
              {TARGETS.map((target) => (
                <div key={target.name} className="contents">
                  <label htmlFor={`map-${target.name}`}>
                    {target.label}
                    {target.required && <span className="text-destructive"> *</span>}
                  </label>
                  <select
                    id={`map-${target.name}`}
                    className={selectClass}
                    value={mapping[target.name] ?? ""}
                    onChange={(e) => setMapping({ ...mapping, [target.name]: e.target.value })}
                  >
                    <option value="">Not in my file</option>
                    {parsed.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                  <span className="truncate text-muted-foreground">
                    {mapping[target.name] ? parsed.rows[0][mapping[target.name]] || "—" : ""}
                  </span>
                </div>
              ))}
            </div>
            {missing.length > 0 && (
              <p className="text-sm text-destructive">
                Choose a column for {missing.map((m) => m.label).join(", ")}.
              </p>
            )}
            {run.isPending && (
              <p role="status" className="text-sm text-muted-foreground">
                Importing… {progress.toLocaleString()} of {parsed.rows.length.toLocaleString()}
              </p>
            )}
            {run.error && (
              <p role="alert" className="text-sm text-destructive">
                {run.error.message}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {result ? "Done" : "Cancel"}
          </Button>
          {parsed && !result && (
            <Button disabled={missing.length > 0 || run.isPending} onClick={() => run.mutate()}>
              Import {parsed.rows.length.toLocaleString()} leads
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
