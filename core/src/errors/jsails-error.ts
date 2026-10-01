/**
 * The base class for every value-free framework error.
 *
 * A subclass names its domain (`StrError`, `JamalError`, ...) and carries a
 * stable, machine-readable `code`; the message never echoes secrets or raw
 * input. `name` follows the subclass so logs read the concrete class without a
 * `this.name = ...` line in every constructor.
 *
 * ## Context and suggestion
 *
 * `context` is a record of scalars describing what the code was doing when it
 * failed — an identifier, a count, a path relative to the project root. It is
 * machine-readable, so a JSON or MCP consumer can act on it without parsing the
 * message. It is **not** a place for payloads: the value-free rule applies to
 * it exactly as it does to the message, so a key, a token, a request body, or
 * any raw user input never goes in.
 *
 * `suggestion` is the one-line fix a human should try next. It is a static
 * string, never interpolated with input, and the CLI renders it under the
 * message as a `hint:` line.
 */

/** A scalar a {@link JsailsError} may carry as context. */
export type JsailsErrorContextValue = string | number | boolean;

/** Options every {@link JsailsError} accepts. */
export interface JsailsErrorOptions {
  /** The underlying failure, when this error wraps one. */
  readonly cause?: unknown;
  /**
   * What the code was doing, as named scalars. Never a secret, a token, or raw
   * input — the value-free rule covers this field too.
   */
  readonly context?: Readonly<Record<string, JsailsErrorContextValue>>;
  /** The one-line fix to try next. Static text, never interpolated. */
  readonly suggestion?: string;
}

export abstract class JsailsError extends Error {
  /** Stable, machine-readable failure code. Never derived from user input. */
  abstract readonly code: string;

  /** Named scalars describing the failure. Empty when the subclass sets none. */
  readonly context: Readonly<Record<string, JsailsErrorContextValue>>;

  /** The one-line fix to try next, or `undefined` when there is none. */
  readonly suggestion: string | undefined;

  constructor(message: string, options?: JsailsErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.context = options?.context ?? {};
    this.suggestion = options?.suggestion;
  }
}
