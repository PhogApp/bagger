export class NotFoundError extends Error {
  constructor(what = "Record") {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

/** The request was understood but breaks a rule (bad reference, wrong type). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface DuplicateMatch {
  type: "lead" | "contact" | "account";
  id: string;
  /** Who or what it is, for the person deciding: "Jill Rude, Redfield Energy". */
  label: string;
}

/** The record being created looks like one Bagger already has. */
export class DuplicateError extends Error {
  constructor(public readonly matches: DuplicateMatch[]) {
    super("Already in Bagger");
    this.name = "DuplicateError";
  }
}
