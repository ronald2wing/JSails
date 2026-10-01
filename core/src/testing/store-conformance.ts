/**
 * Conformance suites for the cache contracts (`jsails/testing`): every
 * {@link CacheStore} and {@link LeaseStore}, first-party or custom, is held to
 * the same cases.
 *
 * The suites are plain data: {@link cacheStoreConformance} and
 * {@link leaseStoreConformance} return named cases, and the test file
 * registers them itself, so node:test attributes each to that file and an
 * expected-failure ledger can name it:
 *
 * ```ts
 * for (const entry of cacheStoreConformance(harness)) test(entry.name, entry.run);
 * ```
 *
 * A harness builds a fresh store per case and says how time passes for it:
 * an in-memory store advances an injected clock; a server-backed one waits.
 */

import assert from 'node:assert/strict';

import { CacheErrors } from '../cache/cache-errors.js';
import type { Lease, LeaseStore } from '../cache/lease.js';
import { MAX_CACHE_KEY_LENGTH, MAX_CACHE_TTL_MS, type CacheStore } from '../cache/store.js';

/**
 * One store under test and how time passes for it.
 *
 * @public
 */
export interface StoreHarness<S> {
  readonly store: S;
  /** Let at least `ms` milliseconds pass for the store. */
  advance(ms: number): Promise<void>;
  /** Release what the harness holds (the store is closed by the case itself or here). */
  close(): Promise<void>;
}

/**
 * Builds a fresh {@link StoreHarness} for one case.
 *
 * @public
 */
export type StoreHarnessFactory<S> = () => Promise<StoreHarness<S>>;

/**
 * Options of the conformance suites.
 *
 * @public
 */
export interface StoreConformanceOptions {
  /**
   * The TTL the expiry cases use, in milliseconds. A store on a real clock
   * needs one long enough for a round trip to fit well inside it. Defaults to
   * 1000.
   */
  readonly ttlMs?: number;
}

/**
 * One named case of a conformance suite.
 *
 * @public
 */
export interface StoreConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

const INVALID_TTLS: readonly unknown[] = [
  0,
  -1,
  1.5,
  Number.NaN,
  Infinity,
  MAX_CACHE_TTL_MS + 1,
  '10',
];
const INVALID_KEYS: readonly unknown[] = ['', 42, null, 'k'.repeat(MAX_CACHE_KEY_LENGTH + 1)];

async function rejectsWith(
  operation: () => Promise<unknown>,
  code:
    | 'invalid_key'
    | 'invalid_ttl'
    | 'invalid_value'
    | 'invalid_namespace'
    | 'invalid_lease'
    | 'closed',
): Promise<void> {
  await assert.rejects(
    async () => operation(),
    (error: unknown) => CacheErrors.is(error, code),
    `expected cache.${code}`,
  );
}

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function caseRunner<S>(
  factory: StoreHarnessFactory<S>,
): (name: string, body: (harness: StoreHarness<S>) => Promise<void>) => StoreConformanceCase {
  return (name, body) => ({
    name,
    async run() {
      const harness = await factory();
      try {
        await body(harness);
      } finally {
        await harness.close();
      }
    },
  });
}

/**
 * The {@link CacheStore} conformance cases.
 *
 * @public
 */
export function cacheStoreConformance(
  factory: StoreHarnessFactory<CacheStore>,
  options: StoreConformanceOptions = {},
): readonly StoreConformanceCase[] {
  const ttl = options.ttlMs ?? 1000;
  const long = Math.max(ttl * 60, 60_000);
  const define = caseRunner(factory);
  return Object.freeze([
    define('get of an absent key is null', async ({ store }) => {
      assert.equal(await store.get('absent'), null);
    }),
    define('a string reads back as the same string', async ({ store }) => {
      for (const value of ['plain', '', 'naïve ✓ 𝄞', 'b\u0000s', '{"json":true}']) {
        await store.set('text', value, long);
        assert.equal(await store.get('text'), value);
      }
    }),
    define('bytes read back as equal bytes and never alias the caller', async ({ store }) => {
      const written = bytesOf(0x73, 0, 255, 0x62, 7);
      await store.set('bytes', written, long);
      written[0] = 1;
      const first = await store.get('bytes');
      assert.ok(first instanceof Uint8Array, 'bytes read back as a Uint8Array');
      assert.deepEqual([...first], [0x73, 0, 255, 0x62, 7]);
      first[1] = 9;
      const second = await store.get('bytes');
      assert.ok(second instanceof Uint8Array);
      assert.deepEqual([...second], [0x73, 0, 255, 0x62, 7]);
      await store.set('empty', new Uint8Array(0), long);
      const empty = await store.get('empty');
      assert.ok(empty instanceof Uint8Array);
      assert.equal(empty.byteLength, 0);
    }),
    define('set replaces an entry, also across value types', async ({ store }) => {
      await store.set('k', 'one', long);
      await store.set('k', bytesOf(1, 2), long);
      assert.deepEqual([...((await store.get('k')) as Uint8Array)], [1, 2]);
      await store.set('k', 'two', long);
      assert.equal(await store.get('k'), 'two');
    }),
    define('getMany follows key order and reads misses as null', async ({ store }) => {
      await store.set('a', 'A', long);
      await store.set('c', bytesOf(3), long);
      const values = await store.getMany(['c', 'b', 'a', 'a']);
      assert.equal(values.length, 4);
      assert.deepEqual([...(values[0] as Uint8Array)], [3]);
      assert.deepEqual(values.slice(1), [null, 'A', 'A']);
      assert.deepEqual(await store.getMany([]), []);
    }),
    define('add stores only while the key is free', async ({ store }) => {
      assert.equal(await store.add('claim', 'first', long), true);
      assert.equal(await store.add('claim', 'second', long), false);
      assert.equal(await store.get('claim'), 'first');
      await store.delete('claim');
      assert.equal(await store.add('claim', 'third', long), true);
      assert.equal(await store.get('claim'), 'third');
    }),
    define('add succeeds again once the entry expired', async ({ store, advance }) => {
      assert.equal(await store.add('claim', 'first', ttl), true);
      await advance(Math.ceil(ttl * 1.5));
      assert.equal(await store.add('claim', 'second', long), true);
      assert.equal(await store.get('claim'), 'second');
    }),
    define('concurrent adds of one key store exactly one value', async ({ store }) => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_unused, index) => store.add('race', String(index), long)),
      );
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(await store.get('race'), String(results.indexOf(true)));
    }),
    define('delete removes an entry and ignores an absent key', async ({ store }) => {
      await store.set('k', 'v', long);
      await store.delete('k');
      assert.equal(await store.get('k'), null);
      await store.delete('never-set');
    }),
    define('an entry lives until its TTL and is gone after it', async ({ store, advance }) => {
      await store.set('short', 'v', ttl);
      await store.set('long', 'w', long);
      assert.equal(await store.get('short'), 'v');
      await advance(Math.ceil(ttl * 1.5));
      assert.equal(await store.get('short'), null);
      assert.deepEqual(await store.getMany(['short', 'long']), [null, 'w']);
    }),
    define('set restarts the TTL', async ({ store, advance }) => {
      await store.set('k', 'v', ttl);
      await advance(Math.ceil(ttl * 0.6));
      await store.set('k', 'w', ttl);
      await advance(Math.ceil(ttl * 0.6));
      assert.equal(await store.get('k'), 'w');
    }),
    define('invalid keys are refused', async ({ store }) => {
      for (const key of INVALID_KEYS) {
        await rejectsWith(() => store.get(key as string), 'invalid_key');
        await rejectsWith(() => store.set(key as string, 'v', long), 'invalid_key');
        await rejectsWith(() => store.add(key as string, 'v', long), 'invalid_key');
        await rejectsWith(() => store.delete(key as string), 'invalid_key');
        await rejectsWith(() => store.getMany(['fine', key as string]), 'invalid_key');
      }
      await store.set('k'.repeat(MAX_CACHE_KEY_LENGTH), 'longest', long);
      assert.equal(await store.get('k'.repeat(MAX_CACHE_KEY_LENGTH)), 'longest');
    }),
    define('invalid TTLs are refused', async ({ store }) => {
      for (const ttlMs of INVALID_TTLS) {
        await rejectsWith(() => store.set('k', 'v', ttlMs as number), 'invalid_ttl');
        await rejectsWith(() => store.add('k', 'v', ttlMs as number), 'invalid_ttl');
      }
      assert.equal(await store.get('k'), null);
    }),
    define('values other than strings and bytes are refused', async ({ store }) => {
      for (const value of [42, null, undefined, { a: 1 }, [1], new ArrayBuffer(1)] as unknown[]) {
        await rejectsWith(() => store.set('k', value as string, long), 'invalid_value');
        await rejectsWith(() => store.add('k', value as string, long), 'invalid_value');
      }
    }),
    define('sibling namespaces never share a key, and a view keeps its own', async ({ store }) => {
      const pages = store.namespace('pages');
      const feeds = store.namespace('feeds');
      assert.equal(store.namespace('pages'), pages, 'one name returns one view');
      await store.set('k', 'root', long);
      await pages.set('k', 'pages', long);
      await feeds.set('k', 'feeds', long);
      const nested = pages.namespace('k');
      await nested.set('x', 'nested', long);
      assert.deepEqual(
        [await store.get('k'), await pages.get('k'), await feeds.get('k'), await nested.get('x')],
        ['root', 'pages', 'feeds', 'nested'],
      );
      await pages.delete('k');
      assert.deepEqual([await store.get('k'), await feeds.get('k')], ['root', 'feeds']);
      assert.equal(await feeds.add('k', 'again', long), false);
    }),
    define('invalid namespace names are refused', async ({ store }) => {
      for (const name of ['', 'a:b', 'n'.repeat(65), 'with space', 42]) {
        assert.throws(
          () => store.namespace(name as string),
          (error: unknown) => CacheErrors.is(error, 'invalid_namespace'),
        );
      }
    }),
    define('closing a namespace stops it for no consumer of its name', async ({ store }) => {
      const pages = store.namespace('pages');
      const nested = pages.namespace('inner');
      await pages.set('k', 'v', long);
      await pages.close();
      await pages.close();
      assert.equal(store.namespace('pages'), pages, 'the name still returns its one view');
      assert.equal(await store.namespace('pages').get('k'), 'v');
      await nested.set('k', 'nested', long);
      assert.equal(await pages.namespace('inner').get('k'), 'nested');
      await store.set('k', 'root', long);
      assert.equal(await store.get('k'), 'root');
    }),
    define('closing the store stops it and every namespace', async ({ store }) => {
      const pages = store.namespace('pages');
      const nested = pages.namespace('inner');
      await store.close();
      await store.close();
      await rejectsWith(() => store.get('k'), 'closed');
      await rejectsWith(() => store.getMany(['k']), 'closed');
      await rejectsWith(() => store.set('k', 'v', long), 'closed');
      await rejectsWith(() => store.add('k', 'v', long), 'closed');
      await rejectsWith(() => store.delete('k'), 'closed');
      await rejectsWith(() => pages.get('k'), 'closed');
      await rejectsWith(() => nested.get('k'), 'closed');
      assert.throws(
        () => store.namespace('pages'),
        (error: unknown) => CacheErrors.is(error, 'closed'),
      );
    }),
  ]);
}

/**
 * The {@link LeaseStore} conformance cases.
 *
 * @public
 */
export function leaseStoreConformance(
  factory: StoreHarnessFactory<LeaseStore>,
  options: StoreConformanceOptions = {},
): readonly StoreConformanceCase[] {
  const ttl = options.ttlMs ?? 1000;
  const long = Math.max(ttl * 60, 60_000);
  const define = caseRunner(factory);
  const take = async (store: LeaseStore, key: string, ttlMs: number): Promise<Lease> => {
    const lease = await store.acquire(key, ttlMs);
    assert.ok(lease !== null, 'the key was free');
    return lease;
  };
  return Object.freeze([
    define('acquire takes a free key and refuses a held one', async ({ store }) => {
      const lease = await take(store, 'job', long);
      assert.equal(await store.acquire('job', long), null);
      assert.notEqual(await store.acquire('other', long), null);
      assert.equal(lease.key, 'job');
    }),
    define('a lease is frozen data with a token and a positive fence', async ({ store }) => {
      const lease = await take(store, 'job', long);
      assert.ok(Object.isFrozen(lease));
      assert.equal(typeof lease.token, 'string');
      assert.ok(lease.token.length >= 16, 'the token is long enough to be unguessable');
      assert.ok(Number.isSafeInteger(lease.fence) && lease.fence > 0);
    }),
    define('release frees the key once', async ({ store }) => {
      const lease = await take(store, 'job', long);
      assert.equal(await store.release(lease), true);
      assert.equal(await store.release(lease), false);
      const next = await take(store, 'job', long);
      assert.equal(await store.renew(lease, long), false, 'a released lease stays released');
      assert.equal(await store.release(next), true);
    }),
    define('renew keeps a lease past its first TTL', async ({ store, advance }) => {
      const lease = await take(store, 'job', ttl);
      await advance(Math.ceil(ttl * 0.6));
      assert.equal(await store.renew(lease, ttl), true);
      await advance(Math.ceil(ttl * 0.6));
      assert.equal(await store.acquire('job', long), null, 'the renewed lease still holds');
      assert.equal(await store.release(lease), true);
    }),
    define(
      "an expired holder cannot renew or release the next holder's lease",
      async ({ store, advance }) => {
        const stale = await take(store, 'job', ttl);
        await advance(Math.ceil(ttl * 1.5));
        const next = await take(store, 'job', long);
        assert.equal(await store.renew(stale, long), false);
        assert.equal(await store.release(stale), false);
        assert.equal(await store.acquire('job', long), null, 'the next holder keeps the key');
        assert.ok(next.fence > stale.fence, 'the next holder has a higher fence');
        assert.equal(await store.release(next), true);
      },
    ),
    define('fences grow with every acquisition', async ({ store }) => {
      const fences: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        const lease = await take(store, 'job', long);
        fences.push(lease.fence, (await take(store, `other-${String(round)}`, long)).fence);
        assert.equal(await store.release(lease), true);
      }
      for (let index = 1; index < fences.length; index += 1) {
        assert.ok((fences[index] ?? 0) > (fences[index - 1] ?? 0), 'fences strictly increase');
      }
    }),
    define('a lease with another token or fence changes nothing', async ({ store }) => {
      const lease = await take(store, 'job', long);
      const forgedToken = { ...lease, token: `${lease.token}x` };
      const forgedFence = { ...lease, fence: lease.fence + 1 };
      for (const forged of [forgedToken, forgedFence]) {
        assert.equal(await store.renew(forged, long), false);
        assert.equal(await store.release(forged), false);
      }
      assert.equal(await store.acquire('job', long), null);
      assert.equal(await store.release(lease), true);
    }),
    define('concurrent acquisitions of one key yield one lease', async ({ store }) => {
      const leases = await Promise.all(
        Array.from({ length: 20 }, () => store.acquire('race', long)),
      );
      assert.equal(leases.filter((lease) => lease !== null).length, 1);
    }),
    define('an expired lease frees its key', async ({ store, advance }) => {
      const lease = await take(store, 'job', ttl);
      await advance(Math.ceil(ttl * 1.5));
      assert.equal(await store.release(lease), false);
      await take(store, 'job', long);
    }),
    define('invalid keys, TTLs and leases are refused', async ({ store }) => {
      for (const key of INVALID_KEYS) {
        await rejectsWith(() => store.acquire(key as string, long), 'invalid_key');
      }
      for (const ttlMs of INVALID_TTLS) {
        await rejectsWith(() => store.acquire('job', ttlMs as number), 'invalid_ttl');
      }
      const lease = await take(store, 'job', long);
      for (const ttlMs of INVALID_TTLS) {
        await rejectsWith(() => store.renew(lease, ttlMs as number), 'invalid_ttl');
      }
      for (const bad of [null, {}, { ...lease, token: '' }, { ...lease, fence: 0 }, 'lease']) {
        await rejectsWith(() => store.renew(bad as Lease, long), 'invalid_lease');
        await rejectsWith(() => store.release(bad as Lease), 'invalid_lease');
      }
    }),
    define('close stops the store', async ({ store }) => {
      const lease = await take(store, 'job', long);
      await store.close();
      await store.close();
      await rejectsWith(() => store.acquire('job', long), 'closed');
      await rejectsWith(() => store.renew(lease, long), 'closed');
      await rejectsWith(() => store.release(lease), 'closed');
    }),
  ]);
}
