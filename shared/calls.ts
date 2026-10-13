/**
 * How a call from a Phone Call step went. Bagger can't tell whether a call
 * happened; the rep says when completing the step. Kept apart from the schema
 * so the browser can use it without the database code.
 */
export const CALL_OUTCOMES = ["connected", "voicemail", "no_answer"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  connected: "Connected",
  voicemail: "Voicemail",
  no_answer: "No Answer",
};
