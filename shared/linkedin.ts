/**
 * LinkedIn allows 300 characters in the note on a connection request. LinkedIn
 * templates and connection-request steps keep to it, counted as written
 * (before {firstName} and the like are filled in).
 */
export const LINKEDIN_NOTE_LIMIT = 300;

export function linkedinTooLong(text: string | null | undefined): string | null {
  const n = (text ?? "").length;
  return n > LINKEDIN_NOTE_LIMIT
    ? `LinkedIn allows ${LINKEDIN_NOTE_LIMIT} characters in a connection note; this is ${n}`
    : null;
}
