/**
 * Defined caches (`jsails/cache`): {@link defineCache}, the one way framework
 * and app code caches a derived value.
 *
 * A defined cache reads through: `get(key, load)` serves the entry for `key`
 * while it is fresh and its tags are current, and otherwise runs `load` once,
 * however many callers ask at the same time, and stores what it returns.
 * Validity is decided by tag tokens ({@link CacheTags}), never by a version
 * the cache keeps itself, so one `invalidate(tag)` reaches every cache, in
 * every process, that recorded the tag.
 *
 * The guarantees, which the conformance suite in `jsails/testing` holds every
 * store to:
 *
 * - Once `invalidate(tag)` resolves, no `get` started afterwards in the
 *   process returns a value loaded before it: the invalidation changes the
 *   local token synchronously, and a `get` joins only a load started under
 *   the same table sequence.
 * - Capture before load: the tokens of the key's tags and the table sequence
 *   are read before `load` runs; when the sequence moved by the time it
 *   returns, the value is returned to its callers and not stored.
 * - Single flight: the in-flight map is consulted synchronously, before any
 *   store read, so N concurrent callers of one key run `load` once even when
 *   the store is slow. A loader error rejects every waiter of that load once
 *   and is never stored.
 * - Stale while refresh, with no background work: an entry past `ttlMs` but
 *   within `staleMs` is refreshed by the caller that finds it, who waits for
 *   the load; callers arriving meanwhile get the stale value. An invalidated
 *   entry is never served stale.
 * - The cache never fails a read: a store or tag read failure loads and
 *   returns the value uncached, and a failed write is counted, not thrown.
 *
 * `load` runs in the async context the cache was defined in, not the
 * caller's: a cached value is shared by every caller, so it must depend on
 * its key alone, never on a request's scope, tenant, or open transaction.
 *
 * Authorization data (sessions, memberships, tenant status) must not go
 * through a defined cache: a revocation has to take effect on the next
 * request, not after an invalidation reaches every process.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { invariant } from '../errors/registry.js';
import type { ServiceRegistry } from '../extensions/services.js';
import { CacheErrors } from './cache-errors.js';
import { withLease, type LeaseOutcome, type LeaseStore } from './lease.js';
import {
  MAX_CACHE_TTL_MS,
  assertCacheKey,
  assertTtlMs,
  type CacheStore,
  type CacheValue,
} from './store.js';
import { MAX_CACHE_TAGS, readCacheTags, type CacheTags } from './tag-tokens.js';
import { cacheTagsToken, cacheToken, leaseToken } from './tokens.js';

/**
 * Where a defined cache keeps its values: in this process (`process`), held
 * by reference, or in the application cache store (`shared`), encoded.
 *
 * @public
 */
export type CacheTier = 'process' | 'shared';

/**
 * How many loads of one key run at once: one per process (`process`), or one
 * across every process sharing the store, coordinated by a lease (`cluster`).
 *
 * @public
 */
export type CacheStampede = 'process' | 'cluster';

/**
 * Turns a `shared` cache's values into what the store holds, and back.
 *
 * @public
 */
export interface CacheCodec<T> {
  encode(value: T): CacheValue;
  decode(raw: CacheValue): T;
}

/**
 * Computes a value on a miss. The signal aborts when a `cluster` load lost its
 * lease; a loader that cannot stop simply finishes.
 *
 * @public
 */
export type CacheLoader<T> = (signal: AbortSignal) => Promise<T>;

/**
 * The declaration of a defined cache.
 *
 * @public
 */
export interface CacheDefinition<T> {
  /**
   * Unique in the application: 1 to 64 letters, digits, `_`, `.` or `-`,
   * starting with a letter, digit or `_`.
   */
  readonly name: string;
  /** How long an entry is fresh, in milliseconds. */
  readonly ttlMs: number;
  /**
   * How long past `ttlMs` an entry may still be served while one caller
   * refreshes it. Defaults to 0.
   */
  readonly staleMs?: number;
  readonly tier: CacheTier;
  /** The tags of a key, recorded before its load. Keep them few and coarse. */
  readonly tags?: (key: string) => readonly string[];
  /**
   * Further tags derived from a loaded value. A cache that has them must also
   * give every key at least one tag of its own.
   */
  readonly valueTags?: (value: T) => readonly string[];
  /** `shared` only: the value encoding. Defaults to JSON. */
  readonly codec?: CacheCodec<T>;
  /** `shared` only: the largest stored entry, in bytes. Defaults to 1 MiB. */
  readonly maxBytes?: number;
  /** `process` only: how many entries are kept, least recently used dropped first. Defaults to 1000. */
  readonly maxEntries?: number;
  /** Defaults to `process`; `cluster` needs the `shared` tier and a lease store. */
  readonly stampede?: CacheStampede;
  /** The clock deciding freshness, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Counters of a defined cache since it was defined.
 *
 * @public
 */
export interface CacheStats {
  /** Gets served a fresh entry. */
  readonly hits: number;
  /** Gets served a stale entry while it was refreshed. */
  readonly stale: number;
  /** Loads run. */
  readonly misses: number;
  /** Gets that joined a lookup already in flight. */
  readonly coalesced: number;
  /** Loaded values not stored: an invalidation landed meanwhile, or the entry was too large. */
  readonly skipped: number;
  /** `process` entries dropped to stay within `maxEntries`. */
  readonly evictions: number;
  /** Entries found with a tag token that is no longer current. */
  readonly invalidated: number;
  /** Store, tag, or codec failures the cache tolerated. */
  readonly errors: number;
}

/**
 * A defined cache.
 *
 * @public
 */
export interface Cache<T> {
  readonly name: string;
  /**
   * The value for `key`: the cached one while it is fresh and its tags are
   * current, otherwise what `load` returns (run once for concurrent callers).
   */
  get(key: string, load: CacheLoader<T>): Promise<T>;
  /**
   * Invalidate every entry, of any cache in any process sharing the store,
   * that recorded one of `tags`. Call it after the write it reflects has
   * committed. Rejects `cache.unavailable` when the store could not record
   * it, in which case other processes may not have seen it: retry.
   */
  invalidate(...tags: string[]): Promise<void>;
  stats(): CacheStats;
}

/**
 * The services {@link defineCache} reads: `cacheToken`, `cacheTagsToken`, and
 * for a `cluster` cache `leaseToken`.
 *
 * @public
 */
export type CacheServices = Pick<ServiceRegistry, 'get'>;

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** The application-cache namespace holding every shared cache's values. */
const VALUES_NAMESPACE = 'jsails.defined';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1000;

/** A `cluster` load's lease; renewed while the load runs. */
const LEASE_TTL_MS = 30_000;

/** How a `cluster` loser waits for the winner's entry, about 5.6 s in all. */
const CLUSTER_WAIT_MS: readonly number[] = [25, 50, 100, 200, 400, 800, 1000, 1000, 1000, 1000];

const ENVELOPE_VERSION = 1;
const NEWLINE = 0x0a;

/** The signal of a load nothing can abort. */
const NEVER: AbortSignal = new AbortController().signal;

/** Which names each application (by its tag table) has defined. */
const definedNames = new WeakMap<CacheTags, Set<string>>();

/** When and under which tag tokens an entry was stored. */
interface Stamp {
  readonly tags: readonly string[];
  readonly tokens: readonly string[];
  readonly freshUntil: number;
  readonly staleUntil: number;
}

interface ProcessEntry<T> extends Stamp {
  readonly value: T;
  /** The table sequence the tokens were last confirmed at. */
  sequence: number;
}

/** One lookup in flight for a key. */
interface Flight<T> {
  readonly sequence: number;
  readonly promise: Promise<T>;
  /** A valid stale entry the lookup found, served to callers that join it. */
  stale: { readonly value: T } | undefined;
}

interface Counts {
  hits: number;
  stale: number;
  misses: number;
  coalesced: number;
  skipped: number;
  evictions: number;
  invalidated: number;
  errors: number;
}

const jsonCodec: CacheCodec<unknown> = Object.freeze({
  encode: (value: unknown): CacheValue => {
    const text = JSON.stringify(value) as string | undefined;
    if (text === undefined) throw new CacheErrors.Error('invalid_value');
    return text;
  },
  decode: (raw: CacheValue): unknown =>
    JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')) as unknown,
});

function sameTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function optionError(option: string, cause?: unknown): Error {
  return new CacheErrors.Error(
    'invalid_option',
    { option },
    cause === undefined ? undefined : { cause },
  );
}

function positiveInteger(value: unknown, option: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw optionError(option);
  }
  return value;
}

/** The value as stored: a JSON header line, then the payload. */
function encodeEnvelope(stamp: Stamp, payload: CacheValue): CacheValue {
  const header = `${JSON.stringify({
    v: ENVELOPE_VERSION,
    f: stamp.freshUntil,
    s: stamp.staleUntil,
    t: stamp.tags,
    k: stamp.tokens,
  })}\n`;
  if (typeof payload === 'string') return header + payload;
  const head = Buffer.from(header, 'utf8');
  const bytes = new Uint8Array(head.length + payload.length);
  bytes.set(head, 0);
  bytes.set(payload, head.length);
  return bytes;
}

function envelopeBytes(envelope: CacheValue): number {
  return typeof envelope === 'string' ? Buffer.byteLength(envelope, 'utf8') : envelope.length;
}

/** A stored value split into its stamp and payload, or `undefined` when malformed. */
function decodeEnvelope(raw: CacheValue): { stamp: Stamp; payload: CacheValue } | undefined {
  let headerText: string;
  let payload: CacheValue;
  if (typeof raw === 'string') {
    const end = raw.indexOf('\n');
    if (end < 0) return undefined;
    headerText = raw.slice(0, end);
    payload = raw.slice(end + 1);
  } else {
    const end = raw.indexOf(NEWLINE);
    if (end < 0) return undefined;
    headerText = Buffer.from(raw.subarray(0, end)).toString('utf8');
    payload = raw.slice(end + 1);
  }
  let header: unknown;
  try {
    header = JSON.parse(headerText);
  } catch {
    // Not an entry this cache wrote (another format or a corrupted value): a miss.
    return undefined;
  }
  if (header === null || typeof header !== 'object') return undefined;
  const { v, f, s, t, k } = header as Record<string, unknown>;
  if (
    v !== ENVELOPE_VERSION ||
    typeof f !== 'number' ||
    typeof s !== 'number' ||
    !Array.isArray(t) ||
    !Array.isArray(k) ||
    t.length !== k.length ||
    t.length > MAX_CACHE_TAGS ||
    !(t as unknown[]).every((tag) => typeof tag === 'string') ||
    !(k as unknown[]).every((token) => typeof token === 'string')
  ) {
    return undefined;
  }
  return {
    stamp: { tags: t as string[], tokens: k as string[], freshUntil: f, staleUntil: s },
    payload,
  };
}

class DefinedCache<T> implements Cache<T> {
  readonly name: string;
  readonly #tags: CacheTags;
  readonly #ttlMs: number;
  readonly #staleMs: number;
  readonly #keyTagsOf: ((key: string) => readonly string[]) | undefined;
  readonly #valueTagsOf: ((value: T) => readonly string[]) | undefined;
  readonly #now: () => number;
  readonly #detached: <R, A extends unknown[]>(fn: (...args: A) => R, ...args: A) => R;
  /** `process` tier: the entries, least recently used first. */
  readonly #memory: Map<string, ProcessEntry<T>> | undefined;
  readonly #maxEntries: number;
  /** `shared` tier: the store namespace and the encoding. */
  readonly #values: CacheStore | undefined;
  readonly #codec: CacheCodec<T>;
  readonly #maxBytes: number;
  readonly #leases: LeaseStore | undefined;
  readonly #flights = new Map<string, Flight<T>>();
  readonly #counts: Counts = {
    hits: 0,
    stale: 0,
    misses: 0,
    coalesced: 0,
    skipped: 0,
    evictions: 0,
    invalidated: 0,
    errors: 0,
  };

  constructor(
    definition: CacheDefinition<T>,
    tags: CacheTags,
    values: CacheStore | undefined,
    leases: LeaseStore | undefined,
  ) {
    this.name = definition.name;
    this.#tags = tags;
    this.#ttlMs = definition.ttlMs;
    this.#staleMs = definition.staleMs ?? 0;
    this.#keyTagsOf = definition.tags;
    this.#valueTagsOf = definition.valueTags;
    this.#now = definition.now ?? (() => Date.now());
    this.#detached = AsyncLocalStorage.snapshot();
    this.#memory = definition.tier === 'process' ? new Map() : undefined;
    this.#maxEntries = definition.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#values = values;
    this.#codec = definition.codec ?? (jsonCodec as CacheCodec<T>);
    this.#maxBytes = definition.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#leases = leases;
  }

  async get(key: string, load: CacheLoader<T>): Promise<T> {
    assertCacheKey(key);
    invariant(typeof load === 'function', CacheErrors, 'invalid_option', { option: 'load' });
    const sequence = this.#tags.sequence;
    const entry = this.#memory?.get(key);
    if (entry !== undefined && entry.sequence === sequence) {
      const now = this.#now();
      if (now < entry.freshUntil) {
        this.#touch(key, entry);
        this.#counts.hits += 1;
        return entry.value;
      }
      if (now < entry.staleUntil && this.#joinable(key, sequence) !== undefined) {
        this.#counts.stale += 1;
        return entry.value;
      }
    }
    const flight = this.#joinable(key, sequence);
    if (flight !== undefined) {
      if (flight.stale !== undefined) {
        this.#counts.stale += 1;
        return flight.stale.value;
      }
      this.#counts.coalesced += 1;
      return flight.promise;
    }
    return this.#start(key, load, sequence);
  }

  invalidate(...tags: string[]): Promise<void> {
    return this.#tags.invalidate(tags);
  }

  stats(): CacheStats {
    return Object.freeze({ ...this.#counts });
  }

  #joinable(key: string, sequence: number): Flight<T> | undefined {
    const flight = this.#flights.get(key);
    return flight !== undefined && flight.sequence === sequence ? flight : undefined;
  }

  /** Register the lookup before anything awaits, so a concurrent get joins it. */
  #start(key: string, load: CacheLoader<T>, sequence: number): Promise<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onValue, onError) => {
      resolve = onValue;
      reject = onError;
    });
    const flight: Flight<T> = { sequence, promise, stale: undefined };
    this.#flights.set(key, flight);
    const land = (): void => {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    };
    this.#lookup(key, load, flight).then(
      (value) => {
        land();
        resolve(value);
      },
      (error: unknown) => {
        land();
        reject(error);
      },
    );
    return promise;
  }

  async #lookup(key: string, load: CacheLoader<T>, flight: Flight<T>): Promise<T> {
    const keyTags = this.#readKeyTags(key);
    let keyTokens: readonly string[];
    try {
      keyTokens = await this.#tags.tokens(keyTags);
    } catch {
      // Without the tokens nothing can be validated or stamped: load uncached.
      this.#counts.errors += 1;
      this.#counts.misses += 1;
      return this.#detached(load, NEVER);
    }
    const found =
      this.#memory === undefined
        ? await this.#findShared(key, flight)
        : await this.#findProcess(this.#memory, key, flight);
    if (found !== undefined) return found.value;
    return this.#load(key, load, flight, keyTags, keyTokens);
  }

  async #findProcess(
    memory: Map<string, ProcessEntry<T>>,
    key: string,
    flight: Flight<T>,
  ): Promise<{ readonly value: T } | undefined> {
    const entry = memory.get(key);
    if (entry === undefined) return undefined;
    if (this.#now() >= entry.staleUntil) {
      memory.delete(key);
      return undefined;
    }
    if (entry.sequence !== flight.sequence) {
      if (!(await this.#current(entry))) {
        if (memory.get(key) === entry) memory.delete(key);
        return undefined;
      }
      entry.sequence = flight.sequence;
    }
    if (this.#now() < entry.freshUntil) {
      this.#touch(key, entry);
      this.#counts.hits += 1;
      return { value: entry.value };
    }
    flight.stale = { value: entry.value };
    return undefined;
  }

  async #findShared(key: string, flight: Flight<T>): Promise<{ readonly value: T } | undefined> {
    const values = this.#values as CacheStore;
    let raw: CacheValue | null;
    try {
      raw = await values.get(key);
    } catch {
      // An unreachable store is a miss.
      this.#counts.errors += 1;
      return undefined;
    }
    if (raw === null) return undefined;
    const envelope = decodeEnvelope(raw);
    if (envelope === undefined) {
      this.#counts.errors += 1;
      return undefined;
    }
    const { stamp } = envelope;
    if (this.#now() >= stamp.staleUntil || !(await this.#current(stamp))) return undefined;
    let value: T;
    try {
      value = this.#codec.decode(envelope.payload);
    } catch {
      // An entry an older encoding wrote: reload it.
      this.#counts.errors += 1;
      return undefined;
    }
    if (this.#now() < stamp.freshUntil) {
      this.#counts.hits += 1;
      return { value };
    }
    flight.stale = { value };
    return undefined;
  }

  /** Whether every token `stamp` recorded is still current. */
  async #current(stamp: Stamp): Promise<boolean> {
    let tokens: readonly string[];
    try {
      tokens = await this.#tags.tokens(stamp.tags);
    } catch {
      this.#counts.errors += 1;
      return false;
    }
    if (sameTokens(tokens, stamp.tokens)) return true;
    this.#counts.invalidated += 1;
    return false;
  }

  async #load(
    key: string,
    load: CacheLoader<T>,
    flight: Flight<T>,
    keyTags: readonly string[],
    keyTokens: readonly string[],
  ): Promise<T> {
    const leases = this.#leases;
    if (leases === undefined)
      return this.#loadAndStore(key, load, flight, keyTags, keyTokens, NEVER);
    const progress = { started: false };
    let outcome: LeaseOutcome<T>;
    try {
      outcome = await withLease(
        leases,
        this.#leaseKey(key),
        { ttlMs: LEASE_TTL_MS },
        async (_lease, signal) => {
          progress.started = true;
          // The previous holder may have stored the entry between this
          // process's miss and its acquisition: serve that instead of loading.
          const stored = await this.#findShared(key, flight);
          if (stored !== undefined) return stored.value;
          return this.#loadAndStore(key, load, flight, keyTags, keyTokens, signal);
        },
      );
    } catch (error) {
      if (progress.started) throw error;
      // The lease store failed, not the load: load without coordination.
      this.#counts.errors += 1;
      return this.#loadAndStore(key, load, flight, keyTags, keyTokens, NEVER);
    }
    if (outcome.acquired) return outcome.value;
    if (flight.stale !== undefined) {
      this.#counts.stale += 1;
      return flight.stale.value;
    }
    for (const delay of CLUSTER_WAIT_MS) {
      await sleep(delay);
      if (this.#tags.sequence !== flight.sequence) break;
      const found = await this.#findShared(key, flight);
      if (found !== undefined) return found.value;
    }
    return this.#loadAndStore(key, load, flight, keyTags, keyTokens, NEVER);
  }

  async #loadAndStore(
    key: string,
    load: CacheLoader<T>,
    flight: Flight<T>,
    keyTags: readonly string[],
    keyTokens: readonly string[],
    signal: AbortSignal,
  ): Promise<T> {
    this.#counts.misses += 1;
    const value = await this.#detached(load, signal);
    if (this.#tags.sequence !== flight.sequence) {
      this.#counts.skipped += 1;
      return value;
    }
    let tags = keyTags;
    let tokens = keyTokens;
    if (this.#valueTagsOf !== undefined) {
      const extra = readCacheTags(this.#valueTagsOf(value)).filter((tag) => !keyTags.includes(tag));
      invariant(keyTags.length + extra.length <= MAX_CACHE_TAGS, CacheErrors, 'too_many_tags');
      if (extra.length > 0) {
        let extraTokens: readonly string[];
        try {
          extraTokens = await this.#tags.tokens(extra);
        } catch {
          this.#counts.errors += 1;
          this.#counts.skipped += 1;
          return value;
        }
        if (this.#tags.sequence !== flight.sequence) {
          this.#counts.skipped += 1;
          return value;
        }
        tags = [...keyTags, ...extra];
        tokens = [...keyTokens, ...extraTokens];
      }
    }
    const now = this.#now();
    const stamp: Stamp = {
      tags,
      tokens,
      freshUntil: now + this.#ttlMs,
      staleUntil: now + this.#ttlMs + this.#staleMs,
    };
    if (this.#memory === undefined) await this.#storeShared(key, stamp, value);
    else this.#remember(this.#memory, key, { ...stamp, value, sequence: flight.sequence });
    return value;
  }

  #remember(memory: Map<string, ProcessEntry<T>>, key: string, entry: ProcessEntry<T>): void {
    memory.delete(key);
    memory.set(key, entry);
    while (memory.size > this.#maxEntries) {
      const oldest = memory.keys().next();
      if (oldest.done === true) break;
      memory.delete(oldest.value);
      this.#counts.evictions += 1;
    }
  }

  async #storeShared(key: string, stamp: Stamp, value: T): Promise<void> {
    let envelope: CacheValue;
    try {
      const payload = this.#codec.encode(value);
      invariant(
        typeof payload === 'string' || payload instanceof Uint8Array,
        CacheErrors,
        'invalid_value',
      );
      envelope = encodeEnvelope(stamp, payload);
    } catch {
      // The value is still returned; only caching it failed.
      this.#counts.errors += 1;
      return;
    }
    if (envelopeBytes(envelope) > this.#maxBytes) {
      this.#counts.skipped += 1;
      return;
    }
    try {
      await (this.#values as CacheStore).set(key, envelope, this.#ttlMs + this.#staleMs);
    } catch {
      this.#counts.errors += 1;
    }
  }

  #touch(key: string, entry: ProcessEntry<T>): void {
    const memory = this.#memory as Map<string, ProcessEntry<T>>;
    memory.delete(key);
    memory.set(key, entry);
  }

  #readKeyTags(key: string): readonly string[] {
    if (this.#keyTagsOf === undefined) return [];
    const tags = readCacheTags(this.#keyTagsOf(key));
    if (this.#valueTagsOf !== undefined && tags.length === 0) throw optionError('tags');
    return tags;
  }

  /** A fixed-length lease key, whatever the cache key's length. */
  #leaseKey(key: string): string {
    return `cache:${this.name}:${createHash('sha256').update(key).digest('base64url')}`;
  }
}

function checkDefinition<T>(definition: CacheDefinition<T>): void {
  if (definition === null || typeof definition !== 'object') throw optionError('defineCache');
  const { name, ttlMs, staleMs, tier, stampede } = definition;
  if (typeof name !== 'string' || !NAME.test(name)) throw optionError('name');
  try {
    assertTtlMs(ttlMs);
  } catch (error) {
    throw optionError('ttlMs', error);
  }
  if (
    staleMs !== undefined &&
    (typeof staleMs !== 'number' ||
      !Number.isSafeInteger(staleMs) ||
      staleMs < 0 ||
      ttlMs + staleMs > MAX_CACHE_TTL_MS)
  ) {
    throw optionError('staleMs');
  }
  if (tier !== 'process' && tier !== 'shared') throw optionError('tier');
  for (const option of ['tags', 'valueTags', 'now'] as const) {
    if (definition[option] !== undefined && typeof definition[option] !== 'function') {
      throw optionError(option);
    }
  }
  if (definition.valueTags !== undefined && definition.tags === undefined) {
    throw optionError('tags');
  }
  if (tier === 'process') {
    if (definition.codec !== undefined) throw optionError('codec');
    if (definition.maxBytes !== undefined) throw optionError('maxBytes');
    positiveInteger(definition.maxEntries, 'maxEntries');
  } else {
    const codec = definition.codec as Partial<CacheCodec<T>> | undefined | null;
    if (
      codec !== undefined &&
      (codec === null ||
        typeof codec !== 'object' ||
        typeof codec.encode !== 'function' ||
        typeof codec.decode !== 'function')
    ) {
      throw optionError('codec');
    }
    if (definition.maxEntries !== undefined) throw optionError('maxEntries');
    positiveInteger(definition.maxBytes, 'maxBytes');
  }
  if (stampede !== undefined && stampede !== 'process' && stampede !== 'cluster') {
    throw optionError('stampede');
  }
  if (stampede === 'cluster' && tier !== 'shared') throw optionError('stampede');
}

/**
 * Define a cache over the application's cache services, typically in a
 * plugin's `setup`. Checks the definition (`cache.invalid_option`) and that
 * no other cache of the application has its name (`cache.duplicate_cache`).
 * Defining connects nothing.
 *
 * @public
 */
export function defineCache<T>(services: CacheServices, definition: CacheDefinition<T>): Cache<T> {
  checkDefinition(definition);
  const tags = services.get(cacheTagsToken);
  const values =
    definition.tier === 'shared'
      ? services.get(cacheToken).cache(VALUES_NAMESPACE).namespace(definition.name)
      : undefined;
  const leases = definition.stampede === 'cluster' ? services.get(leaseToken) : undefined;
  let names = definedNames.get(tags);
  if (names === undefined) {
    names = new Set();
    definedNames.set(tags, names);
  }
  invariant(!names.has(definition.name), CacheErrors, 'duplicate_cache', {
    name: definition.name,
  });
  names.add(definition.name);
  return new DefinedCache(definition, tags, values, leases);
}

/**
 * A {@link Cache} stand-in for a service built before the application's
 * services exist. See {@link createCacheSlot}.
 *
 * @public
 */
export interface CacheSlot<T> {
  /** Routes through the bound cache, or loads directly while none is bound. */
  readonly cache: Cache<T>;
  /** Route through `cache` until the returned function is called. */
  bind(cache: Cache<T>): () => void;
}

const EMPTY_STATS: CacheStats = Object.freeze({
  hits: 0,
  stale: 0,
  misses: 0,
  coalesced: 0,
  skipped: 0,
  evictions: 0,
  invalidated: 0,
  errors: 0,
});

/**
 * A slot for a service a plugin builds eagerly, before `setup` hands it the
 * services `defineCache` needs (an object an admin page or a CLI command is
 * given at config time). Until a cache is bound, `get` runs `load` every time
 * and `invalidate` does nothing, which is right for a process that serves no
 * cached reads (a CLI command); `setup` binds the defined cache and its
 * cleanup calls the returned function, which unbinds only that cache.
 *
 * @public
 */
export function createCacheSlot<T>(name: string): CacheSlot<T> {
  if (typeof name !== 'string' || !NAME.test(name)) throw optionError('name');
  let bound: Cache<T> | undefined;
  const cache: Cache<T> = Object.freeze({
    name,
    get: async (key: string, load: CacheLoader<T>): Promise<T> =>
      bound === undefined ? load(NEVER) : bound.get(key, load),
    invalidate: (...tags: string[]): Promise<void> =>
      bound === undefined ? Promise.resolve() : bound.invalidate(...tags),
    stats: (): CacheStats => (bound === undefined ? EMPTY_STATS : bound.stats()),
  });
  return Object.freeze({
    cache,
    bind(next: Cache<T>): () => void {
      bound = next;
      return () => {
        if (bound === next) bound = undefined;
      };
    },
  });
}
