/**
 * Cache store contract (`jsails/cache`): a narrow, string-keyed, TTL-bounded
 * cache surface.
 *
 * Implementations (the in-memory default and the Valkey/Redis backend) live in
 * `@jsails/cache`; the plugin that provides the store under {@link cacheToken}
 * lives there too. Core keeps only this contract so consumers can depend on the
 * surface without importing the implementation package.
 */

/**
 * Raised for every cache failure that reaches the caller. Messages are
 * value-free: no URL, key, or backend detail that could leak credentials is
 * ever embedded.
 */
export class CacheError extends Error {
  /** Stable machine code extracted from the underlying error, when available. */
  readonly code: string | undefined;

  constructor(message: string, options?: { code?: string }) {
    super(message);
    this.name = 'CacheError';
    this.code = options?.code;
  }
}

/**
 * A string-keyed cache with TTL-bounded entries and an in-flight-deduplicating
 * `remember`. Implementations own their connection; `close` is idempotent.
 */
export interface CacheStore {
  /** Read an entry, or `null` when absent or expired. */
  get(key: string): Promise<string | null>;
  /** Write an entry that expires `ttlMs` milliseconds from now. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Remove an entry; a no-op when absent. */
  delete(key: string): Promise<void>;
  /** Get-or-load: deduplicates concurrent loads for the same key in-process. */
  remember(key: string, ttlMs: number, loader: () => Promise<string>): Promise<string>;
  /** Release owned resources; idempotent. */
  close(): Promise<void>;
}
