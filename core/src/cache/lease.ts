/**
 * Lease store contract (`jsails/cache`): fenced, expiring, owner-checked locks,
 * and {@link withLease}, the one loop that holds a lease while work runs.
 *
 * A lease is not a cache entry. A cache may drop any entry under memory
 * pressure; a lease store never drops a live lease, so it is a separate
 * contract with separate state (`@jsails/cache` keeps the in-memory leases in
 * their own structure and the Valkey leases under their own prefix, optionally
 * on a second server).
 *
 * Every acquisition returns a {@link Lease} carrying a random owner token and
 * a fencing number. `renew` and `release` act only while that exact lease
 * still holds the key, so a holder whose lease expired can neither extend nor
 * delete the next holder's. The fence grows with every acquisition of a store,
 * so a resource that records the highest fence it has seen can refuse a write
 * from a holder that lost its lease while paused.
 */

import { invariant } from '../errors/registry.js';
import { CacheErrors } from './cache-errors.js';
import { assertCacheKey, assertTtlMs } from './store.js';

/**
 * One acquisition of a key. Frozen plain data: keep it to renew or release.
 *
 * @public
 */
export interface Lease {
  /** The key this lease holds. */
  readonly key: string;
  /** The random, unguessable owner token. */
  readonly token: string;
  /**
   * The fencing number: a positive integer larger than that of every earlier
   * acquisition from the same store.
   */
  readonly fence: number;
}

/**
 * A store of fenced, expiring leases. A live lease is never evicted. Every
 * method validates its arguments with `CacheErrors` codes, rejects
 * `unavailable` on a backend failure, and `closed` after `close`.
 *
 * @public
 */
export interface LeaseStore {
  /**
   * Take `key` for `ttlMs` milliseconds: the new lease when the key was free
   * or its holder's lease had expired, `null` while another lease holds it.
   */
  acquire(key: string, ttlMs: number): Promise<Lease | null>;
  /**
   * Extend `lease` to `ttlMs` from now. Resolves `false`, changing nothing,
   * when the lease expired or another lease holds the key.
   */
  renew(lease: Lease, ttlMs: number): Promise<boolean>;
  /**
   * Free the key `lease` holds. Resolves `false`, changing nothing, when the
   * lease expired or another lease holds the key.
   */
  release(lease: Lease): Promise<boolean>;
  /** Stop the store; later calls reject `closed`. Idempotent. */
  close(): Promise<void>;
}

/**
 * Throw `cache.invalid_lease` unless `lease` has the shape of a {@link Lease}.
 *
 * @public
 */
export function assertLease(lease: unknown): asserts lease is Lease {
  const candidate = lease as Partial<Lease> | null;
  invariant(
    candidate !== null &&
      typeof candidate === 'object' &&
      typeof candidate.key === 'string' &&
      candidate.key.length > 0 &&
      typeof candidate.token === 'string' &&
      candidate.token.length > 0 &&
      typeof candidate.fence === 'number' &&
      Number.isSafeInteger(candidate.fence) &&
      candidate.fence > 0,
    CacheErrors,
    'invalid_lease',
  );
}

/**
 * Whether `value` has every {@link LeaseStore} method. Configuration checks
 * use it so a malformed store fails at startup rather than on first use.
 *
 * @public
 */
export function isLeaseStore(value: unknown): value is LeaseStore {
  if (value === null || typeof value !== 'object') return false;
  const store = value as Partial<LeaseStore>;
  return (
    typeof store.acquire === 'function' &&
    typeof store.renew === 'function' &&
    typeof store.release === 'function' &&
    typeof store.close === 'function'
  );
}

/**
 * Options for {@link withLease}.
 *
 * @public
 */
export interface WithLeaseOptions {
  /** The lease lifetime; the lease is renewed every third of it while `run` runs. */
  readonly ttlMs: number;
  /**
   * The caller's cancellation. Once it has aborted, `run` may have been
   * abandoned while still executing, so the lease is left to expire instead of
   * being released.
   */
  readonly signal?: AbortSignal;
}

/**
 * What {@link withLease} did: ran the work under the lease, or found the key
 * held and ran nothing.
 *
 * @public
 */
export type LeaseOutcome<T> =
  { readonly acquired: true; readonly value: T } | { readonly acquired: false };

/**
 * Run `work` while holding a lease on `key`. Resolves `{ acquired: false }`
 * without running anything when another lease holds the key. Otherwise the
 * lease is renewed every `ttlMs / 3` while `work` runs, and the signal handed
 * to `work` aborts with `cache.invalid_lease` once the lease may be lost:
 * when a renewal finds it gone, or when `ttlMs` has passed since the last
 * acquisition or renewal that succeeded was sent (renewals that keep failing,
 * as in a partition from the store, let the lease expire on the server and
 * another process take it). The lease is released when `work` settles,
 * unless `options.signal` aborted first (see {@link WithLeaseOptions.signal}).
 * A failed renewal is retried on the next tick and a failed release is left
 * to expire: neither replaces the outcome of `work`, whose result or error
 * propagates unchanged.
 *
 * @public
 */
export async function withLease<T>(
  store: LeaseStore,
  key: string,
  options: WithLeaseOptions,
  work: (lease: Lease, signal: AbortSignal) => Promise<T>,
): Promise<LeaseOutcome<T>> {
  assertCacheKey(key);
  invariant(options !== null && typeof options === 'object', CacheErrors, 'invalid_option', {
    option: 'withLease',
  });
  const { ttlMs, signal } = options;
  assertTtlMs(ttlMs);

  const lost = new AbortController();
  const loseLease = (): void => {
    lost.abort(new CacheErrors.Error('invalid_lease'));
  };
  // Each deadline starts when its request is sent, so it falls no later than
  // the expiry the store sets on receiving it, whatever the round trip took.
  const deadline = (): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(loseLease, ttlMs);
    // The deadline must never keep a draining process alive on its own.
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  };
  let expiry = deadline();
  let lease: Lease | null;
  try {
    lease = await store.acquire(key, ttlMs);
  } catch (error) {
    clearTimeout(expiry);
    throw error;
  }
  if (lease === null) {
    clearTimeout(expiry);
    return { acquired: false };
  }
  const held = lease;

  const forward = (): void => {
    lost.abort(signal?.reason);
  };
  if (signal?.aborted === true) forward();
  else signal?.addEventListener('abort', forward, { once: true });

  let pending: ReturnType<typeof setTimeout> | undefined;
  const renewal = setInterval(
    () => {
      if (pending !== undefined || lost.signal.aborted) return;
      const next = deadline();
      pending = next;
      store.renew(held, ttlMs).then(
        (renewed) => {
          pending = undefined;
          if (renewed) {
            clearTimeout(expiry);
            expiry = next;
          } else {
            clearTimeout(next);
            loseLease();
          }
        },
        () => {
          // A backend failure is retried on the next tick, under the deadline
          // of the last renewal that succeeded; if the lease is truly gone,
          // the compare-and-delete release leaves the new holder be.
          pending = undefined;
          clearTimeout(next);
        },
      );
    },
    Math.max(1, Math.floor(ttlMs / 3)),
  );
  // Renewal must never keep a draining process alive on its own.
  (renewal as unknown as { unref?: () => void }).unref?.();

  try {
    return { acquired: true, value: await work(held, lost.signal) };
  } finally {
    clearInterval(renewal);
    clearTimeout(expiry);
    if (pending !== undefined) clearTimeout(pending);
    signal?.removeEventListener('abort', forward);
    if (signal?.aborted !== true) {
      try {
        await store.release(held);
      } catch {
        // The lease expires with its TTL; the work's own outcome wins.
      }
    }
  }
}
