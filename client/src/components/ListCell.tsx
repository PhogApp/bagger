import { Pencil } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FieldEditor, useInlineEdit } from "@/components/RecordDetail";
import { asText, valueOf, type Field } from "@/components/RecordPage";
import { cn } from "@/lib/utils";

/**
 * One cell of a record list that can be changed in place: it reads as the
 * column draws it, and one click opens the same editor a record page uses
 * (Enter or moving away saves, Escape cancels, a question first for changes
 * with side effects). The editor opens in a small panel over the cell, placed
 * against the window so the table's scrolling edge can't cut it off.
 */
export function ListCell(props: {
  row: Record<string, unknown> & { id: string };
  field: Field;
  editable: boolean;
  children: ReactNode;
  confirm?: (value: string) => string | null;
  save: (value: string) => Promise<void>;
}) {
  const { field, row } = props;
  const edit = useInlineEdit({
    field,
    stored: asText(valueOf(row, field.name)),
    confirm: props.confirm,
    save: props.save,
  });
  const cell = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number; width: number } | null>(null);

  // Keep the panel over the cell while the page or table scrolls.
  useEffect(() => {
    if (!edit.editing) return;
    const place = () => {
      const r = cell.current?.getBoundingClientRect();
      if (!r) return;
      const wide = ["textarea", "richtext", "plaintext", "multiselect"].includes(field.kind ?? "");
      const width = Math.min(Math.max(r.width + 16, wide ? 360 : 220), window.innerWidth - 16);
      setAt({
        top: Math.max(8, r.top - 6),
        left: Math.max(8, Math.min(r.left - 8, window.innerWidth - width - 8)),
        width,
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [edit.editing, field.kind]);

  if (!props.editable) return <>{props.children}</>;
  return (
    <div ref={cell} className="relative">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Edit ${field.label}`}
        onClick={(e) => {
          // A link inside the cell (an email, a phone number) still works.
          if ((e.target as HTMLElement).closest("a")) return;
          e.stopPropagation();
          edit.start();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            edit.start();
          }
        }}
        className={cn(
          "group -mx-2 -my-1 flex min-h-8 cursor-text items-center gap-1.5 rounded-md px-2 py-1",
          "hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          edit.editing && "invisible",
        )}
      >
        <span className="min-w-0 flex-1">{props.children}</span>
        <Pencil
          className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100"
          aria-hidden
        />
      </div>
      {edit.editing && at && (
        <div
          className="fixed z-40 rounded-md border bg-background p-1.5 shadow-lg"
          style={{ top: at.top, left: at.left, width: at.width }}
          onClick={(e) => e.stopPropagation()}
        >
          <label htmlFor={`cell-${row.id}-${field.name}`} className="sr-only">
            {field.label}
          </label>
          <FieldEditor edit={edit} id={`cell-${row.id}-${field.name}`} compact />
        </div>
      )}
    </div>
  );
}
