/**
 * The default per-test transaction for node:test: `transactionalTests(ds)`
 * returns `test` and `it`, node:test's own, each of whose tests runs inside
 * `withTestTransaction(ds)`, so whatever it wrote through `ds` (records,
 * set writes, fixtures, factories, raw SQL, afterCommit callbacks of the
 * transactions it ran) is gone when it ends, and the next test starts from
 * the same rows.
 *
 * A test that needs real commits opts out with `{ commits: true }`: an
 * observer that runs after the outermost commit outside the data layer,
 * several connections that must see each other's committed rows, or
 * `detached()` work. It runs with no transaction around it, and the data
 * source's tables are emptied when it ends, so it leaks nothing either.
 *
 * Inside the test transaction app code behaves as in production (see
 * `withTestTransaction`): a `transaction()` is the outermost one it sees, and
 * its afterCommit callbacks run when it fulfils. What differs is only
 * outside the data layer: nothing is ever committed, so a second connection
 * or process sees none of the test's rows.
 *
 * The wrapper, not a `beforeEach` hook, is the seam because a node:test hook
 * cannot run the test's body inside an async context of its own.
 */

import { test as nodeTest, type TestContext, type TestOptions } from 'node:test';

import type { JsailsDataSource } from '../record/data-source.js';
import { withTestTransaction } from '../transaction/run-transaction.js';
import { emptyTables } from './empty-tables.js';
import { TestingErrors } from './testing-errors.js';

/** node:test's options, and whether the test commits for real. */
export interface TransactionalTestOptions extends TestOptions {
  /**
   * Run the test without a transaction around it, so its writes commit, and
   * empty the data source's tables when it ends. Default `false`.
   */
  readonly commits?: boolean;
}

/** A test body; it runs inside the test transaction unless the test commits. */
export type TransactionalTestFn = (t: TestContext) => unknown;

/** Declare a test, as node:test's `test` does. */
export interface TransactionalTest {
  (name: string, fn: TransactionalTestFn): Promise<void>;
  (name: string, options: TransactionalTestOptions, fn: TransactionalTestFn): Promise<void>;
}

/** What {@link transactionalTests} returns: `it` is `test`. */
export interface TransactionalTests {
  readonly test: TransactionalTest;
  readonly it: TransactionalTest;
}

/** The data source, or a function returning it once a `before` hook opened it. */
export type TransactionalTestSource = JsailsDataSource | (() => JsailsDataSource);

/**
 * Run one test's `body` isolated on `dataSource`: inside
 * `withTestTransaction`, or, when it `commits`, for real and then with the
 * tables emptied, whether it passed or failed. Exported for the wrapper's
 * own tests.
 */
export async function runIsolated(
  dataSource: JsailsDataSource,
  body: () => unknown,
  commits: boolean,
): Promise<void> {
  if (!commits) {
    await withTestTransaction(dataSource, body);
    return;
  }
  try {
    await body();
  } finally {
    await emptyTables(dataSource);
  }
}

/**
 * node:test's `test` and `it`, with each test wrapped in
 * `withTestTransaction(source)` unless it declares `{ commits: true }`.
 *
 * ```ts
 * let ds: TestDataSource;
 * before(async () => { ds = await createTestDataSource([Post]); });
 * after(() => ds.close());
 * const { it } = transactionalTests(() => ds);
 *
 * it('creates a post', async () => {
 *   await Post.create({ title: 'a' });
 *   assert.equal(await Post.all().count(), 1);
 * });
 * it('starts empty again', async () => {
 *   assert.equal(await Post.all().count(), 0);
 * });
 * it('publishes after commit', { commits: true }, async () => {
 *   // writes commit; the tables are emptied afterwards
 * });
 * ```
 *
 * @throws `testing.invalid_options` for a source that is neither a data
 *   source nor a function.
 */
export function transactionalTests(source: TransactionalTestSource): TransactionalTests {
  if (typeof source !== 'function' && (typeof source !== 'object' || source === null)) {
    throw new TestingErrors.Error('invalid_options', { field: 'source' });
  }
  const resolve = (): JsailsDataSource => (typeof source === 'function' ? source() : source);

  const wrap =
    (fn: TransactionalTestFn, commits: boolean) =>
    (t: TestContext): Promise<void> =>
      runIsolated(resolve(), () => fn(t), commits);

  function test(
    name: string,
    optionsOrFn: TransactionalTestOptions | TransactionalTestFn,
    maybeFn?: TransactionalTestFn,
  ): Promise<void> {
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
    if (typeof fn !== 'function') throw new TestingErrors.Error('invalid_options', { field: 'fn' });
    if (typeof optionsOrFn === 'function') return nodeTest(name, wrap(fn, false));
    const { commits, ...options } = optionsOrFn;
    if (commits !== undefined && typeof commits !== 'boolean') {
      throw new TestingErrors.Error('invalid_options', { field: 'commits' });
    }
    return nodeTest(name, options, wrap(fn, commits === true));
  }

  return Object.freeze({ test, it: test });
}
