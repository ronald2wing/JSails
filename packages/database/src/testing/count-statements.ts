/**
 * `countStatements(ds, fn)`: the one helper for statement budgets in tests.
 * It runs `fn` with a query ledger scoped to `ds`'s engine and returns it,
 * with `count`, `records` (SQL, origin, duration, never values) and
 * `repeatedShapes()` for spotting N+1 patterns.
 *
 * Two kinds of statement are left out, so a budget means the same thing in
 * every test: those of other data sources, and the transaction control the
 * engine issues (`BEGIN`, `COMMIT`, savepoints, origin `engine`). Under
 * `withTestTransaction` every statement issued outside an app transaction
 * runs in a savepoint of its own, so counting control statements would make
 * a budget depend on whether the default per-test transaction is on.
 */

import {
  createScopedQueryLedger,
  withQueryLedger,
  type QueryLedger,
} from '../engine/query-ledger.js';
import { internalsOf, type JsailsDataSource } from '../record/data-source.js';
import { engineBindingOf } from '../transaction/bound-engine.js';

/** The ledger origin of the engine's own transaction control. */
const ENGINE_ORIGIN = 'engine';
const EXCLUDED_ORIGINS: ReadonlySet<string> = new Set([ENGINE_ORIGIN]);

/**
 * Run `fn` and resolve with the ledger of the statements it sent to
 * `dataSource`'s database (and every promise it started), transaction
 * control left out. Rejects with `fn`'s failure.
 *
 * ```ts
 * const ledger = await countStatements(ds, () => Post.all().includes({ comments: true }).getMany());
 * assert.equal(ledger.count, 2);
 * assert.deepEqual(ledger.repeatedShapes(), []);
 * ```
 *
 * @throws `data_source.closed`, `data_source.duplicate_package`.
 */
export async function countStatements(
  dataSource: JsailsDataSource,
  fn: () => unknown,
): Promise<QueryLedger> {
  const internals = internalsOf(dataSource);
  internals.assertOpen();
  const { dialectEngine } = engineBindingOf(await internals.engine());
  const ledger = createScopedQueryLedger(
    { source: dialectEngine, excludeOrigins: EXCLUDED_ORIGINS },
    { detail: true },
  );
  await withQueryLedger(ledger, fn);
  return ledger;
}
