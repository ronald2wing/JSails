/**
 * The config modules a project owns: their default paths and the guard that
 * rejects a TypeScript path before import.
 *
 * Dependency-free on purpose: the CLI bin resolves these before it decides
 * which command runs, and importing them from the modules that consume each
 * config would drag TypeORM or BullMQ into every `jsails --help`.
 *
 * The app config default (`jsails.app.js`) is `DEFAULT_APP_CONFIG_PATH` from
 * the app config schema, which owns that file's contract.
 */

/** The database module (`db:push`, `db:diff`, `console`, `test`, `plugins`). */
export const DEFAULT_DATABASE_CONFIG_PATH = 'jsails.database.js';

/** The jobs runtime module (`work`, `schedule`, `queue`, `schedules`, `console`). */
export const DEFAULT_RUNTIME_CONFIG_PATH = 'jsails.runtime.js';

/** The seeder module (`seed`). */
export const DEFAULT_SEED_CONFIG_PATH = 'jsails.seed.js';

/**
 * True for a TypeScript config module path (`.ts`, `.mts`, `.cts`). Such a path
 * is rejected before import so a source checkout fails with the compile-first
 * instruction instead of a loader error.
 */
export function isTypeScriptConfig(path: string): boolean {
  return /\.(?:ts|mts|cts)$/.test(path);
}
