/**
 * The single-instance {@link ChangeLog}: a per-process ring buffer.
 *
 * It assigns the sequence at append time and retains a bounded window of
 * changes (by count and by bytes). Because the sequence is per-process, a
 * client that could reconnect to a different instance must use the Valkey log,
 * whose sequence is deployment-wide (docs/design/live.md §9, §14 item 5).
 */

import type { ChangeLog, LiveChange } from 'jsails/live';

/** Bounds for the in-memory log's retention window. */
export interface InMemoryChangeLogOptions {
  /** Maximum retained changes, evicting oldest first. Defaults to 1000. */
  readonly maxChanges?: number;
  /** Maximum retained bytes, evicting oldest first. Defaults to 5 MiB. */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_CHANGES = 1000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * A {@link ChangeLog} backed by an in-memory ring buffer.
 *
 * Sequence assignment is append-time and strictly monotonic from 1. The buffer
 * is bounded by count and by retained bytes independently — whichever bound is
 * hit first evicts the oldest entry — so `since` reports `truncated` whenever
 * the requested sequence has already been evicted. Bytes are a coarse
 * approximation of a change's payload size (its JSON form), not an exact wire
 * cost; the bound is a guard, not a quota.
 */
export function createInMemoryChangeLog(options: InMemoryChangeLogOptions = {}): ChangeLog {
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let nextSequence = 1;
  let retainedBytes = 0;
  let closed = false;
  const entries: LiveChange[] = [];

  return {
    async append(change) {
      if (closed) {
        throw new Error('the change log is closed');
      }
      // The log, not the capture path, is the ordering authority
      // (docs/design/live.md §4.1): the capture's `sequence: 0` is replaced on
      // the stored copy and never escapes.
      const sequence = nextSequence++;
      const stored: LiveChange = { ...change, sequence };
      entries.push(stored);
      retainedBytes += measureBytes(stored);
      evict();
      return sequence;
    },

    async since(sequence) {
      const oldest = entries[0]?.sequence;
      // `sequence` is 1-based; a request at or before the first retained entry
      // is in range. `sequence <= oldest` is truncated only when the log has
      // evicted up to and past it (an empty log means nothing to resume from).
      const truncated = sequence > 0 && (oldest === undefined || sequence < oldest);
      const changes = entries.filter((entry) => entry.sequence >= sequence);
      return { changes, truncated };
    },

    get head() {
      return nextSequence - 1;
    },

    async close() {
      closed = true;
      entries.length = 0;
      retainedBytes = 0;
    },
  };

  /**
   * Evict oldest entries until both the count and byte bounds hold. At least
   * the newest entry is always retained: dropping it would empty the log at
   * HEAD and break a live client's stream, so a single oversized entry is
   * tolerated (the bound is a guard, not a quota).
   */
  function evict(): void {
    while (entries.length > maxChanges || (entries.length > 1 && retainedBytes > maxBytes)) {
      const dropped = entries.shift();
      if (dropped === undefined) {
        return;
      }
      retainedBytes -= measureBytes(dropped);
    }
  }
}

/** Approximate an entry's retained byte cost from its JSON form. */
function measureBytes(change: LiveChange): number {
  return JSON.stringify(change).length;
}
