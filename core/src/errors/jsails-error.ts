/**
 * The base class of every framework error.
 *
 * An error is recognized by its brand (`brand.ts`), never by `instanceof`, and
 * classified by a kind and an audience (`kinds.ts`). Errors are declared through
 * a registry (`defineErrors`, `registry.ts`), which fills every field from the
 * code's definition; a hand-written subclass still works and reads as an
 * `internal`, `operator` error until its owner moves it onto a registry.
 *
 * ## Value-free
 *
 * The message never echoes secrets or raw input. `context` is a record of
 * scalars describing what the code was doing when it failed (an identifier, a
 * count, a path relative to the project root): machine-readable, so a JSON or
 * MCP consumer can act on it without parsing the message, and covered by the
 * same rule as the message, so a key, a token, a request body or any raw input
 * never goes in. A registry validates context values against the code's
 * declared value kinds at construction.
 *
 * `suggestion` is the one-line fix a human should try next: static text, never
 * interpolated with input. The CLI renders it under the message as a `hint:`
 * line.
 *
 * Browser-safe: no runtime imports beyond the error kernel's own leaves.
 */

import { ERROR_BRAND } from './brand.js';
import type { ErrorAudience, ErrorKind } from './kinds.js';

/**
 * A scalar a {@link JsailsError} may carry as context.
 *
 * @public
 */
export type JsailsErrorContextValue = string | number | boolean;

/**
 * Options every {@link JsailsError} accepts.
 *
 * @public
 */
export interface JsailsErrorOptions {
  /** The underlying failure, when this error wraps one. */
  readonly cause?: unknown;
  /**
   * What the code was doing, as named scalars. Never a secret, a token, or raw
   * input: the value-free rule covers this field too.
   */
  readonly context?: Readonly<Record<string, JsailsErrorContextValue>>;
  /** The one-line fix to try next. Static text, never interpolated. */
  readonly suggestion?: string;
  /** What went wrong, as a boundary treats it. Defaults to `internal`. */
  readonly kind?: ErrorKind;
  /** Who may read the error. Defaults to `operator`. */
  readonly audience?: ErrorAudience;
  /** Typed data the code declares (validation issues, a lock holder). */
  readonly payload?: unknown;
  /**
   * The payload members a client-audience error puts on the wire, as problem
   * extension members. Ignored for operator errors.
   */
  readonly clientFields?: Readonly<Record<string, unknown>>;
}

const EMPTY: Readonly<Record<string, never>> = Object.freeze({});

/**
 * The base of every framework error: a stable `code`, a `kind` and an
 * `audience` a boundary reads, named scalar `context`, and an optional
 * `suggestion`. Declare codes with `defineErrors` rather than subclassing this
 * by hand: a registry renders the message from validated context, so it is
 * value-free by construction. Recognize one with {@link isJsailsError} or a
 * registry's `is`, never `instanceof`.
 *
 * @public
 */
export abstract class JsailsError extends Error {
  /**
   * Stable, machine-readable failure code. Never derived from user input. A
   * registry error's code is `domain.code`.
   */
  abstract readonly code: string;

  /** Named scalars describing the failure. Empty when the error sets none. */
  readonly context: Readonly<Record<string, JsailsErrorContextValue>>;

  /** The one-line fix to try next, or `undefined` when there is none. */
  readonly suggestion: string | undefined;

  /** What went wrong, as a boundary treats it. */
  readonly kind: ErrorKind;

  /** Who may read the error. */
  readonly audience: ErrorAudience;

  /** Typed data the code declares, or `undefined`. */
  readonly payload: unknown;

  /** Payload members a client-audience error exposes on the wire. */
  readonly clientFields: Readonly<Record<string, unknown>>;

  constructor(message: string, options?: JsailsErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.context = options?.context ?? EMPTY;
    this.suggestion = options?.suggestion;
    this.kind = options?.kind ?? 'internal';
    this.audience = options?.audience ?? 'operator';
    this.payload = options?.payload;
    this.clientFields = options?.clientFields ?? EMPTY;
  }
}

Object.defineProperty(JsailsError.prototype, ERROR_BRAND, { value: true });

/**
 * True when `value` is a framework error, from this or any other copy of `jsails`.
 *
 * @public
 */
export function isJsailsError(value: unknown): value is JsailsError {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { readonly [ERROR_BRAND]?: unknown; readonly code?: unknown };
  return record[ERROR_BRAND] === true && typeof record.code === 'string';
}
