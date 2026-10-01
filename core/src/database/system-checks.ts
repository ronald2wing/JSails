/**
 * Pure, connectionless system checks registry.
 *
 * A {@link SystemCheckFn} receives an optional {@link SystemCheckContext} and
 * returns a readonly list of {@link SystemCheck} results.  Checks that throw
 * are isolated as `error`-severity checks with a value-free message so a
 * failing check never takes down the whole run.
 *
 * @module
 */

import type { SchemaState } from '../migrations/schema-types.js';
import { JsailsError } from '../errors/jsails-error.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity the runner should attribute to a check result. */
export type CheckSeverity = 'error' | 'warning' | 'info';

/** A single check result produced by a {@link SystemCheckFn}. */
export interface SystemCheck {
  /** Stable identifier of the check that produced this result. */
  readonly id: string;
  /** The severity assigned by the check. */
  readonly severity: CheckSeverity;
  /** Human-readable description of the finding. */
  readonly message: string;
}

/** Optional context passed to every check on `run`. */
export interface SystemCheckContext {
  /**
   * Logical schema state the check may inspect.  `undefined` when the caller
   * has not resolved a schema (e.g. a check that only inspects config).
   */
  readonly schema?: SchemaState;
  /**
   * Opaque config the check may inspect.  Callers own the shape; the registry
   * forwards it verbatim.
   */
  readonly config?: unknown;
}

/** A check that produces zero or more {@link SystemCheck} results. */
export type SystemCheckFn = (context: SystemCheckContext) => readonly SystemCheck[];

/** Ordered, immutable registry of named system checks. */
export interface SystemCheckRegistry {
  /**
   * Register a check function under `id`.
   *
   * A duplicate `id` raises a value-free {@link SystemCheckError} so
   * collisions are caught at assembly time rather than at `run`.
   */
  register(id: string, fn: SystemCheckFn): void;

  /**
   * Execute every registered check in registration order and return a flat,
   * concatenated array of results.
   *
   * A check that throws is isolated: its name and a value-free default
   * message are recorded as an `error`-severity {@link SystemCheck}, then the
   * next check runs.
   */
  run(context?: SystemCheckContext): readonly SystemCheck[];
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Machine-readable reason for a {@link SystemCheckError}. */
export type SystemCheckErrorCode = 'invalid_check' | 'duplicate_check';

/**
 * Raised for an invalid registry operation. Value-free: the message never
 * echoes the thrown value of a failed check.
 */
export class SystemCheckError extends JsailsError {
  constructor(
    readonly code: SystemCheckErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an empty, connectionless {@link SystemCheckRegistry}.
 *
 * The registry holds no state beyond its ordered check map.  Nothing connects
 * and no I/O is performed until `run` is called.
 */
export function createSystemCheckRegistry(): SystemCheckRegistry {
  const entries = new Map<string, SystemCheckFn>();

  return Object.freeze({
    register(id: string, fn: SystemCheckFn): void {
      if (typeof id !== 'string' || id.length === 0) {
        throw new SystemCheckError('invalid_check', 'check id must be a non-empty string');
      }
      if (typeof fn !== 'function') {
        throw new SystemCheckError('invalid_check', 'check fn must be a function');
      }
      if (entries.has(id)) {
        throw new SystemCheckError('duplicate_check', 'a check with this id is already registered');
      }
      entries.set(id, fn);
    },

    run(context: SystemCheckContext = {}): readonly SystemCheck[] {
      const results: SystemCheck[] = [];
      for (const [id, fn] of entries) {
        let checkResults: readonly SystemCheck[];
        try {
          checkResults = fn(context);
        } catch {
          checkResults = [{ id, severity: 'error', message: 'The check threw an exception.' }];
        }
        for (const result of checkResults) {
          results.push(result);
        }
      }
      return Object.freeze(results);
    },
  });
}

// ---------------------------------------------------------------------------
// Definition helper
// ---------------------------------------------------------------------------

/**
 * Pair an id with a check function into a definition descriptor.
 *
 * The result carries `id` and `fn` by identity so callers can register checks
 * in registration order via the registry without an intermediate map.
 */
export function defineSystemCheck(
  id: string,
  fn: SystemCheckFn,
): { readonly id: string; readonly fn: SystemCheckFn } {
  return Object.freeze({ id, fn });
}
