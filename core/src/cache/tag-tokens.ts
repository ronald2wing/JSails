/**
 * Cache tag tokens (`jsails/cache`): the app-wide table that tells a defined
 * cache whether an entry is still valid.
 *
 * A tag names a slice of data (`blog:t1`, `jsails.flags`). Its current
 * version is an opaque random token kept in the application cache store, so
 * every process that shares the store shares the tokens. An entry records the
 * tokens of its tags when it is loaded and stays valid while they are still
 * current; invalidating a tag mints a new token, which no entry recorded.
 * A token the store lost (evicted, expired, a restarted memory store) reads
 * as missing, and the reader mints a fresh one, so a lost token invalidates
 * rather than revives: there is no counter to reset.
 *
 * Each process keeps the tokens it has read in a bounded local table, so a
 * warm tag costs no round trip. The table is kept current by three means:
 *
 * - an invalidation in this process changes the local token at once, before
 *   the store write, so no later read in the process sees the old one;
 * - a {@link CacheTagBus} message from another process marks its tags cold,
 *   so the next read fetches them from the store (the store is authoritative,
 *   and messages may arrive in any order); and
 * - every `syncMs` the table re-reads every warm tag in one `getMany` per
 *   thousand tags, which bounds how long a lost message, a bus outage, or an
 *   evicted token can go unnoticed. A failed sync marks every tag cold.
 *
 * {@link CacheTags.sequence} moves on every local change of the table and on
 * every invalidation another process announces, so a defined cache can tell,
 * without a round trip, that nothing changed since an entry was checked, and
 * that an invalidation landed while a value loaded. A cold read is joined
 * only by reads that start at the sequence it started at, and installs its
 * tokens only when the sequence has not moved, so no read after a change is
 * answered from before it.
 *
 * The bus is best effort. The first cold reads wait for the subscription, so
 * a healthy bus delivers every invalidation from the first read on; once a
 * subscription attempt fails, reads stop waiting for it, attempts are retried
 * from the sync timer with a doubling backoff (from `syncMs`, at most a
 * minute), and the sync bounds staleness meanwhile. Tokens read or set while
 * no subscription was live are all re-read once one is.
 *
 * The table is owned by whoever creates it (the `cache` plugin, under
 * `cacheTagsToken`): its sync timer and its bus subscription stop on `close`.
 * Nothing connects before the first read or invalidation.
 */

import { randomBytes } from 'node:crypto';

import { invariant } from '../errors/registry.js';
import { CacheErrors } from './cache-errors.js';
import { assertTtlMs, type CacheStore, type CacheValue } from './store.js';

/**
 * The most tags one entry may carry, and one {@link CacheTags.invalidate}
 * call may name.
 */
export const MAX_CACHE_TAGS = 32;

/** How often, by default, a {@link CacheTags} table re-reads its warm tags. */
const DEFAULT_TAG_SYNC_MS = 5000;

const TAG = /^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]{0,127}$/;

/** How long a token lives in the store; losing one only invalidates. */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The most tags the local table holds; the least recently used goes first. */
const MAX_LOCAL_TAGS = 10_000;

/** Tags per `getMany` of a sync tick. */
const SYNC_BATCH = 1000;

/** The bus message format version. */
const MESSAGE_VERSION = 1;

/** The longest wait between subscription attempts on a failing bus. */
const MAX_SUBSCRIBE_BACKOFF_MS = 60_000;

/**
 * Throw `cache.invalid_tag` unless `tag` is 1 to 128 letters, digits, `_`,
 * `@`, `.`, `:`, `/` or `-`, starting with a letter, digit, `_` or `@`.
 */
function assertCacheTag(tag: unknown): asserts tag is string {
  invariant(typeof tag === 'string' && TAG.test(tag), CacheErrors, 'invalid_tag');
}

/**
 * Check a list of tags: each well formed, at most {@link MAX_CACHE_TAGS}.
 * Returns them without duplicates, in first-seen order.
 */
export function readCacheTags(tags: unknown): readonly string[] {
  invariant(Array.isArray(tags), CacheErrors, 'invalid_tag');
  const unique = [...new Set<unknown>(tags)];
  invariant(unique.length <= MAX_CACHE_TAGS, CacheErrors, 'too_many_tags');
  for (const tag of unique) assertCacheTag(tag);
  return unique as string[];
}

/**
 * What a {@link CacheTagBus} subscriber is told.
 *
 * @public
 */
export interface CacheTagBusHandlers {
  /** A message another process published. */
  message(message: string): void;
  /** The subscription may have missed messages (it reconnected). */
  gap(): void;
}

/**
 * Carries invalidations between the processes that share a cache store.
 * Delivery is best effort: the table's sync covers anything lost.
 *
 * @public
 */
export interface CacheTagBus {
  /** Send `message` to every subscriber, this process's included. */
  publish(message: string): Promise<void>;
  /** Start receiving; resolves, once subscribed, to the function that stops. */
  subscribe(handlers: CacheTagBusHandlers): Promise<() => Promise<void>>;
}

/**
 * The application's tag token table. Every method rejects `cache.closed`
 * after `close`.
 *
 * @public
 */
export interface CacheTags {
  /**
   * A counter that moves on every change of this process's table: an
   * invalidation, a bus message from another process (whatever tags it
   * names), a gap, a sync that found a different token, and the first sync
   * after tags were dropped from the full table. Equal values mean no token
   * this process knows has changed in between.
   */
  readonly sequence: number;
  /**
   * The current token of each tag, in order. A warm tag costs nothing; the
   * cold ones are read in one `getMany`, and a missing token is minted. A
   * store failure rejects `cache.unavailable`.
   */
  tokens(tags: readonly string[]): Promise<readonly string[]>;
  /**
   * Mint a new token for each tag (at most 32). The local
   * table changes before this returns a promise; the promise resolves once
   * the store holds the new tokens, and rejects `cache.unavailable` when it
   * could not write them, in which case other processes may not have seen
   * the invalidation and the caller should retry.
   */
  invalidate(tags: readonly string[]): Promise<void>;
  /** Stop the sync timer and the bus subscription. Idempotent. */
  close(): Promise<void>;
}

/**
 * Options for {@link createCacheTags}.
 *
 * @public
 */
export interface CacheTagsOptions {
  /** Where the tokens live: a namespace of the application cache. */
  readonly store: CacheStore;
  /** Carries invalidations to the other processes sharing `store`. */
  readonly bus?: CacheTagBus;
  /** How often warm tags are re-read, in milliseconds. Defaults to 5000. */
  readonly syncMs?: number;
  /**
   * Receives the failures the table tolerates (a failed publish, subscribe,
   * or sync), once per outage. Their effect is already handled: a failed
   * sync marks every tag cold. Defaults to ignoring them, since the store's
   * own connection reports the outage.
   */
  readonly onError?: (error: unknown) => void;
}

function newToken(): string {
  return randomBytes(12).toString('base64url');
}

/** A cold read in flight for one tag, and the table sequence it began at. */
interface PendingRead {
  readonly sequence: number;
  readonly token: Promise<string>;
}

class TagTable implements CacheTags {
  readonly #store: CacheStore;
  readonly #bus: CacheTagBus | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #origin = newToken();
  /** Tag to token, least recently used first. */
  readonly #local = new Map<string, string>();
  /** The latest cold read in flight, by tag. */
  readonly #pending = new Map<string, PendingRead>();
  /** Tags whose invalidation is being written, with how many writes. */
  readonly #writing = new Map<string, number>();
  readonly #syncMs: number;
  /** The sync timer, started by the first use, so building a table schedules nothing. */
  #timer: ReturnType<typeof setInterval> | undefined;
  #sequence = 0;
  #closed = false;
  #degraded = false;
  #syncing: Promise<void> | undefined;
  #subscribing: Promise<void> | undefined;
  #unsubscribe: (() => Promise<void>) | undefined;
  /** Failed subscription attempts since the last one that succeeded. */
  #busFailures = 0;
  /** The `performance.now()` before which no attempt follows a failure. */
  #retryAt = 0;
  /** Whether a token was read or set while no subscription was live. */
  #unheard = false;
  /** Whether a tag was dropped from the full table since the last sync. */
  #dropped = false;

  constructor(options: CacheTagsOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#onError = options.onError ?? (() => undefined);
    this.#syncMs = options.syncMs ?? DEFAULT_TAG_SYNC_MS;
  }

  /** Start the periodic sync on first use; a table nobody reads has no warm tags to sync. */
  #startSync(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      this.#tick();
    }, this.#syncMs);
    // The sync must never keep a draining process alive on its own.
    this.#timer.unref();
  }

  get sequence(): number {
    return this.#sequence;
  }

  async tokens(tags: readonly string[]): Promise<readonly string[]> {
    this.#assertOpen();
    this.#startSync();
    const result: string[] = [];
    const cold: string[] = [];
    for (const [index, tag] of tags.entries()) {
      const token = this.#local.get(tag);
      if (token === undefined) {
        assertCacheTag(tag);
        cold.push(tag);
      } else {
        this.#touch(tag, token);
        result[index] = token;
      }
    }
    if (cold.length === 0) return result;

    this.#subscribe();
    // Only an attempt on a bus not known to be failing is worth waiting for.
    if (this.#busFailures === 0 && this.#subscribing !== undefined) await this.#subscribing;
    const sequence = this.#sequence;
    // A read that began at another sequence may predate a change this process
    // knows of (an invalidation, a message, a gap), so it is not joined.
    const batch = [...new Set(cold)].filter((tag) => this.#pending.get(tag)?.sequence !== sequence);
    if (batch.length > 0) {
      const fetched = this.#fetch(batch);
      const reads = batch.map((tag, index): PendingRead => {
        const read = { sequence, token: fetched.then((tokens) => tokens[index] as string) };
        this.#pending.set(tag, read);
        return read;
      });
      const settle = (): void => {
        for (const [index, tag] of batch.entries()) {
          if (this.#pending.get(tag) === reads[index]) this.#pending.delete(tag);
        }
      };
      fetched.then(settle, settle);
    }
    return Promise.all(
      tags.map((tag, index) => {
        const warm = result[index];
        return warm === undefined
          ? (this.#pending.get(tag) as PendingRead).token
          : Promise.resolve(warm);
      }),
    );
  }

  async invalidate(tags: readonly string[]): Promise<void> {
    this.#assertOpen();
    this.#startSync();
    const unique = readCacheTags(tags);
    if (unique.length === 0) return;
    const tokens = unique.map(() => newToken());
    this.#noteUnheard();
    for (const [index, tag] of unique.entries()) {
      this.#install(tag, tokens[index] as string);
      this.#writing.set(tag, (this.#writing.get(tag) ?? 0) + 1);
    }
    this.#sequence += 1;
    try {
      await Promise.all(
        unique.map((tag, index) => this.#store.set(tag, tokens[index] as string, TOKEN_TTL_MS)),
      );
    } finally {
      for (const tag of unique) {
        const writes = (this.#writing.get(tag) ?? 1) - 1;
        if (writes === 0) this.#writing.delete(tag);
        else this.#writing.set(tag, writes);
      }
    }
    if (this.#bus === undefined) return;
    try {
      await this.#bus.publish(JSON.stringify({ v: MESSAGE_VERSION, o: this.#origin, t: unique }));
    } catch (error) {
      // The store holds the new tokens; the other processes' next sync finds them.
      this.#report(error);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    // Neither can start once closed; both are read before either is awaited.
    const syncing = this.#syncing;
    const subscribing = this.#subscribing;
    await syncing;
    await subscribing;
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    this.#local.clear();
    if (unsubscribe !== undefined) await unsubscribe();
  }

  /** Retry a failed subscription when due; start a sync unless one is running. */
  #tick(): void {
    this.#subscribe();
    if (this.#syncing !== undefined) return;
    const run = this.#sync();
    this.#syncing = run;
    const settle = (): void => {
      if (this.#syncing === run) this.#syncing = undefined;
    };
    run.then(settle, settle);
  }

  #assertOpen(): void {
    if (this.#closed) throw new CacheErrors.Error('closed', { store: 'cache' });
  }

  /** Read cold tags; install them unless the table changed meanwhile. */
  async #fetch(tags: readonly string[]): Promise<readonly string[]> {
    const sequence = this.#sequence;
    this.#noteUnheard();
    const values = await this.#store.getMany(tags);
    const tokens = await Promise.all(
      values.map((value, index) =>
        typeof value === 'string' ? Promise.resolve(value) : this.#mint(tags[index] as string),
      ),
    );
    this.#healthy();
    // A change during the read (an invalidation, a message) may postdate
    // what was read, so nothing is installed; the caller still gets the
    // tokens, as of a moment its own read began after.
    if (!this.#closed && this.#sequence === sequence) {
      for (const [index, tag] of tags.entries()) {
        if (!this.#writing.has(tag)) this.#install(tag, tokens[index] as string);
      }
    }
    return tokens;
  }

  /** A token for a tag the store does not hold. */
  async #mint(tag: string): Promise<string> {
    const token = newToken();
    if (await this.#store.add(tag, token, TOKEN_TTL_MS)) return token;
    const current = await this.#store.get(tag);
    if (typeof current === 'string') return current;
    // The winner's token vanished between its add and this read; whichever
    // token stands, entries recorded under another one only reload.
    await this.#store.set(tag, token, TOKEN_TTL_MS);
    return token;
  }

  #touch(tag: string, token: string): void {
    this.#local.delete(tag);
    this.#local.set(tag, token);
  }

  #install(tag: string, token: string): void {
    this.#touch(tag, token);
    if (this.#local.size <= MAX_LOCAL_TAGS) return;
    const oldest = this.#local.keys().next();
    if (oldest.done !== true) this.#local.delete(oldest.value);
    // Dropping a tag changes no token, so the sequence stays: moving it here
    // would make every load in flight skip its store and every entry recheck,
    // on each new tag of a full table. A message naming the dropped tag still
    // moves the sequence; the sync, which no longer re-reads it, moves it once
    // so entries recorded under it are checked against the store again.
    this.#dropped = true;
  }

  /** Mark that a message may be missed: no subscription is live yet. */
  #noteUnheard(): void {
    if (this.#bus !== undefined && this.#unsubscribe === undefined) this.#unheard = true;
  }

  /**
   * Start a subscription attempt unless one is live or running, or a failed
   * one's backoff has not passed. The attempt belongs to the table: close
   * awaits it, and it never rejects.
   */
  #subscribe(): void {
    const bus = this.#bus;
    if (bus === undefined || this.#closed) return;
    if (this.#unsubscribe !== undefined || this.#subscribing !== undefined) return;
    if (performance.now() < this.#retryAt) return;
    const attempt = this.#attempt(bus);
    this.#subscribing = attempt;
    const settle = (): void => {
      if (this.#subscribing === attempt) this.#subscribing = undefined;
    };
    attempt.then(settle, settle);
  }

  async #attempt(bus: CacheTagBus): Promise<void> {
    let unsubscribe: () => Promise<void>;
    try {
      unsubscribe = await bus.subscribe({
        message: (message) => {
          this.#receive(message);
        },
        gap: () => {
          this.#coldAll();
        },
      });
    } catch (error) {
      this.#busFailures += 1;
      const backoff = this.#syncMs * 2 ** Math.min(this.#busFailures - 1, 20);
      this.#retryAt =
        performance.now() + Math.min(backoff, Math.max(this.#syncMs, MAX_SUBSCRIBE_BACKOFF_MS));
      this.#report(error);
      return;
    }
    if (this.#closed) {
      try {
        await unsubscribe();
      } catch (error) {
        // Close has already returned or is past its own unsubscribe; the
        // failure is reported like any other the table tolerates.
        this.#report(error);
      }
      return;
    }
    this.#unsubscribe = unsubscribe;
    this.#busFailures = 0;
    this.#retryAt = 0;
    if (this.#unheard) {
      this.#unheard = false;
      // A token read or set before now may have missed its message.
      this.#coldAll();
    }
  }

  #receive(raw: string): void {
    const tags = parseMessage(raw, this.#origin);
    if (tags === undefined) return;
    for (const tag of tags) this.#local.delete(tag);
    // The sequence moves whether or not the table holds a named tag: a cold
    // read of one may be in flight, a load may be about to read one as a
    // value tag, or one may have been dropped from the full table. Each of
    // those compares the sequence, so each sees the invalidation.
    this.#sequence += 1;
  }

  #coldAll(): void {
    this.#local.clear();
    this.#sequence += 1;
  }

  async #sync(): Promise<void> {
    try {
      if (this.#dropped) {
        this.#dropped = false;
        this.#sequence += 1;
      }
      const tags = [...this.#local.keys()].filter((tag) => !this.#writing.has(tag));
      if (tags.length === 0) return;
      const read = tags.map((tag) => this.#local.get(tag));
      const values: (CacheValue | null)[] = [];
      for (let start = 0; start < tags.length; start += SYNC_BATCH) {
        values.push(...(await this.#store.getMany(tags.slice(start, start + SYNC_BATCH))));
      }
      this.#healthy();
      if (this.#closed) return;
      let changed = false;
      for (const [index, tag] of tags.entries()) {
        // A tag whose local token changed during the read (an invalidation,
        // a message, a newer cold read, a gap) may have changed after it was
        // read, so it is left as it is; the others are unaffected by a change
        // elsewhere, so a busy bus never starves the sync.
        const current = this.#local.get(tag);
        if (current === undefined || current !== read[index] || this.#writing.has(tag)) continue;
        const value = values[index];
        if (typeof value !== 'string') {
          this.#local.delete(tag);
          changed = true;
        } else if (value !== current) {
          this.#local.set(tag, value);
          changed = true;
        }
      }
      if (changed) this.#sequence += 1;
    } catch (error) {
      if (!this.#closed) {
        // Nothing can be confirmed: every tag is read again before it is trusted.
        this.#coldAll();
        this.#report(error);
      }
    }
  }

  #healthy(): void {
    this.#degraded = false;
  }

  #report(error: unknown): void {
    if (this.#degraded) return;
    this.#degraded = true;
    this.#onError(error);
  }
}

/** The tags of a well-formed message from another process, else `undefined`. */
function parseMessage(raw: string, origin: string): readonly string[] | undefined {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    // Not a message this table published: the channel is shared with nothing
    // else of ours, so it is ignored.
    return undefined;
  }
  if (message === null || typeof message !== 'object') return undefined;
  const { v, o, t } = message as { v?: unknown; o?: unknown; t?: unknown };
  if (v !== MESSAGE_VERSION || typeof o !== 'string' || o === origin || !Array.isArray(t)) {
    return undefined;
  }
  const tags = t as unknown[];
  if (
    tags.length > MAX_CACHE_TAGS ||
    !tags.every((tag) => typeof tag === 'string' && TAG.test(tag))
  ) {
    return undefined;
  }
  return tags as string[];
}

/**
 * Create a tag token table over `store`. Construction opens nothing and
 * schedules nothing: the sync timer starts with the first `tokens` or
 * `invalidate` call.
 *
 * @public
 */
export function createCacheTags(options: CacheTagsOptions): CacheTags {
  invariant(options !== null && typeof options === 'object', CacheErrors, 'invalid_option', {
    option: 'createCacheTags',
  });
  const store = options.store as Partial<CacheStore> | null;
  invariant(
    store !== null &&
      typeof store === 'object' &&
      typeof store.getMany === 'function' &&
      typeof store.add === 'function' &&
      typeof store.set === 'function',
    CacheErrors,
    'invalid_option',
    { option: 'store' },
  );
  const bus = options.bus as Partial<CacheTagBus> | undefined | null;
  invariant(
    bus === undefined ||
      (bus !== null &&
        typeof bus === 'object' &&
        typeof bus.publish === 'function' &&
        typeof bus.subscribe === 'function'),
    CacheErrors,
    'invalid_option',
    { option: 'bus' },
  );
  if (options.syncMs !== undefined) {
    try {
      assertTtlMs(options.syncMs);
    } catch (error) {
      throw new CacheErrors.Error('invalid_option', { option: 'syncMs' }, { cause: error });
    }
  }
  invariant(
    options.onError === undefined || typeof options.onError === 'function',
    CacheErrors,
    'invalid_option',
    { option: 'onError' },
  );
  return new TagTable(options);
}
