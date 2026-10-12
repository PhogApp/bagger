/**
 * Works out what a rep should send for a step.
 *
 * Order of precedence:
 *   1. the rep's edit for this one person (task override)
 *   2. the step's linked template, read live so template edits flow through
 *   3. the step's own inline subject/body
 */

import { applyMergeFields, type MergePerson } from "../../shared/merge";

export type { MergePerson };
export { applyMergeFields };

export interface ContentSources {
  task: { overrideSubject: string | null; overrideBody: string | null };
  step: { subject: string | null; body: string | null };
  template: { subject: string | null; body: string } | null;
}

export interface ResolvedContent {
  subject: string | null;
  body: string | null;
  /** True when the rep has edited this message for this person. */
  edited: boolean;
}

export function resolveContent(src: ContentSources, person: MergePerson): ResolvedContent {
  const baseSubject = src.template ? src.template.subject : src.step.subject;
  const baseBody = src.template ? src.template.body : src.step.body;
  const subject = src.task.overrideSubject ?? baseSubject;
  const body = src.task.overrideBody ?? baseBody;
  return {
    subject: subject == null ? null : applyMergeFields(subject, person),
    body: body == null ? null : applyMergeFields(body, person),
    edited: src.task.overrideSubject != null || src.task.overrideBody != null,
  };
}
