/**
 * Ordered database seeders.
 *
 * {@link defineSeeder} pairs a name with an async `run` function that receives
 * an initialized {@link DataSource}; {@link createSeederRegistry} validates a
 * name -> seeder map; {@link runSeeders} runs them in registry insertion order
 * against the supplied data source, failing fast on the first error.
 *
 * ```ts
 * import { defineSeeder, createSeederRegistry, runSeeders } from 'jsails';
 *
 * const seedUsers = defineSeeder('users', async ({ dataSource }) => {
 *   await dataSource.getRepository(User).save([{ name: 'admin' }]);
 * });
 *
 * const registry = createSeederRegistry({ users: seedUsers });
 * await runSeeders(registry, { dataSource });        // all seeders, in order
 * await runSeeders(registry, { dataSource, names: ['users'] }); // only "users"
 * ```
 *
 * A seeder name is declared explicitly (not derived from a variable name) so
 * the CLI `--only` filter and error reporting target a stable, human-readable
 * identity. Seeders run against an already-initialized data source supplied by
 * the caller; the runner never opens or closes a connection. Failures are
 * wrapped in a value-free {@link SeederError} that records the seeder name and
 * the original error as `cause`.
 */

import type { DataSource } from 'typeorm';
import { assertInitializedDataSource } from './data-source-guard.js';
import { JsailsError } from '../errors/jsails-error.js';
import type { Awaitable } from '../contracts/awaitable.js';

/** Machine-readable reason for a {@link SeederError}. */
export type SeederErrorCode =
  'invalid_definition' | 'missing_data_source' | 'not_found' | 'seeder_failed';

/** Raised for an invalid seeder declaration, selection, or a failed seeder. */
export class SeederError extends JsailsError {
  /** The seeder that failed, when the error wraps a seeder's own failure. */
  readonly seederName: string | undefined;

  constructor(
    readonly code: SeederErrorCode,
    message: string,
    options: { seederName?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.seederName = options.seederName;
  }
}

/** The runtime context handed to a seeder's `run`. */
export interface SeederContext {
  /** The initialized data source the seeder writes through. */
  readonly dataSource: DataSource;
}

/** A seeder body: performs the inserts, then resolves. */
export type SeederRun = (context: SeederContext) => Awaitable<void>;

/** A named, runnable seeder. */
export interface Seeder {
  /** Stable, human-readable identity (matches its registry key). */
  readonly name: string;
  /** The seeding work, invoked exactly once per `runSeeders` call. */
  readonly run: SeederRun;
}

/** A name -> seeder mapping; keys are the seeder names. */
export type SeederRegistry = Readonly<Record<string, Seeder>>;

/** Options for {@link runSeeders}. */
export interface SeederRunOptions {
  /** The initialized data source every selected seeder receives. */
  readonly dataSource: DataSource;
  /**
   * The seeders to run, in registry order. Absent runs all seeders; an empty
   * array runs none. A name not present in the registry is a {@link SeederError}.
   */
  readonly names?: readonly string[];
}

/**
 * Define a single seeder: a name plus its `run` function. The name is stable
 * and must match the registry key the seeder is stored under.
 */
export function defineSeeder(name: string, run: SeederRun): Seeder {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new SeederError('invalid_definition', 'defineSeeder: "name" must be a non-empty string');
  }
  if (typeof run !== 'function') {
    throw new SeederError('invalid_definition', 'defineSeeder: "run" must be a function');
  }
  return Object.freeze({ name, run });
}

/**
 * Validate a name -> seeder map: every key must be a non-empty string and every
 * value a seeder whose declared `name` matches its key. Returns the same map
 * (already read-only-typed); it exists so a malformed registry fails at
 * construction rather than at first run.
 */
export function createSeederRegistry<const R extends Readonly<Record<string, Seeder>>>(
  seeders: R,
): Readonly<R> {
  if (seeders === null || typeof seeders !== 'object' || Array.isArray(seeders)) {
    throw new SeederError(
      'invalid_definition',
      'createSeederRegistry: "seeders" must be an object',
    );
  }
  for (const [key, seeder] of Object.entries(seeders)) {
    if (key.trim() === '') {
      throw new SeederError('invalid_definition', 'seeder name must be a non-empty string');
    }
    if (seeder === null || typeof seeder !== 'object') {
      throw new SeederError('invalid_definition', `seeder "${key}" must be a seeder object`);
    }
    if (typeof seeder.name !== 'string' || seeder.name.trim() === '') {
      throw new SeederError('invalid_definition', `seeder "${key}" must declare a non-empty name`);
    }
    if (typeof seeder.run !== 'function') {
      throw new SeederError('invalid_definition', `seeder "${key}" must define a run function`);
    }
    if (seeder.name !== key) {
      throw new SeederError(
        'invalid_definition',
        `seeder "${key}" declares a different name; keys must match the declared name`,
      );
    }
  }
  return seeders;
}

/**
 * Run the selected seeders in registry insertion order against the supplied
 * initialized data source, failing fast on the first error. Returns the names
 * of the seeders that ran, in order.
 */
export async function runSeeders(
  registry: SeederRegistry,
  options: SeederRunOptions,
): Promise<string[]> {
  const dataSource = assertInitializedDataSource(
    options.dataSource,
    'runSeeders',
    (message) => new SeederError('missing_data_source', message),
  );
  const entries = Object.entries(registry).map(([, seeder]) => seeder);
  const selected = selectSeeders(entries, options.names);
  const context: SeederContext = { dataSource };
  const ran: string[] = [];
  for (const seeder of selected) {
    try {
      await seeder.run(context);
      ran.push(seeder.name);
    } catch (error) {
      throw new SeederError('seeder_failed', `seeder "${seeder.name}" failed`, {
        seederName: seeder.name,
        cause: error,
      });
    }
  }
  return ran;
}

/** Filter the registry to the requested names, preserving registry order. */
function selectSeeders(seeders: readonly Seeder[], names: readonly string[] | undefined): Seeder[] {
  if (names === undefined) {
    return [...seeders];
  }
  const known = new Set(seeders.map((seeder) => seeder.name));
  for (const name of names) {
    // A requested name is caller (CLI) input; the message never echoes it.
    if (!known.has(name)) {
      throw new SeederError('not_found', 'requested seeder is not registered');
    }
  }
  const requested = new Set(names);
  return seeders.filter((seeder) => requested.has(seeder.name));
}
