/**
 * A lazy min-heap of `(expiresAt, key)` pairs: how the in-memory stores find
 * every expired entry in O(k log n) instead of scanning the whole map.
 *
 * Nodes are never removed when an entry is replaced, renewed, or deleted; the
 * owner decides on {@link ExpiryHeap.drain} whether a popped key is still
 * expired, so a stale node costs one map lookup. {@link ExpiryHeap.compact}
 * rebuilds the heap from the live entries once stale nodes outnumber them, so
 * the heap stays within a constant factor of the map.
 */

interface ExpiryNode {
  readonly expiresAt: number;
  readonly key: string;
}

/** Stale nodes tolerated beyond twice the live entries before a rebuild. */
const COMPACT_SLACK = 64;

export class ExpiryHeap {
  #nodes: ExpiryNode[] = [];

  /** The number of nodes, stale ones included. */
  get size(): number {
    return this.#nodes.length;
  }

  push(expiresAt: number, key: string): void {
    const nodes = this.#nodes;
    nodes.push({ expiresAt, key });
    let index = nodes.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.#at(parent).expiresAt <= this.#at(index).expiresAt) break;
      this.#swap(index, parent);
      index = parent;
    }
  }

  /** Pop every node due at or before `now` and hand its key to `visit`. */
  drain(now: number, visit: (key: string) => void): void {
    while (this.#nodes.length > 0 && this.#at(0).expiresAt <= now) {
      visit(this.#pop().key);
    }
  }

  /** Rebuild from `live` once stale nodes outnumber the live entries. */
  compact(liveCount: number, live: () => Iterable<readonly [string, number]>): void {
    if (this.#nodes.length <= liveCount * 2 + COMPACT_SLACK) return;
    this.#nodes = [];
    for (const [key, expiresAt] of live()) this.push(expiresAt, key);
  }

  clear(): void {
    this.#nodes = [];
  }

  #pop(): ExpiryNode {
    const nodes = this.#nodes;
    const top = this.#at(0);
    const last = nodes.pop() as ExpiryNode;
    if (nodes.length === 0) return top;
    nodes[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < nodes.length && this.#at(left).expiresAt < this.#at(smallest).expiresAt) {
        smallest = left;
      }
      if (right < nodes.length && this.#at(right).expiresAt < this.#at(smallest).expiresAt) {
        smallest = right;
      }
      if (smallest === index) return top;
      this.#swap(index, smallest);
      index = smallest;
    }
  }

  #at(index: number): ExpiryNode {
    return this.#nodes[index] as ExpiryNode;
  }

  #swap(a: number, b: number): void {
    const nodes = this.#nodes;
    const held = this.#at(a);
    nodes[a] = this.#at(b);
    nodes[b] = held;
  }
}
