/**
 * The live layer's write fence (LIVE-PLAN.md §4.6, §6.4).
 *
 * A port of Meteor's `writefence.js` `minWriteFence`/`onAllWritesCommitted`
 * semantics with the one addition revision 1 missed: {@link WriteFence.endWrite}.
 * The fence keeps a snapshot query and the change-capture flush from
 * interleaving:
 *
 * - the snapshot reader calls {@link beginWrite} before the query and
 *   {@link arm} after the snapshot is emitted;
 * - the capture flush calls {@link beginWrite}/{@link endWrite} around its
 *   publish.
 *
 * A change that commits while the snapshot query is in flight therefore
 * increments `outstanding` and sits behind the fence; its queued callbacks fire
 * only once {@link arm} has been called *and* `outstanding` has returned to
 * zero. Both sides must participate — a fence with only the reader counts
 * nothing (LIVE-PLAN.md §14 correction 9).
 */

export interface WriteFence {
  /** Open a write region; queued callbacks are held until it is closed. */
  beginWrite(): void;
  /** Close one region; when the last region closes, queued callbacks flush. */
  endWrite(): void;
  /**
   * Permit flush once `outstanding` reaches zero. Writes already begun keep
   * blocking; only after their regions all close does the queue drain.
   */
  arm(): void;
  /** Register a callback to run once armed and every write region has closed. */
  onAllCommitted(callback: () => void): void;
  /** The number of open write regions. */
  readonly outstanding: number;
}

/**
 * Create a write fence.
 *
 * The fence tracks `outstanding` write regions and a boolean `armed` flag plus
 * a queue of pending callbacks. A callback entering {@link onAllCommitted}
 * fires immediately when the fence is already armed and idle; otherwise it
 * queues. Any transition that leaves the fence armed with `outstanding === 0`
 * drains the queue first-in-first-out.
 */
export function createWriteFence(): WriteFence {
  let armed = false;
  let outstanding = 0;
  let queue: (() => void)[] = [];

  function flushSafely(): void {
    if (queue.length === 0) {
      return;
    }
    const pending = queue;
    queue = [];
    for (const callback of pending) {
      callback();
    }
  }

  function signalReady(): void {
    if (armed && outstanding === 0) {
      flushSafely();
    }
  }

  return {
    beginWrite(): void {
      outstanding++;
    },

    endWrite(): void {
      if (outstanding === 0) {
        // An unmatched endWrite is a logic error; rejecting it loudly beats
        // letting a mismatched region silently corrupt `outstanding` forever.
        throw new Error('write fence endWrite without a matching beginWrite');
      }
      outstanding--;
      signalReady();
    },

    arm(): void {
      armed = true;
      signalReady();
    },

    onAllCommitted(callback): void {
      if (armed && outstanding === 0) {
        callback();
        return;
      }
      queue.push(callback);
    },

    get outstanding(): number {
      return outstanding;
    },
  };
}
