/**
 * The live layer's multiplexer (LIVE-PLAN.md §4.7).
 *
 * {@link createMultiplexer} shares one change handler across subscriptions that
 * present the identical key, so N clients with the same publication, params,
 * and identity cost one driver. The key is built by the live service, **not**
 * the multiplexer, and includes the resolved identity — keying only on
 * `publication:params` would leak rows across users whose `query` filters by
 * `user.id` (LIVE-PLAN.md §14 blocker 3, §7 rule 9). The multiplexer is
 * identity-agnostic: it has no concept of what a key means, it only deduplicates
 * handlers by string equality, which is exactly what makes the identity-isolation
 * guarantee the service's responsibility rather than a second-class one here.
 */

import type { LiveChange } from './change-record.js';

/** Handles a fan-out change for every subscription sharing one key. */
export type LiveChangeHandler = (change: LiveChange) => void;

export interface Multiplexer {
  /**
   * Register `handler` under `key`. Identical keys share one driver; distinct
   * keys never do. Returns an unsubscribe function that removes the handler
   * (and tears down the shared slot when it was the last one).
   */
  register(key: string, handler: LiveChangeHandler): () => void;
  close(): Promise<void>;
  /**
   * The number of distinct keys currently registered — the active driver count.
   * The live service uses this to bound fan-out; tests use it to observe that
   * two registrations sharing a key collapse to one slot while two identities
   * do not.
   */
  readonly size: number;
}

/** A multiplexed slot: the shared driver plus every handler bound to it. */
interface Slot {
  handlers: Set<LiveChangeHandler>;
}

/**
 * Create a multiplexer.
 *
 * The first `register` for a key installs the key's driver as a pass-through
 * that forwards each change to every registered handler for that key (and only
 * that key). Later registers under the same key append their handler to the
 * same slot, so fan-out to M distinct keys is `O(M × distinct ids)` rather than
 * `O(subscriptions)` (LIVE-PLAN.md §10).
 */
export function createMultiplexer(): Multiplexer {
  const slots = new Map<string, Slot>();
  let closed = false;

  return {
    register(key, handler): () => void {
      if (closed) {
        throw new Error('the multiplexer is closed');
      }
      let slot = slots.get(key);
      if (slot === undefined) {
        slot = { handlers: new Set() };
        slots.set(key, slot);
      }
      slot.handlers.add(handler);
      let unsubscribed = false;
      return () => {
        if (unsubscribed) {
          return;
        }
        unsubscribed = true;
        const current = slots.get(key);
        current?.handlers.delete(handler);
        if (current !== undefined && current.handlers.size === 0) {
          slots.delete(key);
        }
      };
    },

    async close(): Promise<void> {
      closed = true;
      slots.clear();
    },

    get size(): number {
      return slots.size;
    },
  };
}
