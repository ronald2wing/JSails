/**
 * The live layer's change log contract: a bounded, append-ordered sequence
 * store.
 *
 * The log, not the capture path, is the ordering authority: it assigns the
 * durable, monotonically increasing sequence at append time and retains a
 * bounded window of changes, so a client can resume from a past sequence only
 * while the window still covers it. {@link ChangeLogSlice.truncated} is the
 * explicit "continuity lost" signal: the caller then degrades to a full
 * snapshot, exactly as Ably's `resumed: false` does (docs/design/live.md §4.5, §8).
 *
 * `@jsails/live` ships two implementations — a per-process ring for
 * single-instance deployments and tests, and Valkey Streams for multi-instance
 * deployments, whose sequence is deployment-wide. The contract is shared so a
 * transport does not need to know which backend sits behind it.
 */

import type { LiveChange } from './change-record.js';

/** A suffix of the change log, from a requested sequence forward. */
export interface ChangeLogSlice {
  readonly changes: readonly LiveChange[];
  /** True when the requested sequence predates the oldest retained entry. */
  readonly truncated: boolean;
}

/** The change log contract every backend implements. */
export interface ChangeLog {
  /**
   * Assign the next sequence to `change` and retain it. Returns the assigned
   * sequence. The capture path emits `sequence: 0`; the stored copy carries
   * the assigned sequence and `head` advances past it.
   */
  append(change: LiveChange): Promise<number>;
  /** The changes at `sequence` and later, plus whether the window still covers `sequence`. */
  since(sequence: number): Promise<ChangeLogSlice>;
  /** The last assigned sequence, or 0 before any append. */
  readonly head: number;
  close(): Promise<void>;
}
