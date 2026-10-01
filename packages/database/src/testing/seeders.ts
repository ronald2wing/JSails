/**
 * Seeders: named functions that write a data set through a data source's
 * models. `defineSeeder(name, run)` declares one; `runSeeders(ds, seeders)`
 * runs them in order, or only those named in `only`, in that same order.
 *
 * Each seeder runs in a `transaction()` of its own, so a seeder that fails
 * leaves none of its writes, the seeders before it stay, and the run stops
 * with `testing.seeder_failed` (the seeder's name in the context, its
 * failure as the cause). Inside `withTestTransaction` every seeder is a
 * savepoint and all of it rolls back with the test.
 */

import type { JsailsDataSource } from '../record/data-source.js';
import { internalsOf } from '../record/data-source.js';
import { transaction } from '../transaction/run-transaction.js';
import { TestingErrors } from './testing-errors.js';

/** What a seeder's `run` receives. */
export interface SeederContext {
  /** The data source whose models the seeder writes through. */
  readonly dataSource: JsailsDataSource;
}

/** A named seeder. */
export interface Seeder {
  /** Lowercase letters, digits, `_` and `-`, starting with a letter; at most 64. */
  readonly name: string;
  readonly run: (context: SeederContext) => unknown;
}

/** Options of {@link runSeeders}. */
export interface RunSeedersOptions {
  /** Run only these seeders (in the order of `seeders`). Default: all of them. */
  readonly only?: readonly string[];
}

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * A seeder named `name` that runs `run`.
 *
 * ```ts
 * const demo = defineSeeder('demo', async () => {
 *   await users.createList(3);
 * });
 * await runSeeders(ds, [demo]);
 * ```
 *
 * @throws `testing.invalid_seeder`.
 */
export function defineSeeder(name: string, run: (context: SeederContext) => unknown): Seeder {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TestingErrors.Error('invalid_seeder', { field: 'name' });
  }
  if (typeof run !== 'function') throw new TestingErrors.Error('invalid_seeder', { field: 'run' });
  return Object.freeze({ name, run });
}

function checkSeeders(seeders: unknown): readonly Seeder[] {
  if (!Array.isArray(seeders))
    throw new TestingErrors.Error('invalid_seeder', { field: 'seeders' });
  const names = new Set<string>();
  for (const seeder of seeders as unknown[]) {
    const { name, run } = (seeder ?? {}) as Partial<Seeder>;
    if (typeof name !== 'string' || !NAME.test(name) || typeof run !== 'function') {
      throw new TestingErrors.Error('invalid_seeder', { field: 'seeders' });
    }
    if (names.has(name)) throw new TestingErrors.Error('duplicate_seeder', { seeder: name });
    names.add(name);
  }
  return seeders as readonly Seeder[];
}

function selected(seeders: readonly Seeder[], only: unknown): readonly Seeder[] {
  if (only === undefined) return seeders;
  if (!Array.isArray(only)) throw new TestingErrors.Error('invalid_seeder', { field: 'only' });
  const requested = new Set<unknown>(only);
  const known = new Set(seeders.map((seeder) => seeder.name));
  // A requested name comes from a command line; the error never echoes it.
  for (const name of requested) {
    if (typeof name !== 'string' || !known.has(name)) {
      throw new TestingErrors.Error('unknown_seeder');
    }
  }
  return seeders.filter((seeder) => requested.has(seeder.name));
}

/**
 * Run `seeders` (or those `options.only` names) in order on `dataSource`,
 * each in a transaction of its own, and resolve with the names that ran.
 *
 * @throws `testing.invalid_seeder`, `testing.duplicate_seeder`,
 *   `testing.unknown_seeder`, and `testing.seeder_failed`, whose cause is
 *   the seeder's own failure.
 */
export async function runSeeders(
  dataSource: JsailsDataSource,
  seeders: readonly Seeder[],
  options: RunSeedersOptions = {},
): Promise<readonly string[]> {
  internalsOf(dataSource).assertOpen();
  if (options === null || typeof options !== 'object') {
    throw new TestingErrors.Error('invalid_seeder', { field: 'options' });
  }
  const chosen = selected(checkSeeders(seeders), options.only);
  const context: SeederContext = Object.freeze({ dataSource });
  const ran: string[] = [];
  for (const seeder of chosen) {
    try {
      await transaction(dataSource, () => seeder.run(context));
    } catch (error) {
      throw new TestingErrors.Error('seeder_failed', { seeder: seeder.name }, { cause: error });
    }
    ran.push(seeder.name);
  }
  return Object.freeze(ran);
}
