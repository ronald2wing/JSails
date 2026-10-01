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
 * Implementations (the in-process memory default and the shared Valkey/Redis
 * backend) live in `@jsails/cache`; the plugin that provides the store under
 * {@link mutexToken} lives there too.
 */

/**
 * Raised for mutex misuse or backend failure. Value-free — never echoes the
 * key, value, or backend connection detail that could leak state or
 * credentials.
 */
export class MutexError extends Error {
  /** Stable machine code identifying the failure category. */
  readonly code: 'invalid_key' | 'invalid_ttl' | 'backend_error' | 'closed';

  constructor(code: MutexError['code'], message: string) {
    super(message);
    this.name = 'MutexError';
    this.code = code;
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

  /** Release owned resources; idempotent. */
  close(): Promise<void>;
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
  return (
    typeof store.acquire === 'function' &&
    typeof store.release === 'function' &&
    typeof store.close === 'function'
  );
}
