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
  Unlink,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  { value: "{email}", label: "Email" },
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

function Toolbar({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      link: e.isActive("link"),
      href: (e.getAttributes("link").href as string | undefined) ?? "",
    }),
  });
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");
  const chain = () => editor.chain().focus();

  const applyLink = () => {
    const target = linkTarget(href);
    if (!target) chain().extendMarkRange("link").unsetLink().run();
    else if (editor.state.selection.empty && !state.link) {
      // Nothing selected: insert the address itself as the link.
      chain()
        .insertContent({
          type: "text",
          text: href.trim(),
          marks: [{ type: "link", attrs: { href: target } }],
        })
        .run();
    } else chain().extendMarkRange("link").setLink({ href: target }).run();
    setLinking(false);
  };

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
          label={state.link ? "Change link" : "Add link"}
          active={linking || state.link}
          disabled={disabled}
          onClick={() => {
            setHref(state.href.replace(/^mailto:/i, ""));
            setLinking((v) => !v);
          }}
        />
        {state.link && (
          <ToolButton
            icon={Unlink}
            label="Remove link"
            disabled={disabled}
            onClick={() => chain().extendMarkRange("link").unsetLink().run()}
          />
        )}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <Braces className="h-4 w-4" aria-hidden />
          <select
            aria-label="Insert a merge field"
            className="h-8 rounded border-0 bg-transparent pr-1 text-xs hover:bg-muted"
            value=""
            disabled={disabled}
            onChange={(e) => {
              if (e.target.value) chain().insertContent(e.target.value).run();
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
      </div>
      {linking && (
        <div className="flex items-center gap-2 border-t bg-muted/40 p-2">
          <input
            autoFocus
            aria-label="Link address"
            className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="https://… or an email address"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setLinking(false);
                editor.commands.focus();
              }
            }}
          />
          <button
            type="button"
            className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground"
            onClick={applyLink}
          >
            {href.trim() ? "Apply" : "Remove"}
          </button>
        </div>
      )}
    </div>
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

  if (!editor) return null;
  return (
    <div
      className={cn(
        "rich-text rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring",
        props.disabled && "opacity-60",
        props.className,
      )}
    >
      <Toolbar editor={editor} disabled={props.disabled} />
      <EditorContent editor={editor} />
    </div>
  );
}

/** A saved email message, formatted. The server has already cleaned it. */
export function RichText({ html, className }: { html: string; className?: string }) {
  return <div className={cn("rich-text", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
