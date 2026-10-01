/**
 * The live layer's wire record: a single committed row change, projected to a
 * complete row.
 *
 * A {@link LiveChange} is the only thing the change source emits and the only
 * thing the transport pushes. There is no field-level delta — the row is a full
 * projection, so a removed field is simply absent from {@link row} and applying
 * the same change twice is a no-op. There is no `version` column either: full
 * rows make both unnecessary (LIVE-PLAN.md §4.1, §14 defect 7).
 */

/** The three operations a change can represent. */
export type LiveChangeOperation = 'insert' | 'update' | 'delete';

/** A complete projected row — scalar columns only, frozen. */
export type LiveRow = Readonly<Record<string, unknown>>;

/** A single committed row change, ready for the change log and transport. */
export interface LiveChange {
  /** Monotonic sequence assigned by the change log. */
  readonly sequence: number;
  /** Client-visible collection key from the publication. */
  readonly collection: string;
  /** Primary key, normalized to string. */
  readonly id: string;
  readonly operation: LiveChangeOperation;
  /** Complete projected row. `null` for delete. */
  readonly row: LiveRow | null;
  readonly at: number;
}

const OPERATIONS: readonly LiveChangeOperation[] = ['insert', 'update', 'delete'];

/**
 * Whether `value` is a well-formed {@link LiveChange}.
 *
 * Structural only: verifies the field types and that `row` is a plain object
 * (or `null` for a delete). It does not validate that `sequence` is positive or
 * `at` is a plausibly-recent epoch — the change log and capture path own those
 * invariants.
 */
export function isLiveChange(value: unknown): value is LiveChange {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.sequence !== 'number' || !Number.isFinite(record.sequence)) {
    return false;
  }
  if (typeof record.collection !== 'string') {
    return false;
  }
  if (typeof record.id !== 'string') {
    return false;
  }
  if (!OPERATIONS.includes(record.operation as LiveChangeOperation)) {
    return false;
  }
  if (record.row !== null && !isPlainObject(record.row)) {
    return false;
  }
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) {
    return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
