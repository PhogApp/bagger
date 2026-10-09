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
