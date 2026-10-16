import { getMarkRange } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Braces,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Underline,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * The editor for email messages: bold, italic, underline, links and lists,
 * plus the merge fields. It reads and writes the same small HTML the server
 * keeps (server/sequences/html.ts cleans whatever arrives).
 */

export const MERGE_FIELDS: { value: string; label: string }[] = [
  { value: "{firstName}", label: "First name" },
  { value: "{lastName}", label: "Last name" },
  { value: "{company}", label: "Company" },
  { value: "{title}", label: "Title" },
];

function ToolButton(props: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      // Keep the cursor in the text while clicking the toolbar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40",
        props.active && "bg-muted text-foreground",
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}

/** Make a typed address into a link: "phog.ai" → "https://phog.ai", "a@b.co" → mailto. */
function linkTarget(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^(https?:|mailto:)/i.test(text)) return text;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return `mailto:${text}`;
  return `https://${text}`;
}

interface LinkDraft {
  from: number;
  to: number;
  text: string;
  href: string;
  editing: boolean;
}

/** The text and address of the link at the cursor, with where it starts and ends. */
function linkAt(editor: Editor): LinkDraft | null {
  const type = editor.schema.marks.link;
  const { $from } = editor.state.selection;
  // Just inside a link, or just after its last letter.
  const range =
    getMarkRange($from, type) ??
    ($from.pos > 0 ? getMarkRange(editor.state.doc.resolve($from.pos - 1), type) : undefined);
  if (!range) return null;
  const mark = editor.state.doc.nodeAt(range.from)?.marks.find((m) => m.type === type);
  return {
    from: range.from,
    to: range.to,
    text: editor.state.doc.textBetween(range.from, range.to),
    href: String(mark?.attrs.href ?? "").replace(/^mailto:/i, ""),
    editing: true,
  };
}

/** "Add link": the words to show and where they go. */
function LinkDialog(props: {
  draft: LinkDraft | null;
  onClose: () => void;
  onSave: (text: string, href: string) => void;
}) {
  const [text, setText] = useState("");
  const [href, setHref] = useState("");
  useEffect(() => {
    if (props.draft) {
      setText(props.draft.text);
      setHref(props.draft.href);
    }
  }, [props.draft]);
  const target = linkTarget(href);
  return (
    <Dialog open={props.draft !== null} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent
        className="max-w-md"
        data-keep-editing=""
        // Events from this window travel up through React to the form the editor is in
        // (a step, a record); they belong to this window alone.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{props.draft?.editing ? "Edit link" : "Add link"}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (target) props.onSave(text.trim() || href.trim(), target);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="link-text">Text</Label>
            <Input id="link-text" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="link-href">Link</Label>
            <Input
              id="link-href"
              autoFocus
              inputMode="url"
              placeholder="https://… or an email address"
              value={href}
              onChange={(e) => setHref(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!target}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Clicking into a link: what it says and where it goes, with Edit and Remove. */
function LinkCard(props: {
  editor: Editor;
  link: LinkDraft;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { editor, link } = props;
  const box = editor.view.dom.closest(".rich-text") as HTMLElement | null;
  const at = editor.view.coordsAtPos(link.from);
  const frame = box?.getBoundingClientRect();
  if (!frame) return null;
  const href = linkTarget(link.href) ?? link.href;
  return (
    <div
      role="dialog"
      aria-label="Link"
      className="absolute z-20 w-72 rounded-md border bg-background p-3 text-sm shadow-lg"
      style={{
        top: at.bottom - frame.top + 6,
        left: Math.max(0, Math.min(at.left - frame.left, frame.width - 288)),
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate font-medium">{link.text}</p>
        <button
          type="button"
          aria-label="Close"
          className="text-muted-foreground hover:text-foreground"
          onClick={props.onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="mt-0.5 block truncate text-primary hover:underline"
      >
        {link.href}
      </a>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={props.onEdit}>
          Edit
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          onClick={() => {
            editor
              .chain()
              .focus()
              .setTextSelection({ from: link.from, to: link.to })
              .unsetLink()
              .run();
            props.onClose();
          }}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

function Toolbar({
  editor,
  disabled,
  onLink,
}: {
  editor: Editor;
  disabled?: boolean;
  onLink: () => void;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      link: e.isActive("link"),
    }),
  });
  const chain = () => editor.chain().focus();

  return (
    <div className="border-b">
      <div
        className="flex flex-wrap items-center gap-0.5 p-1"
        role="toolbar"
        aria-label="Formatting"
      >
        <ToolButton
          icon={Bold}
          label="Bold"
          active={state.bold}
          disabled={disabled}
          onClick={() => chain().toggleBold().run()}
        />
        <ToolButton
          icon={Italic}
          label="Italic"
          active={state.italic}
          disabled={disabled}
          onClick={() => chain().toggleItalic().run()}
        />
        <ToolButton
          icon={Underline}
          label="Underline"
          active={state.underline}
          disabled={disabled}
          onClick={() => chain().toggleUnderline().run()}
        />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <ToolButton
          icon={List}
          label="Bulleted list"
          active={state.bullet}
          disabled={disabled}
          onClick={() => chain().toggleBulletList().run()}
        />
        <ToolButton
          icon={ListOrdered}
          label="Numbered list"
          active={state.ordered}
          disabled={disabled}
          onClick={() => chain().toggleOrderedList().run()}
        />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <ToolButton
          icon={LinkIcon}
          label={state.link ? "Edit link" : "Add link"}
          active={state.link}
          disabled={disabled}
          onClick={onLink}
        />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <MergeFieldPicker disabled={disabled} onPick={(v) => chain().insertContent(v).run()} />
      </div>
    </div>
  );
}

function MergeFieldPicker(props: { disabled?: boolean; onPick: (value: string) => void }) {
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      <Braces className="h-4 w-4" aria-hidden />
      <select
        aria-label="Insert a merge field"
        className="h-8 rounded border-0 bg-transparent pr-1 text-xs hover:bg-muted"
        value=""
        disabled={props.disabled}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          if (e.target.value) props.onPick(e.target.value);
        }}
      >
        <option value="">Insert field…</option>
        {MERGE_FIELDS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RichTextEditor(props: {
  id?: string;
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Ctrl/Cmd+Enter. */
  onSubmit?: () => void;
  /** Escape. */
  onCancel?: () => void;
  className?: string;
}) {
  const handlers = useRef(props);
  handlers.current = props;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
      }),
      Placeholder.configure({ placeholder: props.placeholder ?? "Write the message…" }),
    ],
    content: props.value,
    editable: !props.disabled,
    autofocus: props.autoFocus ? "end" : false,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        ...(props.id ? { id: props.id } : {}),
        role: "textbox",
        "aria-multiline": "true",
        class: "px-3 py-2",
      },
      handleKeyDown: (_view, event) => {
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          handlers.current.onSubmit
        ) {
          handlers.current.onSubmit();
          return true;
        }
        if (event.key === "Escape" && handlers.current.onCancel) {
          handlers.current.onCancel();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => handlers.current.onChange(e.isEmpty ? "" : e.getHTML()),
  });

  // Follow a value set from outside (a reset, another record), not our own typing.
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (props.value !== current) editor.commands.setContent(props.value, { emitUpdate: false });
  }, [props.value, editor]);
  useEffect(() => {
    editor?.setEditable(!props.disabled);
  }, [props.disabled, editor]);

  // The link window, and the card shown on clicking into a link.
  const [draft, setDraft] = useState<LinkDraft | null>(null);
  const [card, setCard] = useState<LinkDraft | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  useEffect(() => {
    if (!editor) return;
    const follow = () => {
      const found = editor.isFocused ? linkAt(editor) : null;
      setCard((prev) =>
        found && found.from === prev?.from && found.to === prev?.to && found.href === prev?.href
          ? prev
          : found,
      );
    };
    editor.on("selectionUpdate", follow);
    editor.on("focus", follow);
    return () => {
      editor.off("selectionUpdate", follow);
      editor.off("focus", follow);
    };
  }, [editor]);

  if (!editor) return null;

  const openLinkWindow = () => {
    const existing = linkAt(editor);
    if (existing) return setDraft(existing);
    const { from, to } = editor.state.selection;
    setDraft({ from, to, text: editor.state.doc.textBetween(from, to), href: "", editing: false });
  };
  const saveLink = (text: string, href: string) => {
    if (!draft) return;
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: draft.from, to: draft.to },
        { type: "text", text, marks: [{ type: "link", attrs: { href } }] },
      )
      .run();
    setDraft(null);
  };

  return (
    <div
      className={cn(
        "rich-text relative rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring",
        props.disabled && "opacity-60",
        props.className,
      )}
    >
      <Toolbar editor={editor} disabled={props.disabled} onLink={openLinkWindow} />
      <EditorContent editor={editor} />
      {card && !draft && dismissed !== card.from && (
        <LinkCard
          editor={editor}
          link={card}
          onEdit={() => setDraft(card)}
          onClose={() => setDismissed(card.from)}
        />
      )}
      <LinkDialog
        draft={draft}
        onClose={() => {
          setDraft(null);
          editor.commands.focus();
        }}
        onSave={saveLink}
      />
    </div>
  );
}

/**
 * Plain text with the same Insert field menu, for LinkedIn messages. With a
 * `limit`, it counts characters and stops at the limit (LinkedIn's 300 for a
 * connection note).
 */
export function PlainTextEditor(props: {
  id?: string;
  value: string;
  onChange: (text: string) => void;
  rows?: number;
  limit?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const insert = (value: string) => {
    const el = box.current;
    const start = el?.selectionStart ?? props.value.length;
    const end = el?.selectionEnd ?? props.value.length;
    const next = props.value.slice(0, start) + value + props.value.slice(end);
    if (props.limit && next.length > props.limit) return;
    props.onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + value.length, start + value.length);
    });
  };
  const over = props.limit ? props.value.length > props.limit : false;
  return (
    <div
      className="rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring"
      // Leaving for the Insert field menu isn't leaving the editor.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) props.onBlur?.();
      }}
    >
      <div className="flex items-center justify-between border-b p-1">
        <MergeFieldPicker disabled={props.disabled} onPick={insert} />
        {props.limit && (
          <span
            className={cn(
              "px-2 text-xs tabular-nums",
              over ? "font-medium text-destructive" : "text-muted-foreground",
            )}
            aria-live="polite"
          >
            {props.value.length} / {props.limit}
          </span>
        )}
      </div>
      <textarea
        id={props.id}
        ref={box}
        rows={props.rows ?? 6}
        value={props.value}
        maxLength={props.limit}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={props.onKeyDown}
        className="block w-full resize-y rounded-b-md bg-transparent px-3 py-2 text-sm focus-visible:outline-none disabled:opacity-60"
      />
    </div>
  );
}

/** A saved email message, formatted. The server has already cleaned it. */
export function RichText({ html, className }: { html: string; className?: string }) {
  return <div className={cn("rich-text", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
