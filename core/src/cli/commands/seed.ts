/**
 * The `seed` command: run registered database seeders against an initialized
 * data source. Its config module defaults to `jsails.seed.js` and
 * default-exports `{ registry, dataSource }` — a {@link SeederRegistry} plus a
 * TypeORM `DataSource` (a `JsailsDataSource` satisfies it). The command owns the
 * data source lifecycle exactly like the migration commands: it initializes the
 * source before running, and destroys it afterward. TypeScript configs must be
 * compiled to JavaScript first, so a `.ts` path is rejected rather than executed.
 */

import { DataSource } from 'typeorm';

import {
  createSeederRegistry,
  runSeeders,
  type Seeder,
  type SeederRegistry,
} from '../../database/seeders.js';

import { DEFAULT_SEED_CONFIG_PATH } from '../../config-modules.js';
import { loadConfigModule } from '../config-loader.js';
import type { CommandModule } from '../descriptor.js';
import type { SEED_OPTIONS } from '../manifest.js';
import { prepareConfigModule } from '../stages.js';
import { relativePathSlot } from '../../support/project-paths.server.js';
import { defineErrors, type ErrorRegistry } from '../../errors/registry.js';

/** The shape a seed config module default-exports. */
interface SeedConfig {
  /** Name -> seeder map, validated structurally (never executed here). */
  readonly registry: SeederRegistry;
  /** The data source every seeder writes through. */
  readonly dataSource: DataSource;
}

/** Options for {@link runSeedCommand}. */
interface SeedCommandOptions {
  /** The seeders to run; absent runs all seeders in registry order. */
  readonly names?: readonly string[];
}

/** Dependency seam for the `seed` command; tests inject a config loader. */
export interface SeedCommandDeps {
  /** Load and validate the seed config module. */
  loadConfig(configPath: string): Promise<SeedConfig>;
  /** Write one output line. */
  stdout(text: string): void;
}

const SEED_CONFIG_ERRORS = {
  invalid_seed_config: {
    kind: 'internal',
    message: 'seed config {path} is invalid: {problem}',
    context: {
      path: 'relative-path',
      problem: ['not_an_object', 'invalid_registry', 'missing_data_source'],
    },
    suggestion:
      'default-export { registry, dataSource } with a seeder registry and a TypeORM DataSource',
  },
} as const;

/**
 * `jsails seed`'s codes, `seed_config.*`: a seed config module whose default
 * export is not `{ registry, dataSource }`. A registry error stays the `cause`.
 */
export const SeedConfigErrors: ErrorRegistry<'seed_config', typeof SEED_CONFIG_ERRORS> =
  defineErrors('seed_config', SEED_CONFIG_ERRORS);

const defaultSeedCommandDeps: SeedCommandDeps = {
  loadConfig: loadSeedConfig,
  stdout: (text) => process.stdout.write(`${text}\n`),
};

/**
 * Validate a seed config default export: a non-null object with a structurally
 * valid `registry` (re-validated without executing any seeder) and a TypeORM
 * `DataSource` under `dataSource`. Exported for direct unit testing.
 */
export function validateSeedConfig(raw: unknown, configPath: string): SeedConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SeedConfigErrors.Error('invalid_seed_config', {
      path: relativePathSlot(configPath),
      problem: 'not_an_object',
    });
  }
  const config = raw as Record<string, unknown>;

  let registry: SeederRegistry;
  try {
    registry = createSeederRegistry(config.registry as Record<string, Seeder>);
  } catch (error) {
    throw new SeedConfigErrors.Error(
      'invalid_seed_config',
      { path: relativePathSlot(configPath), problem: 'invalid_registry' },
      { cause: error },
    );
  }

  if (!(config.dataSource instanceof DataSource)) {
    throw new SeedConfigErrors.Error('invalid_seed_config', {
      path: relativePathSlot(configPath),
      problem: 'missing_data_source',
    });
  }

  return { registry, dataSource: config.dataSource };
}

/** Import the seed config module and return its validated default export. */
async function loadSeedConfig(configPath: string): Promise<SeedConfig> {
  const raw = await loadConfigModule(configPath);
  return validateSeedConfig(raw, configPath);
}

/**
 * Run the seeders named by `options.names` (or all, in registry order) against
 * the config's data source, initializing and destroying it around the run.
 * Returns the process exit code.
 */
export async function runSeedCommand(
  configPath: string,
  options: SeedCommandOptions = {},
  deps: SeedCommandDeps = defaultSeedCommandDeps,
): Promise<number> {
  const { registry, dataSource } = await deps.loadConfig(configPath);

  await dataSource.initialize();
  try {
    const ran = await runSeeders(registry, { dataSource, names: options.names });
    if (ran.length === 0) {
      deps.stdout('No seeders to run.');
    } else {
      for (const name of ran) {
        deps.stdout(`Seeded ${name}`);
      }
    }
  } finally {
    await dataSource.destroy();
  }
  return 0;
}

/** `jsails seed [--only <name>...]`. */
export const seedCommand: CommandModule<typeof SEED_OPTIONS, 'environment'> = {
  async run(context) {
    return runSeedCommand(
      await prepareConfigModule(context.cwd, context.values.config ?? DEFAULT_SEED_CONFIG_PATH),
      context.values.only === undefined ? {} : { names: context.values.only },
    );
  },
};
