/**
 * Email messages (email templates, email steps and a rep's edit of one) are
 * stored as a small, safe subset of HTML: paragraphs, line breaks, bold,
 * italic, underline, links and lists. LinkedIn messages stay plain text,
 * because LinkedIn has no formatting.
 *
 * These helpers run in the browser and on the server. Cleaning untrusted HTML
 * happens on the server only (server/sequences/html.ts).
 */

/** The tags an email message may contain. */
export const EMAIL_TAGS = ["p", "br", "strong", "b", "em", "i", "u", "a", "ul", "ol", "li"];

const TAG = new RegExp(`</?(${EMAIL_TAGS.join("|")})(\\s[^>]*)?/?>`, "i");

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** True when the text already uses email formatting tags. */
export function looksLikeHtml(text: string): boolean {
  return TAG.test(text);
}

/** Plain text as email HTML: blank lines start paragraphs, single line breaks stay. */
export function textToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "");
  if (paragraphs.length === 0) return "";
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

/**
 * Email HTML as plain text, for LinkedIn, activity notes and the plain copy
 * placed beside the formatted one. Links keep their address in brackets when
 * it differs from the words; list items become bullets or numbers.
 */
export function htmlToText(html: string): string {
  if (!looksLikeHtml(html)) return html;
  // One pass over the list tags, so each list numbers (or bullets) its own items.
  const lists: number[] = [];
  const text = html
    .replace(/\r?\n/g, "")
    .replace(
      /<a\s[^>]*href\s*=\s*"([^"]*)"[^>]*>(.*?)<\/a>/gi,
      (_m, href: string, words: string) => {
        const plain = words.replace(/<[^>]+>/g, "");
        const target = href.replace(/^mailto:/i, "");
        return plain === target || plain === href ? plain : `${plain} (${target})`;
      },
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(\/?)(ol|ul|li)\b[^>]*>/gi, (_m, close: string, tag: string) => {
      const name = tag.toLowerCase();
      if (name === "li") {
        if (close) return "\n";
        const top = lists.length - 1;
        if (top >= 0 && lists[top] >= 0) return `${++lists[top]}. `;
        return "• ";
      }
      if (close) lists.pop();
      else lists.push(name === "ol" ? 0 : -1);
      return "\n";
    })
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name] ?? whole);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
