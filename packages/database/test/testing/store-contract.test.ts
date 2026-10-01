/**
 * The store contract harness itself, on SQLite: the sample store passes
 * every case, a store that breaks one semantic fails exactly the case that
 * states it (a duplicate row per write, expiry on the real clock, a conflict
 * that poisons the caller's transaction), and a malformed contract is
 * refused.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  createTestDataSource,
  storeContract,
  TestingErrors,
  type StoreContractCases,
  type StoreContractContext,
  type TestDataSource,
} from '../../src/testing/index.js';
import { emptyTables } from '../../src/testing/empty-tables.js';
import { contractCases, type ContractCase } from '../../src/testing/store-contract.js';
import {
  brokenStores,
  createSampleStore,
  Entry,
  LooseEntry,
  SAMPLE_CONTRACT,
  STORE_MODELS,
  type SampleStore,
} from './fixtures/sample-store.js';

type Cases = StoreContractCases<SampleStore, string, string>;

describe('the store contract harness', () => {
  let ds: TestDataSource;

  before(async () => {
    ds = await createTestDataSource(STORE_MODELS);
  });
  after(() => ds.close());
  beforeEach(() => emptyTables(ds));

  /** Run every case, each on empty tables; the names of those that failed. */
  async function failing(cases: readonly ContractCase[]): Promise<string[]> {
    const failed: string[] = [];
    for (const entry of cases) {
      await emptyTables(ds);
      // A failed assertion, or a store error a case did not expect, fails the case.
      await entry.run({ driver: 'sqlite', dataSource: ds }).then(
        () => undefined,
        () => failed.push(entry.name),
      );
    }
    return failed;
  }

  it('passes the sample store on every case', async () => {
    const cases = contractCases(
      ({ dataSource, clock }) => createSampleStore(dataSource, clock),
      SAMPLE_CONTRACT,
    );
    assert.deepEqual(
      cases.map((entry) => entry.name),
      [
        'reads nothing for a key never written',
        'upsert: writes a value and reads it back',
        'upsert: replaces the value of a key written again, in one row',
        'upsert: keeps two keys apart',
        'upsert: replaces a value inside a transaction, which goes on',
        'upsert: keeps one row when 4 writers write one key at once',
        'unique: inserts a value and reads it back',
        'unique: refuses a second insert of a key as a conflict, keeping the first value',
        'unique: refuses a conflict inside a transaction, which goes on',
        'unique: lets exactly one of 4 concurrent inserts of a key succeed',
        'rolls a write back with the test transaction',
        'expiry: reads a value until its TTL passes, then nothing',
        'expiry: sweeps expired rows and keeps live ones',
        'remove: removes one key and keeps the other',
      ],
    );
    assert.deepEqual(await failing(cases), []);
  });

  it('fails a store that writes a row per write on the one-row cases', async () => {
    const { unique: _unique, expiry: _expiry, ...upsertOnly } = SAMPLE_CONTRACT;
    const loose: Cases = { ...upsertOnly, table: LooseEntry };
    const cases = contractCases(
      ({ dataSource, clock }) => brokenStores.duplicating(dataSource, clock),
      loose,
    );
    assert.deepEqual(await failing(cases), [
      'upsert: replaces the value of a key written again, in one row',
      'upsert: replaces a value inside a transaction, which goes on',
      'upsert: keeps one row when 4 writers write one key at once',
    ]);
  });

  it('fails a store that reads the real clock on the expiry cases', async () => {
    const cases = contractCases(({ dataSource }) => brokenStores.wallClock(dataSource), {
      ...SAMPLE_CONTRACT,
    });
    assert.deepEqual(await failing(cases), [
      'expiry: reads a value until its TTL passes, then nothing',
      'expiry: sweeps expired rows and keeps live ones',
    ]);
  });

  it("fails a store whose conflict poisons the caller's transaction", async () => {
    const cases = contractCases(
      ({ dataSource, clock }) => brokenStores.unguardedClaim(dataSource, clock),
      SAMPLE_CONTRACT,
    );
    assert.deepEqual(await failing(cases), [
      'unique: refuses a conflict inside a transaction, which goes on',
    ]);
  });

  it("closes each case's store", async () => {
    let closed = 0;
    const cases = contractCases(({ dataSource, clock }) => createSampleStore(dataSource, clock), {
      ...SAMPLE_CONTRACT,
      close: () => {
        closed += 1;
      },
    });
    await failing(cases);
    assert.equal(closed, cases.length);
  });

  it('refuses a malformed contract', () => {
    const make = ({ dataSource, clock }: StoreContractContext): SampleStore =>
      createSampleStore(dataSource, clock);
    const malformed: Record<string, Partial<Record<keyof Cases | 'extra', unknown>>> = {
      table: { table: Entry, models: [LooseEntry] },
      keys: { keys: ['only one'] },
      values: { values: 'two' },
      read: { read: undefined },
      upsert: { upsert: 'write' },
      unique: { unique: { insert: () => undefined } },
      expiry: { expiry: { write: () => undefined, ttlMs: 1 } },
      remove: { remove: 42 },
      close: { close: 'yes' },
      concurrency: { concurrency: 1 },
      cases: { extra: true },
    };
    for (const [field, change] of Object.entries(malformed)) {
      assert.throws(
        () => contractCases(make, { ...SAMPLE_CONTRACT, ...change } as never),
        (error: unknown) =>
          TestingErrors.is(error, 'invalid_contract') && error.context.field === field,
        field,
      );
    }
    assert.throws(
      () =>
        contractCases(make, {
          ...SAMPLE_CONTRACT,
          upsert: undefined,
          unique: undefined,
          expiry: undefined,
          concurrency: undefined,
        } as never),
      (error: unknown) => TestingErrors.is(error, 'invalid_contract'),
    );
    assert.throws(
      () => contractCases('store' as never, SAMPLE_CONTRACT),
      (error: unknown) =>
        TestingErrors.is(error, 'invalid_contract') && error.context.field === 'makeStore',
    );
    assert.throws(
      () => storeContract(' ', make, SAMPLE_CONTRACT),
      (error: unknown) =>
        TestingErrors.is(error, 'invalid_contract') && error.context.field === 'name',
    );
  });
});
