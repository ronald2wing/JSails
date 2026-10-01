/**
 * The store contract harness: a package store (sessions, flags, config,
 * memberships, ...) declares its semantics once, as data, and
 * `storeContract(name, makeStore, cases)` holds it to them on the run's
 * driver of the three-driver matrix, through `forEachDriver`.
 *
 * A store declares the operations it has, and each brings its cases:
 *
 * - always: a key never written reads as `undefined`;
 * - `upsert`: a write reads back, a second write of a key replaces the value
 *   in the same row, two keys stay apart, a write inside a test transaction
 *   rolls back with it, and two writes of a key inside one transaction leave
 *   that transaction usable;
 * - `unique`: an insert reads back, a second insert of a key is refused as
 *   the store's declared conflict and keeps the first value, a refused
 *   insert inside a transaction leaves the transaction usable (the store
 *   tries its statement in a nested transaction, so the poisoned-frame rule
 *   does not reach the caller), and an insert rolls back with a test
 *   transaction;
 * - `concurrency: n` with `upsert` or `unique`: `n` writers at once on one
 *   key, on separate connections, leave one row (upsert), or exactly one of
 *   them succeeds and every other is a conflict (unique);
 * - `expiry`: a value reads until its TTL passes and as nothing after it,
 *   before any sweep, and `sweep` removes the expired rows and keeps the
 *   live ones;
 * - `remove`: removing a key keeps the other.
 *
 * Time is the contract's: `makeStore` receives a clock that starts at a
 * fixed instant (2030-01-01T00:00:00Z) and moves only by `advance`, so no
 * case sleeps, and a store that reads the real clock instead fails the
 * expiry cases. Concurrency needs real commits, so cases run without a test
 * transaction; the suite has one data source on a test database of its own
 * and empties its tables before each case. A case's failure is an
 * assertion of node:assert with a fixed message.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import type { ModelTarget } from '../model/model-spec.js';
import type { JsailsDataSource } from '../record/data-source.js';
import { transaction, withTestTransaction } from '../transaction/run-transaction.js';
import { forEachDriver, type MatrixDriver } from './driver-matrix.js';
import { countRows, emptyTables } from './empty-tables.js';
import { createTestDataSource, matrixTestDatabase } from './test-data-source.js';
import { TestingErrors } from './testing-errors.js';

/** The contract's clock. */
export interface TestClock {
  /** The contract's current time. */
  now(): Date;
  /** Move the clock forward by `ms` milliseconds. */
  advance(ms: number): void;
}

/** What `makeStore` receives for one case. */
export interface StoreContractContext {
  readonly driver: MatrixDriver;
  /** The suite's data source on a test database of its own; its tables are empty. */
  readonly dataSource: JsailsDataSource;
  /** The time the store must read. */
  readonly clock: TestClock;
}

/** A store's declared semantics; `K` is a key, `V` a value. */
export interface StoreContractCases<S, K, V> {
  /** The models whose tables the store uses. */
  readonly models: readonly ModelTarget[];
  /** The table that holds one row per key. */
  readonly table: ModelTarget;
  /** Two different keys. */
  readonly keys: readonly [K, K];
  /** Two different values; compared with `assert.deepStrictEqual`. */
  readonly values: readonly [V, V];
  /** The value of `key`, or `undefined` when it has none (or it expired). */
  read(store: S, key: K): Promise<V | undefined>;
  /** Write `value` under `key`, replacing a value it has. */
  readonly upsert?: (store: S, key: K, value: V) => Promise<unknown>;
  /** Insert a key that must not exist yet. */
  readonly unique?: {
    insert(store: S, key: K, value: V): Promise<unknown>;
    /** Whether `error` is the store's refusal of an existing key. */
    isConflict(error: unknown): boolean;
  };
  /** Writes `upsert` or `unique` races at once on one key: 2 to 64. */
  readonly concurrency?: number;
  /** Values that stop reading once their TTL passed. */
  readonly expiry?: {
    write(store: S, key: K, value: V, ttlMs: number): Promise<unknown>;
    /** The TTL the cases use, in milliseconds: at least 2. */
    readonly ttlMs: number;
    /** Delete the expired rows. */
    sweep?(store: S): Promise<unknown>;
  };
  /** Delete `key`'s value. */
  readonly remove?: (store: S, key: K) => Promise<unknown>;
  /** Release what a store holds (timers, connections) after each case. */
  readonly close?: (store: S) => unknown;
}

/** Options of {@link storeContract}. */
export interface StoreContractOptions {
  /** The drivers the contract applies to; default all three. */
  readonly drivers?: readonly MatrixDriver[];
  /** The environment the matrix reads; default the driver matrix's (`process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** One case of a contract, with what it runs on. */
export interface ContractCase {
  readonly name: string;
  run(context: {
    readonly driver: MatrixDriver;
    readonly dataSource: JsailsDataSource;
  }): Promise<void>;
}

/** Where the contract's clock starts. */
const CLOCK_START = Date.UTC(2030, 0, 1);
/** The TTL of a write through `expiry` when the store has no other write: an hour. */
const LONG_TTL = 3_600_000;
const MAX_WRITERS = 64;
const CASE_KEYS: ReadonlySet<string> = new Set([
  'models',
  'table',
  'keys',
  'values',
  'read',
  'upsert',
  'unique',
  'concurrency',
  'expiry',
  'remove',
  'close',
]);

function testClock(): TestClock {
  let now = CLOCK_START;
  return Object.freeze({
    now: () => new Date(now),
    advance: (ms: number) => {
      if (!Number.isFinite(ms) || ms < 0)
        throw new RangeError('advance takes a non-negative number');
      now += ms;
    },
  });
}

function invalid(field: string): Error {
  return new TestingErrors.Error('invalid_contract', { field });
}

function checkCases<S, K, V>(cases: StoreContractCases<S, K, V>): void {
  if (cases === null || typeof cases !== 'object') throw invalid('cases');
  if (Object.keys(cases).some((key) => !CASE_KEYS.has(key))) throw invalid('cases');
  if (!Array.isArray(cases.models) || !cases.models.includes(cases.table)) throw invalid('table');
  if (!Array.isArray(cases.keys) || cases.keys.length !== 2) throw invalid('keys');
  if (!Array.isArray(cases.values) || cases.values.length !== 2) throw invalid('values');
  if (typeof cases.read !== 'function') throw invalid('read');
  if (cases.upsert !== undefined && typeof cases.upsert !== 'function') throw invalid('upsert');
  const { unique, expiry, concurrency } = cases;
  if (
    unique !== undefined &&
    (typeof unique.insert !== 'function' || typeof unique.isConflict !== 'function')
  ) {
    throw invalid('unique');
  }
  if (
    expiry !== undefined &&
    (typeof expiry.write !== 'function' ||
      !Number.isSafeInteger(expiry.ttlMs) ||
      expiry.ttlMs < 2 ||
      (expiry.sweep !== undefined && typeof expiry.sweep !== 'function'))
  ) {
    throw invalid('expiry');
  }
  if (cases.remove !== undefined && typeof cases.remove !== 'function') throw invalid('remove');
  if (cases.close !== undefined && typeof cases.close !== 'function') throw invalid('close');
  if (
    concurrency !== undefined &&
    (!Number.isSafeInteger(concurrency) ||
      concurrency < 2 ||
      concurrency > MAX_WRITERS ||
      (cases.upsert === undefined && unique === undefined))
  ) {
    throw invalid('concurrency');
  }
  if (cases.upsert === undefined && unique === undefined && expiry === undefined) {
    throw invalid('cases');
  }
}

/**
 * The cases `cases` declares, as plain data: `storeContract` registers each
 * as a test of its suite. Exported for the harness's own tests.
 *
 * @throws `testing.invalid_contract`.
 */
export function contractCases<S, K, V>(
  makeStore: (context: StoreContractContext) => S | Promise<S>,
  cases: StoreContractCases<S, K, V>,
): readonly ContractCase[] {
  if (typeof makeStore !== 'function') throw invalid('makeStore');
  checkCases(cases);
  const [keyA, keyB] = cases.keys;
  const [valueA, valueB] = cases.values;
  const { upsert, unique, expiry, remove, concurrency } = cases;
  const write: (store: S, key: K, value: V) => Promise<unknown> =
    upsert ??
    (unique === undefined
      ? (store, key, value) =>
          (expiry as NonNullable<typeof expiry>).write(store, key, value, LONG_TTL)
      : (store, key, value) => unique.insert(store, key, value));
  const entries: ContractCase[] = [];

  const add = (
    name: string,
    body: (store: S, context: StoreContractContext) => Promise<void>,
  ): void => {
    entries.push({
      name,
      run: async ({ driver, dataSource }) => {
        const context: StoreContractContext = Object.freeze({
          driver,
          dataSource,
          clock: testClock(),
        });
        const store = await makeStore(context);
        try {
          await body(store, context);
        } finally {
          await cases.close?.(store);
        }
      },
    });
  };
  const rows = (context: StoreContractContext): Promise<number> =>
    countRows(context.dataSource, cases.table);

  add('reads nothing for a key never written', async (store) => {
    assert.equal(
      await cases.read(store, keyA),
      undefined,
      'a key never written reads as undefined',
    );
  });

  if (upsert !== undefined) {
    add('upsert: writes a value and reads it back', async (store, context) => {
      await upsert(store, keyA, valueA);
      assert.deepEqual(await cases.read(store, keyA), valueA, 'the value written reads back');
      assert.equal(await rows(context), 1, 'one write is one row');
    });
    add('upsert: replaces the value of a key written again, in one row', async (store, context) => {
      await upsert(store, keyA, valueA);
      await upsert(store, keyA, valueB);
      assert.deepEqual(await cases.read(store, keyA), valueB, 'the second write wins');
      assert.equal(await rows(context), 1, 'a key written twice is still one row');
    });
    add('upsert: keeps two keys apart', async (store, context) => {
      await upsert(store, keyA, valueA);
      await upsert(store, keyB, valueB);
      assert.deepEqual(await cases.read(store, keyA), valueA, 'the first key keeps its value');
      assert.deepEqual(await cases.read(store, keyB), valueB, 'the second key keeps its value');
      assert.equal(await rows(context), 2, 'two keys are two rows');
    });
    add('upsert: replaces a value inside a transaction, which goes on', async (store, context) => {
      await transaction(context.dataSource, async () => {
        await upsert(store, keyA, valueA);
        await upsert(store, keyA, valueB);
        assert.deepEqual(await cases.read(store, keyA), valueB, 'the transaction sees its write');
      });
      assert.deepEqual(await cases.read(store, keyA), valueB, 'the transaction committed');
      assert.equal(await rows(context), 1, 'a key written twice is still one row');
    });
    if (concurrency !== undefined) {
      add(
        `upsert: keeps one row when ${concurrency} writers write one key at once`,
        async (store, context) => {
          const outcomes = await Promise.allSettled(
            Array.from({ length: concurrency }, (_, index) =>
              upsert(store, keyA, index % 2 === 0 ? valueA : valueB),
            ),
          );
          assert.equal(
            outcomes.filter((outcome) => outcome.status === 'rejected').length,
            0,
            'every concurrent upsert succeeds',
          );
          assert.equal(await rows(context), 1, 'concurrent writes of one key leave one row');
          const value = await cases.read(store, keyA);
          assert.ok(
            isDeepStrictEqual(value, valueA) || isDeepStrictEqual(value, valueB),
            'the key holds one of the values written',
          );
        },
      );
    }
  }

  if (unique !== undefined) {
    add('unique: inserts a value and reads it back', async (store, context) => {
      await unique.insert(store, keyA, valueA);
      assert.deepEqual(await cases.read(store, keyA), valueA, 'the value inserted reads back');
      assert.equal(await rows(context), 1, 'one insert is one row');
    });
    add(
      'unique: refuses a second insert of a key as a conflict, keeping the first value',
      async (store, context) => {
        await unique.insert(store, keyA, valueA);
        await assert.rejects(
          unique.insert(store, keyA, valueB),
          (error: unknown) => unique.isConflict(error),
          'a second insert of a key is refused as the declared conflict',
        );
        assert.deepEqual(await cases.read(store, keyA), valueA, 'the first value stays');
        assert.equal(await rows(context), 1, 'the refused insert left no row');
      },
    );
    add(
      'unique: refuses a conflict inside a transaction, which goes on',
      async (store, context) => {
        await transaction(context.dataSource, async () => {
          await unique.insert(store, keyA, valueA);
          await assert.rejects(
            unique.insert(store, keyA, valueB),
            (error: unknown) => unique.isConflict(error),
            'the conflict is refused as declared inside a transaction',
          );
          await unique.insert(store, keyB, valueB);
        });
        assert.deepEqual(await cases.read(store, keyA), valueA, 'the first insert committed');
        assert.deepEqual(
          await cases.read(store, keyB),
          valueB,
          'the insert after the conflict committed',
        );
        assert.equal(await rows(context), 2, 'two keys are two rows');
      },
    );
    if (concurrency !== undefined) {
      add(
        `unique: lets exactly one of ${concurrency} concurrent inserts of a key succeed`,
        async (store, context) => {
          const outcomes = await Promise.allSettled(
            Array.from({ length: concurrency }, (_, index) =>
              unique.insert(store, keyA, index % 2 === 0 ? valueA : valueB),
            ),
          );
          const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
          assert.equal(
            outcomes.length - rejected.length,
            1,
            'exactly one concurrent insert succeeds',
          );
          assert.ok(
            rejected.every((outcome) => unique.isConflict(outcome.reason)),
            'every other concurrent insert is the declared conflict',
          );
          assert.equal(await rows(context), 1, 'concurrent inserts of one key leave one row');
        },
      );
    }
  }

  add('rolls a write back with the test transaction', async (store, context) => {
    await withTestTransaction(context.dataSource, async () => {
      await write(store, keyA, valueA);
      assert.deepEqual(
        await cases.read(store, keyA),
        valueA,
        'the test transaction sees the write',
      );
    });
    assert.equal(await cases.read(store, keyA), undefined, 'the write rolled back with the test');
    assert.equal(await rows(context), 0, 'no row survived the test transaction');
  });

  if (expiry !== undefined) {
    const { ttlMs } = expiry;
    add('expiry: reads a value until its TTL passes, then nothing', async (store, context) => {
      await expiry.write(store, keyA, valueA, ttlMs);
      context.clock.advance(ttlMs - 1);
      assert.deepEqual(
        await cases.read(store, keyA),
        valueA,
        'a value reads before its TTL passes',
      );
      context.clock.advance(2);
      assert.equal(
        await cases.read(store, keyA),
        undefined,
        'a value reads as nothing once its TTL passed',
      );
    });
    const sweep = expiry.sweep;
    if (sweep !== undefined) {
      add('expiry: sweeps expired rows and keeps live ones', async (store, context) => {
        await expiry.write(store, keyA, valueA, ttlMs);
        context.clock.advance(ttlMs + 1);
        await expiry.write(store, keyB, valueB, ttlMs);
        await sweep(store);
        assert.equal(await rows(context), 1, 'the sweep removed the expired row only');
        assert.deepEqual(await cases.read(store, keyB), valueB, 'the live value stays');
      });
    }
  }

  if (remove !== undefined) {
    add('remove: removes one key and keeps the other', async (store, context) => {
      await write(store, keyA, valueA);
      await write(store, keyB, valueB);
      await remove(store, keyA);
      assert.equal(await cases.read(store, keyA), undefined, 'the removed key reads as nothing');
      assert.deepEqual(await cases.read(store, keyB), valueB, 'the other key keeps its value');
      assert.equal(await rows(context), 1, 'the removed key has no row');
    });
  }

  return Object.freeze(entries);
}

/**
 * Hand a node:test registration promise back to the runner. It settles when
 * the test finishes and never rejects (the runner reports failures itself),
 * so a rejection would be a runner defect; it is rethrown as an uncaught
 * exception rather than dropped.
 */
function scheduled(registration: Promise<void>): void {
  registration.catch((error: unknown) => {
    setImmediate(() => {
      throw error;
    });
  });
}

/**
 * Declare a suite `name` holding the store `makeStore` builds to `cases`, on
 * the run's driver (name the file `*.database.test.ts`, so the database
 * suite runs it on each server). Returns node:test's promise for the suite.
 *
 * ```ts
 * void storeContract('the flag store', ({ dataSource, clock }) => createFlagStore({ dataSource, now: clock.now }), {
 *   models: [Flag],
 *   table: Flag,
 *   keys: ['a', 'b'],
 *   values: [true, false],
 *   read: (store, key) => store.get(key),
 *   upsert: (store, key, value) => store.set(key, value),
 *   concurrency: 4,
 * });
 * ```
 *
 * @throws `testing.invalid_contract`.
 */
export function storeContract<S, K, V>(
  name: string,
  makeStore: (context: StoreContractContext) => S | Promise<S>,
  cases: StoreContractCases<S, K, V>,
  options: StoreContractOptions = {},
): Promise<void> {
  if (typeof name !== 'string' || name.trim() === '') throw invalid('name');
  const entries = contractCases(makeStore, cases);
  const { env, drivers } = options;
  return forEachDriver(
    name,
    ({ driver }) => {
      let dataSource: JsailsDataSource | undefined;
      const opened = (): JsailsDataSource => {
        assert.ok(dataSource !== undefined, 'the contract data source opened');
        return dataSource;
      };
      before(async () => {
        dataSource = await createTestDataSource(cases.models, {
          database: matrixTestDatabase(env),
        });
      });
      after(() => dataSource?.close());
      beforeEach(() => emptyTables(opened()));
      for (const entry of entries) {
        scheduled(it(entry.name, () => entry.run({ driver, dataSource: opened() })));
      }
    },
    { ...(env === undefined ? {} : { env }), ...(drivers === undefined ? {} : { drivers }) },
  );
}
