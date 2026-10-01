/**
 * The base class for every value-free framework error.
 *
 * A subclass names its domain (`StrError`, `JamalError`, ...) and carries a
 * stable, machine-readable `code`; the message never echoes secrets or raw
 * input. `name` follows the subclass so logs read the concrete class without a
 * `this.name = ...` line in every constructor.
 */
export abstract class JsailsError extends Error {
  /** Stable, machine-readable failure code. Never derived from user input. */
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
