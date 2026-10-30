// Errors that carry a stable, secret-free `code`. Callers compare, log or show the code; the
// message is for the operator and may be more detailed.
export class CodedError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}
