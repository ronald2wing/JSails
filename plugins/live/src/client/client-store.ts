/**
 * The normalized client store for the live layer (`@jsails/live/client`).
 *
 * A `Map<id, row>` for one collection, and nothing else. There is no matcher, no
 * sorter, and no predicate evaluation: the server already decided which rows
 * belong to a subscription, and re-deciding on the client would mean shipping
 * the query engine to the browser and keeping two implementations of the same
 * predicate in agreement (LIVE-PLAN.md §14, the Minimongo rejection).
 *
 * Ordering is therefore the consumer's job, using a position column on the row
 * (`sortOrder`, `publishedAt`, ...). The store preserves insertion order, which
 * is enough for a stable render but is not a sort.
 *
 * **One store per collection.** A `snapshot` message carries no `collection`
 * field — the client knows it from the subscription it opened — so the store is
 * bound to a collection at construction. A `change` message does carry one, and
 * a change for a different collection is ignored rather than misfiled.
 *
 * **Idempotence is the contract.** Changes carry full rows and a deployment-wide
 * sequence, so applying the same change twice must be a no-op — a reconnect can
 * replay a suffix the client already applied. The store does not track sequences
 * itself; it relies on the row being the same bytes, which is what makes a
 * duplicate apply harmless.
 *
 * **A change for an unknown id is an insert.** The client may have missed the
 * snapshot row (it subscribed mid-flight, or a change arrived before the
 * snapshot was applied), so the row is added rather than dropped. A delete for
 * an unknown id is a no-op: there is nothing to remove, and inventing a tombstone
 * would leak memory for rows this client never held.
 *
 * This module imports nothing but types, so it is safe in a browser bundle and
 * under plain Node.
 */

import type { LiveRow, LiveServerMessage } from 'jsails/live';

/** A normalized row store for one collection, fed by live server messages. */
export interface LiveClientStore {
  /** The collection this store holds. */
  readonly collection: string;
  /** Apply one server message. Messages for another collection are ignored. */
  apply(message: LiveServerMessage): void;
  /** The rows currently held, keyed by primary key. */
  rows(): ReadonlyMap<string, LiveRow>;
  /** Subscribe to any mutation. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Drop every row and notify listeners. */
  reset(): void;
}

/**
 * Create an empty {@link LiveClientStore} for `collection`.
 *
 * Listeners are notified once per `apply`/`reset` that actually changed
 * something, not once per row: a snapshot of 500 rows is one render, not 500.
 */
export function createLiveClientStore(collection: string): LiveClientStore {
  if (typeof collection !== 'string' || collection.length === 0) {
    throw new TypeError('createLiveClientStore requires a non-empty collection name');
  }

  let rows = new Map<string, LiveRow>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function applySnapshot(message: Extract<LiveServerMessage, { type: 'snapshot' }>): boolean {
    // A snapshot replaces the collection wholesale: it is the server's complete
    // answer for this subscription, so any row the client held that the server
    // no longer returns is gone. Merging instead would keep rows that were
    // deleted while the client was disconnected.
    const next = new Map<string, LiveRow>();
    for (const row of message.rows) {
      const id = rowId(row);
      if (id !== undefined) {
        next.set(id, row);
      }
    }
    rows = next;
    return true;
  }

  function applyChange(message: Extract<LiveServerMessage, { type: 'change' }>): boolean {
    if (message.collection !== collection) {
      return false;
    }
    if (message.row === null) {
      return rows.delete(message.id);
    }
    const existing = rows.get(message.id);
    if (existing !== undefined && sameRow(existing, message.row)) {
      return false;
    }
    rows.set(message.id, message.row);
    return true;
  }

  return {
    collection,

    apply(message: LiveServerMessage): void {
      let changed = false;
      if (message.type === 'snapshot') {
        changed = applySnapshot(message);
      } else if (message.type === 'change') {
        changed = applyChange(message);
      }
      // An `error` message carries no rows; the hook surfaces it as status.
      if (changed) {
        notify();
      }
    },

    rows(): ReadonlyMap<string, LiveRow> {
      return rows;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    reset(): void {
      if (rows.size === 0) {
        return;
      }
      rows = new Map();
      notify();
    },
  };
}

/**
 * Read a row's primary key.
 *
 * The wire id is a string, but the row's own `id` column may be a number, so the
 * value is normalized the same way the server normalized it. A row without an
 * `id` cannot be keyed and is skipped rather than stored under `undefined`.
 */
function rowId(row: LiveRow): string | undefined {
  const id = row['id'];
  if (typeof id === 'string') {
    return id;
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    return String(id);
  }
  return undefined;
}

/**
 * Compare two rows by their own keys and values.
 *
 * A shallow comparison is sufficient because a projected row is flat: relations
 * are excluded by `projectRow`, so every value is a scalar or `null`. A deep
 * comparison would cost more than the re-render it avoids.
 */
function sameRow(left: LiveRow, right: LiveRow): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!Object.is(left[key], right[key])) {
      return false;
    }
  }
  return true;
}
