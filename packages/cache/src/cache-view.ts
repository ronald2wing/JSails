/**
 * The namespaced view both cache stores hand out: argument checks, the
 * `closed` rule, and key prefixing live here once, over a {@link CacheKeyspace}
 * that only ever sees validated, fully prefixed keys.
 *
 * A view's keys are `<parent prefix><name>:<key>`. Namespace names refuse `:`,
 * so sibling views can never address the same key. Views are memoized per name,
 * so `namespace('pages')` returns one object for the life of its parent, and a
 * consumer that keys bookkeeping by store identity keeps it across calls.
 *
 * Because one view is shared by every consumer of its name, only the root
 * view's `close` stops anything: a namespace view's `close` is a no-op, so a
 * plugin that closes the store it was handed never stops it for the rest of
 * the app (nor for itself on a later `cache(name)`).
 */

import {
  CacheErrors,
  assertCacheKey,
  assertCacheNamespace,
  assertCacheValue,
  assertTtlMs,
  type CacheStore,
  type CacheValue,
} from 'jsails/cache';

/** Operations on one keyspace; every key arrives validated and prefixed. */
export interface CacheKeyspace {
  /** Whether the owner closed the keyspace. */
  readonly closed: boolean;
  get(key: string): Promise<CacheValue | null>;
  getMany(keys: readonly string[]): Promise<(CacheValue | null)[]>;
  set(key: string, value: CacheValue, ttlMs: number): Promise<void>;
  add(key: string, value: CacheValue, ttlMs: number): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Stop the keyspace; called once, by the root view's `close`. */
  close(): Promise<void>;
}

class CacheView implements CacheStore {
  readonly #space: CacheKeyspace;
  readonly #prefix: string;
  readonly #parent: CacheView | undefined;
  readonly #children = new Map<string, CacheView>();
  /** Set on the root view only; a namespace view is closed through it. */
  #closed = false;

  constructor(space: CacheKeyspace, prefix: string, parent: CacheView | undefined) {
    this.#space = space;
    this.#prefix = prefix;
    this.#parent = parent;
  }

  get #isClosed(): boolean {
    return (
      this.#closed || this.#space.closed || (this.#parent !== undefined && this.#parent.#isClosed)
    );
  }

  #assertOpen(): void {
    if (this.#isClosed) throw new CacheErrors.Error('closed', { store: 'cache' });
  }

  async get(key: string): Promise<CacheValue | null> {
    assertCacheKey(key);
    this.#assertOpen();
    return this.#space.get(this.#prefix + key);
  }

  async getMany(keys: readonly string[]): Promise<(CacheValue | null)[]> {
    if (!Array.isArray(keys)) throw new CacheErrors.Error('invalid_key');
    const prefixed = keys.map((key: unknown) => {
      assertCacheKey(key);
      return this.#prefix + key;
    });
    this.#assertOpen();
    if (prefixed.length === 0) return [];
    return this.#space.getMany(prefixed);
  }

  async set(key: string, value: CacheValue, ttlMs: number): Promise<void> {
    assertCacheKey(key);
    assertCacheValue(value);
    assertTtlMs(ttlMs);
    this.#assertOpen();
    await this.#space.set(this.#prefix + key, value, ttlMs);
  }

  async add(key: string, value: CacheValue, ttlMs: number): Promise<boolean> {
    assertCacheKey(key);
    assertCacheValue(value);
    assertTtlMs(ttlMs);
    this.#assertOpen();
    return this.#space.add(this.#prefix + key, value, ttlMs);
  }

  async delete(key: string): Promise<void> {
    assertCacheKey(key);
    this.#assertOpen();
    await this.#space.delete(this.#prefix + key);
  }

  namespace(name: string): CacheStore {
    assertCacheNamespace(name);
    this.#assertOpen();
    let child = this.#children.get(name);
    if (child === undefined) {
      child = new CacheView(this.#space, `${this.#prefix}${name}:`, this);
      this.#children.set(name, child);
    }
    return child;
  }

  async close(): Promise<void> {
    if (this.#parent !== undefined || this.#closed) return;
    this.#closed = true;
    this.#children.clear();
    if (!this.#space.closed) await this.#space.close();
  }
}

/** The root view of `space`: its `close` closes the keyspace and every view. */
export function rootCacheView(space: CacheKeyspace): CacheStore {
  return new CacheView(space, '', undefined);
}
