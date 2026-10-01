/**
 * Mutex store contract (`jsails/cache`): a narrow, atomic acquire/release
 * lock-store surface, independent from the {@link CacheStore} contract.
 *
 * A cache is pure data whose writes are always idempotent ("set this value")
 * and whose reads are always safe to retry; a mutex carries ownership and lock
 * semantics — the caller must atomically acquire a key only when it is absent,
 * and an accidental double-release must not disturb another caller's lock. A
 * {@link CacheStore} only provides a plain `set` (always overwrites), so it
 * cannot express that atomic acquire without an unsafe read-then-write gap.
 *
 * The optional lease methods (`acquireLease`/`renewLease`/`releaseLease`) add
 * ownership: the acquirer gets a random token, and only that token can renew
 * or release the entry. Without them, `release(key)` deletes whatever entry
 * holds the key, so a caller whose lock already expired could delete the next
 * holder's lock; callers that hold a lock for long (overlap control) prefer
 * the lease methods whenever a store provides them.
 *
 * Implementations (the in-process memory default and the shared Valkey
 * backend) live in `@jsails/cache`; the plugin that provides the store under
 * {@link mutexToken} lives there too.
 */

import { JsailsError } from '../errors/jsails-error.js';

/** Stable machine code carried by {@link MutexError}. */
export type MutexErrorCode = 'invalid_key' | 'invalid_ttl' | 'unavailable' | 'closed';

/**
 * Raised for mutex misuse or backend failure. Value-free — never echoes the
 * key, value, or backend connection detail that could leak state or
 * credentials.
 */
export class MutexError extends JsailsError {
  constructor(
    readonly code: MutexErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Atomic acquire/release lock store.
 *
 * The acquire/release pair models a distributed mutex: a caller acquires a
 * named key with a bounded TTL, holds it while the operation runs, and
 * releases it when done. If the operation crashes, the TTL acts as a safety
 * net — the key expires automatically and the next caller can acquire it.
 */
export interface MutexStore {
  /**
   * Acquire atomically: resolves `true` only when this call created the entry
   * (the key was absent or its existing entry had already expired). Resolves
   * `false` when another caller holds the key.
   *
   * `ttlMs` is the lock lifetime in milliseconds; it must be positive and
   * finite. The entry is not refreshed — callers that hold a lock past its TTL
   * may find another caller has taken it.
   */
  acquire(key: string, ttlMs: number): Promise<boolean>;

  /**
   * Release an entry; a no-op when the key is absent. Idempotent — releasing
   * an already-released key does not error and does not disturb another
   * caller's lock.
   */
  release(key: string): Promise<void>;

  /**
   * Acquire atomically with an owner token: resolves the token when this call
   * created the entry, or `undefined` when another caller holds the key. The
   * token is random and unguessable; keep it to renew or release.
   */
  acquireLease?(key: string, ttlMs: number): Promise<string | undefined>;

  /**
   * Extend the entry's lifetime to `ttlMs` from now, only while `token` still
   * owns it (compare-and-expire). Resolves `false` when the lease was lost.
   */
  renewLease?(key: string, token: string, ttlMs: number): Promise<boolean>;

  /**
   * Delete the entry only while `token` still owns it (compare-and-delete).
   * Resolves `false` when the lease had already expired or changed hands, in
   * which case the current holder's entry is left untouched.
   */
  releaseLease?(key: string, token: string): Promise<boolean>;

  /** Release owned resources; idempotent. */
  close(): Promise<void>;
}

/** A {@link MutexStore} that implements the owner-token lease methods. */
export type LeaseMutexStore = MutexStore &
  Required<Pick<MutexStore, 'acquireLease' | 'renewLease' | 'releaseLease'>>;

/** Whether `store` implements the full lease surface (all three methods). */
export function supportsLeases(store: MutexStore): store is LeaseMutexStore {
  return (
    typeof store.acquireLease === 'function' &&
    typeof store.renewLease === 'function' &&
    typeof store.releaseLease === 'function'
  );
}

/**
 * Structural guard for a {@link MutexStore}. Used by the plugin and the jobs
 * runtime so a malformed store fails at configuration time, not on first run.
 */
export function isMutexStore(value: unknown): value is MutexStore {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const store = value as Partial<MutexStore>;
  const optional = [store.acquireLease, store.renewLease, store.releaseLease];
  return (
    typeof store.acquire === 'function' &&
    typeof store.release === 'function' &&
    typeof store.close === 'function' &&
    optional.every((method) => method === undefined || typeof method === 'function')
  );
}
