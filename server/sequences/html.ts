import sanitizeHtml from "sanitize-html";
import { EMAIL_TAGS, htmlToText, looksLikeHtml, textToHtml } from "../../shared/richtext";

/**
 * Every email message is cleaned here before it is saved: only the tags in
 * EMAIL_TAGS survive, links keep only http, https and mailto addresses, and
 * plain text is turned into paragraphs. LinkedIn messages are saved as plain
 * text, so formatting pasted into one is dropped.
 */

export function cleanEmailHtml(input: string): string {
  if (!looksLikeHtml(input)) return textToHtml(input);
  const clean = sanitizeHtml(input, {
    allowedTags: EMAIL_TAGS,
    allowedAttributes: { a: ["href", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      // Links open in a new tab wherever the message is shown.
      a: (tagName, attribs) => ({
        tagName,
        attribs: { href: attribs.href ?? "", target: "_blank", rel: "noopener noreferrer" },
      }),
    },
    allowedSchemesAppliedToAttributes: ["href"],
  });
  // An editor leaves "<p></p>" when emptied, and empty paragraphs at the ends.
  if (htmlToText(clean).trim() === "") return "";
  const edge = "(?:<p>(?:\\s|&nbsp;|<br\\s*/?>)*</p>)+";
  return clean.replace(new RegExp(`^${edge}|${edge}$`, "g"), "");
}

/** Whether a step's message is an email (HTML), a LinkedIn message (text) or neither. */
export function stepKind(type: string): "email" | "linkedin" | null {
  return type === "email" ? "email" : type.startsWith("linkedin") ? "linkedin" : null;
}

/** The message as it should be stored for this kind of step or template. */
export function messageFor(kind: "email" | "linkedin" | null, body: string): string;
export function messageFor(
  kind: "email" | "linkedin" | null,
  body: string | null | undefined,
): string | null | undefined;
export function messageFor(kind: "email" | "linkedin" | null, body: string | null | undefined) {
  if (body === null || body === undefined) return body;
  return kind === "email" ? cleanEmailHtml(body) : htmlToText(body);
}
