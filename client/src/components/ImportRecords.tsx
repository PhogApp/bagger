import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import Papa from "papaparse";
import { Download, TriangleAlert, Upload } from "lucide-react";
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
import { useFieldSetup, type CustomField, type CustomFieldType } from "@/lib/fields";

export type ImportKind = "leads" | "contacts" | "accounts";

/** A Bagger field a CSV column can feed, and headers that usually mean it. */
interface Target {
  name: string;
  label: string;
  required?: boolean;
  guesses: string[];
  /** Shown in the sample file. */
  example: string;
}

const PERSON: Target[] = [
  {
    name: "firstName",
    label: "First Name",
    required: true,
    guesses: ["first", "givenname"],
    example: "Jordan",
  },
  {
    name: "lastName",
    label: "Last Name",
    required: true,
    guesses: ["last", "surname", "familyname"],
    example: "Avery",
  },
  {
    name: "email",
    label: "Email",
    required: true,
    guesses: ["emailaddress", "workemail", "businessemail"],
    example: "jordan.avery@example.com",
  },
  { name: "title", label: "Title", guesses: ["jobtitle", "position"], example: "VP Operations" },
];
const PERSON_REST: Target[] = [
  {
    name: "cellPhone",
    label: "Cell Phone",
    guesses: ["cell", "mobile", "mobilephone", "phone", "phonenumber"],
    example: "(555) 010-0142",
  },
  {
    name: "directPhone",
    label: "Direct Phone",
    guesses: ["direct", "directdial", "workphone"],
    example: "(555) 010-0143",
  },
  {
    name: "hqPhone",
    label: "HQ Phone",
    guesses: ["hq", "companyphone", "mainphone"],
    example: "(555) 010-0100",
  },
  {
    name: "linkedin",
    label: "LinkedIn",
    guesses: ["linkedinurl", "linkedinprofile", "personlinkedinurl"],
    example: "linkedin.com/in/jordanavery",
  },
  { name: "notes", label: "Notes", guesses: ["note", "comments", "description"], example: "" },
];

interface KindConfig {
  singular: string;
  plural: string;
  /** How a duplicate is recognized, for the explanation under the title. */
  match: string;
  targets: Target[];
  /** Other lists to refresh after an import. */
  alsoRefresh: string[];
}

const KINDS: Record<ImportKind, KindConfig> = {
  leads: {
    singular: "lead",
    plural: "leads",
    match: "A lead is already in Bagger when a lead or a contact has the same email address.",
    targets: [
      ...PERSON,
      {
        name: "company",
        label: "Company",
        guesses: ["companyname", "account", "accountname", "organization"],
        example: "Example Freight Co",
      },
      ...PERSON_REST,
    ],
    alsoRefresh: [],
  },
  contacts: {
    singular: "contact",
    plural: "contacts",
    match:
      "A contact is already in Bagger when a contact has the same email address. Each new " +
      "contact is placed on the account with that name or website; if there is none, the " +
      "account is created.",
    targets: [
      ...PERSON,
      {
        name: "accountName",
        label: "Account Name",
        required: true,
        guesses: ["account", "company", "companyname", "organization"],
        example: "Example Freight Co",
      },
      {
        name: "accountWebsite",
        label: "Account Website",
        guesses: ["website", "companywebsite", "url", "domain", "companydomain"],
        example: "www.examplefreight.com",
      },
      ...PERSON_REST,
    ],
    alsoRefresh: ["accounts"],
  },
  accounts: {
    singular: "account",
    plural: "accounts",
    match: "An account is already in Bagger when an account has the same name or the same website.",
    targets: [
      {
        name: "name",
        label: "Account Name",
        required: true,
        guesses: ["name", "account", "company", "companyname", "organization"],
        example: "Example Freight Co",
      },
      {
        name: "website",
        label: "Website",
        guesses: ["url", "companywebsite", "domain", "companydomain"],
        example: "www.examplefreight.com",
      },
      {
        name: "linkedin",
        label: "LinkedIn",
        guesses: ["linkedinurl", "companylinkedinurl", "linkedinpage"],
        example: "linkedin.com/company/example-freight",
      },
      {
        name: "hqPhone",
        label: "HQ Phone",
        guesses: ["hq", "phone", "phonenumber", "companyphone", "mainphone"],
        example: "(555) 010-0100",
      },
      { name: "notes", label: "Notes", guesses: ["note", "comments", "description"], example: "" },
    ],
    alsoRefresh: [],
  },
};

/** The most rows one request may carry (the server's limit). */
const BATCH = 5000;
const normalize = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");
const matches = (target: Target, header: string) => {
  const h = normalize(header);
  return h === normalize(target.label) || h === normalize(target.name) || target.guesses.includes(h);
};

interface Parsed {
  fileName: string;
  headers: string[];
  rows: Record<string, string>[];
  /** The line of the file each row came from, for messages. */
  lines: number[];
}
interface RowNote {
  row: number;
  label: string;
  /** A lead in the file that is already a contact; always skipped. */
  existing?: "contact";
}
interface Result {
  total: number;
  created: number;
  updated: number;
  duplicates: RowNote[];
  repeats: RowNote[];
  errors: { row: number; message: string }[];
  newAccounts: number;
  /** Imported, but missing a value for a required custom field. */
  incomplete: { row: number; label: string; missing: string[] }[];
}
type Mode = "check" | "skip" | "update";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A file with the column names Bagger recognizes and one example row. */
function downloadSample(kind: ImportKind, targets: Target[]) {
  const csv = Papa.unparse([targets.map((t) => t.label), targets.map((t) => t.example)]);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `bagger-${kind}-sample.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function ImportButton({ kind }: { kind: ImportKind }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Upload className="mr-2 h-4 w-4" aria-hidden />
        Import CSV
      </Button>
      {open && <ImportDialog kind={kind} onClose={() => setOpen(false)} />}
    </>
  );
}

/** An example value for a custom field in the sample file. */
const EXAMPLE: Record<CustomFieldType, (f: CustomField) => string> = {
  text: () => "",
  longtext: () => "",
  number: () => "12",
  currency: () => "12500",
  date: () => "2026-12-31",
  checkbox: () => "yes",
  picklist: (f) => f.options[0] ?? "",
  multipicklist: (f) => f.options.slice(0, 2).join("; "),
  url: () => "www.example.com",
  email: () => "someone@example.com",
  phone: () => "(555) 010-0199",
  user: () => "name@yourcompany.com",
};

export function ImportDialog({ kind, onClose }: { kind: ImportKind; onClose: () => void }) {
  const base = KINDS[kind];
  const { data: setup } = useFieldSetup();
  // The organization's own fields can be imported too, as "custom.<key>".
  const cfg = {
    ...base,
    targets: [
      ...base.targets,
      ...(setup?.fields ?? [])
        .filter((f) => f.object === kind && !f.archived)
        .map(
          (f): Target => ({
            name: `custom.${f.key}`,
            label: f.label,
            guesses: [normalize(f.key)],
            example: EXAMPLE[f.type](f),
          }),
        ),
    ],
  };
  const api = useApi();
  const queryClient = useQueryClient();
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [fileError, setFileError] = useState<string | null>(null);
  const [review, setReview] = useState<Result | null>(null);
  const [onDuplicate, setOnDuplicate] = useState<"skip" | "update">("skip");
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
        for (const target of cfg.targets) {
          const match = headers.find((h) => !taken.has(h) && matches(target, h));
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

  const missing = cfg.targets.filter((t) => t.required && !mapping[t.name]);

  /** Send the file to the server, to check it or to save it. */
  async function send(mode: Mode): Promise<Result> {
    const rows = parsed!.rows.map((source) =>
      Object.fromEntries(
        Object.entries(mapping)
          .filter(([, column]) => column)
          .map(([field, column]) => [field, (source[column] ?? "").trim()]),
      ),
    );
    const total: Result = {
      total: rows.length,
      created: 0,
      updated: 0,
      duplicates: [],
      repeats: [],
      errors: [],
      newAccounts: 0,
      incomplete: [],
    };
    for (let start = 0; start < rows.length; start += BATCH) {
      const part = await api<Result>("POST", `/api/import/${kind}`, {
        rows: rows.slice(start, start + BATCH),
        mode,
      });
      // Row numbers come back relative to the batch.
      const shift = <T extends { row: number }>(notes: T[]) =>
        notes.map((note) => ({ ...note, row: note.row + start }));
      total.created += part.created;
      total.updated += part.updated;
      total.newAccounts += part.newAccounts;
      total.duplicates.push(...shift(part.duplicates));
      total.repeats.push(...shift(part.repeats));
      total.errors.push(...shift(part.errors));
      total.incomplete.push(...shift(part.incomplete));
    }
    return total;
  }

  const check = useMutation({ mutationFn: () => send("check"), onSuccess: setReview });
  const run = useMutation({
    mutationFn: () => send(review && review.duplicates.length > 0 ? onDuplicate : "skip"),
    onSuccess: async (total) => {
      setResult(total);
      const said =
        `${count(total.created, cfg.singular, cfg.plural)} imported` +
        (total.updated ? `, ${total.updated.toLocaleString()} updated` : "");
      if (total.errors.length) toast.warning(`${said}. ${count(total.errors.length, "row")} not imported.`);
      else toast.success(said);
      for (const key of [kind, ...cfg.alsoRefresh]) {
        await queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  const line = (row: number) => parsed?.lines[row - 1] ?? row + 1;
  const busy = check.isPending || run.isPending;
  const failure = check.error ?? run.error;

  const problems = (r: Result) => (
    <>
      {r.incomplete.length > 0 && (
        <NoteList
          title={`${count(r.incomplete.length, "row")} ${
            r.incomplete.length === 1 ? "is" : "are"
          } missing a required field (imported anyway, fill ${r.incomplete.length === 1 ? "it" : "them"} in later):`}
          items={r.incomplete.map((n) => `Line ${line(n.row)}: ${n.label} (${n.missing.join(", ")})`)}
        />
      )}
      {r.repeats.length > 0 && (
        <NoteList
          title={`${count(r.repeats.length, "row")} left out because ${
            r.repeats.length === 1 ? "it repeats" : "they repeat"
          } an earlier row of the file:`}
          items={r.repeats.map((n) => `Line ${line(n.row)}: ${n.label}`)}
        />
      )}
      {r.errors.length > 0 && (
        <NoteList
          tone="error"
          title={`${count(r.errors.length, "row")} can't be imported:`}
          items={r.errors.map((e) => `Line ${line(e.row)}: ${e.message}`)}
        />
      )}
    </>
  );

  let body;
  if (result) {
    const skipped = result.duplicates.length - result.updated;
    body = (
      <div className="space-y-3 text-sm">
        <p className="text-base font-medium">
          {count(result.created, cfg.singular)} imported
          {result.updated > 0 && `, ${result.updated.toLocaleString()} updated`}.
        </p>
        {result.newAccounts > 0 && <p>{count(result.newAccounts, "account")} created for them.</p>}
        {skipped > 0 && (
          <p>
            {skipped.toLocaleString()} already in Bagger and{" "}
            {onDuplicate === "update" ? "unchanged by the file" : "left alone"}.
          </p>
        )}
        {problems(result)}
      </div>
    );
  } else if (review && parsed) {
    const dupes = review.duplicates.length;
    const asContacts = review.duplicates.filter((d) => d.existing === "contact").length;
    body = (
      <div className="space-y-3 text-sm">
        <p>
          <span className="font-medium">{parsed.fileName}</span>:{" "}
          {count(review.created, `new ${cfg.singular}`)} out of {count(review.total, "row")}.
          {review.newAccounts > 0 &&
            ` ${count(review.newAccounts, "new account")} will be created for them.`}
        </p>
        {dupes > 0 && (
          <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3">
            <p className="flex items-center gap-2 font-medium text-amber-900">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
              {dupes.toLocaleString()} of {review.total.toLocaleString()} rows{" "}
              {dupes === 1 ? "is" : "are"} already in Bagger.
            </p>
            <ul className="mt-2 max-h-28 list-disc overflow-y-auto pl-9 text-amber-900">
              {review.duplicates.slice(0, 100).map((d) => (
                <li key={d.row}>
                  Line {line(d.row)}: {d.label}
                  {d.existing === "contact" && " (already a contact)"}
                </li>
              ))}
            </ul>
            {dupes > 100 && <p className="mt-1 pl-6 text-amber-900">Showing the first 100.</p>}
            <fieldset className="mt-3 space-y-1.5 pl-6">
              <legend className="sr-only">What to do with rows already in Bagger</legend>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="on-duplicate"
                  className="mt-1"
                  checked={onDuplicate === "skip"}
                  onChange={() => setOnDuplicate("skip")}
                />
                <span>
                  <span className="font-medium">Skip them.</span> Keep what Bagger has.
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="on-duplicate"
                  className="mt-1"
                  checked={onDuplicate === "update"}
                  onChange={() => setOnDuplicate("update")}
                />
                <span>
                  <span className="font-medium">Replace with the file.</span> Overwrite Bagger's
                  values with the file's. Blank cells change nothing, and owner, status and
                  sequence progress are kept.
                  {asContacts > 0 &&
                    ` The ${asContacts === 1 ? "one that is" : `${asContacts} that are`} already ${
                      asContacts === 1 ? "a contact" : "contacts"
                    } will still be skipped.`}
                </span>
              </label>
            </fieldset>
          </div>
        )}
        {problems(review)}
      </div>
    );
  } else if (parsed) {
    body = (
      <div className="space-y-3">
        <p className="text-sm">
          <span className="font-medium">{parsed.fileName}</span>: {count(parsed.rows.length, "row")}
          . Match each Bagger field to a column in your file.
        </p>
        <div className="grid grid-cols-[10rem_1fr_1fr] items-center gap-x-3 gap-y-2 text-sm">
          <span className="text-xs font-medium uppercase text-muted-foreground">Bagger field</span>
          <span className="text-xs font-medium uppercase text-muted-foreground">
            Column in your file
          </span>
          <span className="text-xs font-medium uppercase text-muted-foreground">First row</span>
          {cfg.targets.map((target) => (
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
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
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
          <p role="alert" className="text-sm text-destructive">
            {fileError}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Not sure how to lay the file out?{" "}
          <button
            type="button"
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => downloadSample(kind, cfg.targets)}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            Download a sample file
          </button>{" "}
          with every column Bagger accepts. Fields marked * are required:{" "}
          {cfg.targets
            .filter((t) => t.required)
            .map((t) => t.label)
            .join(", ")}
          .
        </p>
      </div>
    );
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import {cfg.plural} from a CSV file</DialogTitle>
          <DialogDescription>
            The first line of the file must name its columns. {cfg.match} Nothing is saved until
            you have seen what the file will do.
          </DialogDescription>
        </DialogHeader>

        {body}
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            {check.isPending ? "Checking the file…" : "Importing…"}
          </p>
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure.message}
          </p>
        )}

        <DialogFooter>
          {review && !result && (
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>
              Back
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            {result ? "Done" : "Cancel"}
          </Button>
          {parsed && !review && !result && (
            <Button disabled={missing.length > 0 || busy} onClick={() => check.mutate()}>
              Check file
            </Button>
          )}
          {review && !result && <ImportAction />}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  function ImportAction() {
    const replaceable = review!.duplicates.filter((d) => !d.existing).length;
    const updating = replaceable > 0 && onDuplicate === "update";
    const creating = review!.created;
    const nothing = creating === 0 && !updating;
    const parts = [
      creating > 0 ? `Import ${count(creating, cfg.singular)}` : "",
      updating
        ? `${creating > 0 ? "update" : "Update"} ${
            creating > 0
              ? replaceable.toLocaleString()
              : count(replaceable, cfg.singular)
          }`
        : "",
    ].filter(Boolean);
    return (
      <Button disabled={nothing || busy} onClick={() => run.mutate()}>
        {nothing ? "Nothing to import" : parts.join(", ")}
      </Button>
    );
  }
}

function NoteList(props: { title: string; items: string[]; tone?: "error" }) {
  return (
    <div>
      <p className={props.tone === "error" ? "text-destructive" : undefined}>{props.title}</p>
      <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-5">
        {props.items.slice(0, 100).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {props.items.length > 100 && (
        <p className="mt-1 text-muted-foreground">Showing the first 100.</p>
      )}
    </div>
  );
}
