/**
 * `jsails test` — transactional database testing (Laravel/Rails ergonomics).
 *
 * One command boots the services (`jamal up`), isolates a `*_test` database via
 * the `DATABASE_NAME` environment convention, reconciles the schema, and runs
 * `node --test` under `NODE_ENV=test`. Test files opt into per-test rollback
 * isolation with `withTestTransaction` (see `jsails/testing`) — the
 * `DatabaseTransactions` pattern — so each test's rows are discarded afterward.
 *
 * The reconcile is destructive by design (a test schema follows the models
 * exactly), so the command refuses to run it against any database whose name
 * does not look like a test database. When the configured database is not one
 * already, the config module is re-evaluated with `DATABASE_NAME` set to
 * `<database>_test` and the resulting data source must carry exactly that name;
 * only `--allow-non-test-database` overrides the guard.
 */

import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { basename } from 'node:path';

import { loadDataSourceConfig } from '../config-loader.js';
import { discoverPluginSchemaEntities } from './db.js';
import { reconcileDataSource } from '../../migrations/reconciler.js';
import { executeSchemaPlan } from '../../migrations/schema-executor.js';
import { formatError } from '../../errors/inspect.js';
import { DEFAULT_DATABASE_CONFIG_PATH } from '../../config-modules.js';
import type { JsailsDataSource } from '../../database/data-source.js';

/** Parsed `jsails test` values. */
interface TestValues {
  readonly config?: string;
  /** App config used to discover plugin-owned schema, as `db:push` does. */
  readonly appConfig?: string;
  readonly noServices: boolean;
  readonly watch: boolean;
  readonly testFile?: string;
  /** Reconcile even when the database name does not look like a test database. */
  readonly allowNonTestDatabase?: boolean;
}

/** Options the command passes to the data-source loader seam. */
export interface TestDataSourceLoadOptions {
  /** Re-evaluate the config module so it reads the current environment. */
  readonly fresh: boolean;
}

/** Options the command passes to the reconcile seam. */
export interface TestReconcileOptions {
  readonly appConfigPath?: string;
}

/** Dependency seam so boot/run are testable without Docker/Node. */
export interface TestCommandDeps {
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly env: Record<string, string | undefined>;
  readonly runServices: (cwd: string) => Promise<number>;
  /** Load the data source by config path; injectable for tests. */
  readonly loadDataSource: (
    configPath: string,
    options: TestDataSourceLoadOptions,
  ) => Promise<TestDataSource>;
  /** Initialize + reconcile the test data source; injectable for tests. */
  readonly reconcileDataSource: (
    dataSource: TestDataSource,
    options: TestReconcileOptions,
  ) => Promise<void>;
  readonly runTests: (
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => Promise<number>;
}

/**
 * The data source the command loads. The default seam returns a real
 * `JsailsDataSource`; tests inject a minimal fake via `as TestDataSource`.
 */
export type TestDataSource = JsailsDataSource;

/**
 * Map a child's exit to a process exit code. A signal death is never success:
 * it maps to the shell convention `128 + signal number` (or 1 when unknown).
 */
export function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) {
    const number = osConstants.signals[signal] as number | undefined;
    return number === undefined ? 1 : 128 + number;
  }
  return 1;
}

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * Run `command args` with inherited stdio and resolve with its exit code. A
 * SIGINT/SIGTERM to this process is forwarded to the child and this process
 * waits for it to exit, so the test run is never orphaned and its own exit
 * status is reported. The child stays in the terminal's process group (not
 * detached) so an interactive `--watch` run keeps its TTY. A spawn failure
 * resolves 1 rather than hanging.
 */
export function runChildProcess(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<number> {
  return new Promise<number>((resolveDone) => {
    const listeners: Array<[NodeJS.Signals, () => void]> = [];
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      for (const [signal, listener] of listeners) process.removeListener(signal, listener);
      resolveDone(code);
    };
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, ...env },
      shell: false,
    });
    child.once('error', () => settle(1));
    child.once('exit', (code, signal) => settle(childExitCode(code, signal)));
    for (const signal of FORWARDED_SIGNALS) {
      const listener = (): void => {
        child.kill(signal);
      };
      process.on(signal, listener);
      listeners.push([signal, listener]);
    }
  });
}

/**
 * Bring the test database schema in line with the app's models and its
 * enabled plugins' `schema.entities` (as `db:push` does), destructively: a
 * test schema follows the models exactly. Expects a data source that is not
 * initialized yet, because plugin entities can only be added before connecting.
 */
export async function reconcileTestDatabase(
  dataSource: TestDataSource,
  options: TestReconcileOptions,
): Promise<void> {
  dataSource.addEntities(await discoverPluginSchemaEntities(options.appConfigPath));
  const plan = await reconcileDataSource(dataSource, { allowDestructive: true });
  // `reconcileDataSource` initializes through `getLiveSchema`; a second
  // `initialize()` would throw CannotConnectAlreadyConnectedError.
  if (!dataSource.isInitialized) await dataSource.initialize();
  if (!plan.upToDate) await executeSchemaPlan(dataSource, plan.operations);
}

/** Default seam: boot via `jamal up`, run the real `node --test` child. */
const defaultTestCommandDeps: TestCommandDeps = {
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  runServices: async () => {
    const { runJamalCommand } = await import('../../jamal/command.js');
    return runJamalCommand(['up', '--detach']);
  },
  loadDataSource: (configPath, options) => loadDataSourceConfig(configPath, options),
  reconcileDataSource: reconcileTestDatabase,
  runTests: (args, env) => runChildProcess(process.execPath, ['--test', ...args], env),
};

const TEST_ENV_DB_NAME = 'DATABASE_NAME';

/**
 * Derive the `*_test` database name from the configured database. The
 * development database is never used by `jsails test`.
 */
export function deriveTestDatabaseName(database: string): string {
  return database === '' ? 'test' : `${database}_test`;
}

const SQLITE_EXTENSION = /\.(sqlite3?|db3?)$/i;

/**
 * Whether a database name (or SQLite file path) looks like a dedicated test
 * database: its stem is `test`/`tests`/`testing`, or ends with one of those
 * after a `_`, `-`, or `.` separator (the derived `<database>_test` shape).
 * A leading `test` segment is not enough: `DATABASE_NAME` is free text, and a
 * development database named `test_shop` must never get the destructive
 * reconcile.
 */
export function looksLikeTestDatabase(name: string): boolean {
  // Only a SQLite file extension is stripped: a server database name such as
  // `tests.app` has no extension, and treating `.app` as one would accept it.
  const stem = basename(name).replace(SQLITE_EXTENSION, '');
  return /^test(s|ing)?$/i.test(stem) || /[_.-]test(s|ing)?$/i.test(stem);
}

/** The name that identifies which database a data source points at. */
function databaseIdentity(dataSource: TestDataSource): string | undefined {
  const options = dataSource.options as { database?: unknown; location?: unknown; type?: unknown };
  if (options.type === 'sqljs') {
    return typeof options.location === 'string' ? options.location : undefined;
  }
  return typeof options.database === 'string' ? options.database : undefined;
}

type TestTarget =
  | { readonly ok: true; readonly dataSource: TestDataSource; readonly database: string }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve the data source to reconcile. A configured database that already
 * looks like a test database (for example `DATABASE_NAME=app_test` from
 * `.env.testing`) is used as is; otherwise the config is re-evaluated with the
 * derived `*_test` name, and the result must actually carry that name.
 */
async function resolveTestTarget(
  configPath: string,
  values: TestValues,
  deps: TestCommandDeps,
): Promise<TestTarget> {
  const allowAny = values.allowNonTestDatabase === true;
  const configured = await deps.loadDataSource(configPath, { fresh: false });
  const configuredName = databaseIdentity(configured);
  if (configuredName !== undefined && looksLikeTestDatabase(configuredName)) {
    return { ok: true, dataSource: configured, database: configuredName };
  }
  if (configured.options.type === 'sqljs') {
    if (allowAny && configuredName !== undefined) {
      return { ok: true, dataSource: configured, database: configuredName };
    }
    return {
      ok: false,
      message:
        'the SQLite location is not a test database (its file name must contain a "test" ' +
        'segment, e.g. storage/app_test.sqlite); pass --allow-non-test-database to override',
    };
  }

  const testDatabase = deriveTestDatabaseName(configuredName ?? 'jsails');
  deps.env[TEST_ENV_DB_NAME] = testDatabase;
  const reloaded = await deps.loadDataSource(configPath, { fresh: true });
  const reloadedName = databaseIdentity(reloaded);
  if (reloadedName === testDatabase) {
    return { ok: true, dataSource: reloaded, database: testDatabase };
  }
  if (allowAny && reloadedName !== undefined) {
    return { ok: true, dataSource: reloaded, database: reloadedName };
  }
  return {
    ok: false,
    message:
      `the database config did not select the test database when ${TEST_ENV_DB_NAME} was ` +
      `set (read it with readDatabaseEnvironment, or set ${TEST_ENV_DB_NAME} to a *_test ` +
      'name in .env.testing); refusing to reconcile a non-test database. Pass ' +
      '--allow-non-test-database to override',
  };
}

/**
 * Run `jsails test`. Returns the process exit code for `node --test`.
 */
export async function runTestCommand(
  values: TestValues,
  deps: TestCommandDeps = defaultTestCommandDeps,
): Promise<number> {
  const configPath = values.config ?? DEFAULT_DATABASE_CONFIG_PATH;

  // 1. Boot services (MariaDB/Valkey) unless the caller opts out.
  if (!values.noServices) {
    deps.stdout('Starting services (jamal up)…');
    const code = await deps.runServices(deps.cwd);
    if (code !== 0) {
      deps.stderr('jsails: jamal up failed — is Docker running?');
      deps.stderr(
        'jsails: pass --no-services to skip service boot (the test DB must already exist).',
      );
      return 1;
    }
  }

  // 2. Resolve the test database; never reconcile anything else.
  let target: TestTarget;
  try {
    target = await resolveTestTarget(configPath, values, deps);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }
  if (!target.ok) {
    deps.stderr(`jsails: ${target.message}`);
    return 1;
  }
  const { dataSource, database } = target;
  if (!looksLikeTestDatabase(database)) {
    deps.stderr('jsails: warning: reconciling a database that does not look like a test database');
  }
  deps.stdout(`Test database: ${database}`);

  try {
    // 3. Initialize + reconcile the test database schema once.
    try {
      await deps.reconcileDataSource(dataSource, {
        ...(values.appConfig !== undefined ? { appConfigPath: values.appConfig } : {}),
      });
    } catch (error) {
      deps.stderr(`jsails: ${formatError(error)}`);
      return 1;
    }

    // 4. Run the suite, exposing the test connection to the child process.
    const childEnv: Record<string, string> = { NODE_ENV: 'test' };
    if (dataSource.options.type !== 'sqljs') childEnv[TEST_ENV_DB_NAME] = database;
    const args: string[] = [];
    if (values.watch) args.push('--watch');
    if (values.testFile !== undefined) args.push(values.testFile);

    return await deps.runTests(args, childEnv);
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}
