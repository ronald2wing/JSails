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
 * `<database>_test` and the resulting data source must carry exactly that name.
 * The options are only what the config asked for: a connection `url` (or a
 * driver default) can select another database than `options.database`, so
 * once connected, and before anything is written, the server is asked which
 * database the connection is actually using, and that name must pass the same
 * test-name rule. Only `--allow-non-test-database` overrides the guard.
 */

import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { basename } from 'node:path';

import { loadDataSourceConfig } from '../config-loader.js';
import { planSchema, preparePluginSchema } from './db-schema.js';
import { executeSchemaPlan } from '../../migrations/schema-executor.js';
import { defineErrors, type ErrorRegistry } from '../../errors/registry.js';
import { DEFAULT_DATABASE_CONFIG_PATH } from '../../config-modules.js';
import type { CommandModule } from '../descriptor.js';
import type { TEST_OPTIONS } from '../manifest.js';
import { writeFailure } from '../report.js';
import { onProcessSignals } from '../shutdown.js';
import { installGlobals } from '../stages.js';
import type { JsailsDataSource } from '../../database/data-source.js';
import type { JamalRun } from '../jamal-forward.js';

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
  /** Database config whose `unmanagedTables` export the plan also leaves alone. */
  readonly configPath?: string;
  /** Skip the connected-database check (`--allow-non-test-database`). */
  readonly allowNonTestDatabase?: boolean;
}

const TEST_DATABASE_ERRORS = {
  unknown_database: {
    kind: 'internal',
    message: 'could not determine which database the connection uses; refusing to reconcile it',
    suggestion: 'Pass --allow-non-test-database to override',
  },
  non_test_database: {
    kind: 'internal',
    message:
      'the connection is not using a test database (a connection url may select a different database than DATABASE_NAME); refusing to reconcile it',
    suggestion: 'Pass --allow-non-test-database to override',
  },
} as const;

/**
 * `jsails test`'s database guard codes, `test_database.*`: the connection the
 * reconcile would run on is not a test database. The message never names the
 * database: it may come from a connection URL that carries credentials.
 */
export const TestDatabaseErrors: ErrorRegistry<'test_database', typeof TEST_DATABASE_ERRORS> =
  defineErrors('test_database', TEST_DATABASE_ERRORS);

/** Dependency seam so boot/run are testable without Docker/Node. */
export interface TestCommandDeps {
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly env: Record<string, string | undefined>;
  /** Boot the services with `jamal up --detach`; resolves what became of the run. */
  readonly runServices: (cwd: string) => Promise<JamalRun>;
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
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, ...env },
      shell: false,
    });
    const detachSignals = onProcessSignals(FORWARDED_SIGNALS, (signal) => {
      child.kill(signal);
    });
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      detachSignals();
      resolveDone(code);
    };
    child.once('error', () => settle(1));
    child.once('exit', (code, signal) => settle(childExitCode(code, signal)));
  });
}

/**
 * Bring the test database schema in line with the app's models and its
 * enabled plugins' `schema.entities` (as `db:push` does), destructively: a
 * test schema follows the models exactly. Tables a plugin or the database
 * config declares unmanaged are left alone, as `db:push` leaves them. Expects a
 * data source that is not initialized yet, because plugin entities can only be
 * added before connecting.
 */
export async function reconcileTestDatabase(
  dataSource: TestDataSource,
  options: TestReconcileOptions,
): Promise<void> {
  const unmanagedTables = await preparePluginSchema(dataSource, options);
  // Connect before planning so the connection is checked before anything
  // reads or writes through it; `getLiveSchema` reuses an open connection.
  if (!dataSource.isInitialized) await dataSource.initialize();
  if (options.allowNonTestDatabase !== true) await assertConnectedToTestDatabase(dataSource);
  const plan = await planSchema(dataSource, unmanagedTables);
  if (!plan.upToDate) await executeSchemaPlan(dataSource, plan.operations);
}

/** The data-source surface {@link connectedDatabaseName} reads. */
export interface ConnectedDataSource {
  readonly options: { readonly type: string };
  readonly driver: { readonly options: object };
  query(sql: string): Promise<unknown>;
}

/**
 * The name of the database an initialized data source is connected to, as the
 * server reports it (not as the options request it), or `undefined` when the
 * server reports none. For the file-backed SQLite driver it is the file the
 * driver loaded, which no URL can redirect.
 */
export async function connectedDatabaseName(
  dataSource: ConnectedDataSource,
): Promise<string | undefined> {
  const type = dataSource.options.type;
  if (type === 'sqljs') {
    const location = (dataSource.driver.options as { location?: unknown }).location;
    return typeof location === 'string' && location.length > 0 ? location : undefined;
  }
  const sql =
    type === 'postgres'
      ? 'SELECT current_database() AS name'
      : type === 'mysql' || type === 'mariadb'
        ? 'SELECT DATABASE() AS name'
        : undefined;
  if (sql === undefined) return undefined;
  const rows = await dataSource.query(sql);
  const first: unknown = Array.isArray(rows) ? rows[0] : undefined;
  const name =
    first !== null && typeof first === 'object' ? (first as { name?: unknown }).name : undefined;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * Refuse a connection whose actual database does not look like a test
 * database. Run after connecting and before the destructive reconcile.
 */
export async function assertConnectedToTestDatabase(
  dataSource: ConnectedDataSource,
): Promise<void> {
  const name = await connectedDatabaseName(dataSource);
  if (name === undefined) {
    throw new TestDatabaseErrors.Error('unknown_database');
  }
  if (!looksLikeTestDatabase(name)) {
    throw new TestDatabaseErrors.Error('non_test_database');
  }
}

/** Default seam: boot via `jamal up`, run the real `node --test` child. */
const defaultTestCommandDeps: TestCommandDeps = {
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  runServices: async (cwd) => {
    const { runJamal, runNodeBin } = await import('../jamal-forward.js');
    return runJamal(['up', '--detach'], { cwd, run: runNodeBin });
  },
  loadDataSource: (configPath, options) => loadDataSourceConfig(configPath, options),
  reconcileDataSource: reconcileTestDatabase,
  runTests: (args, env) => runChildProcess(process.execPath, ['--test', ...args], env),
};

const TEST_ENV_DB_NAME = 'DATABASE_NAME';

const NO_SERVICES_HINT = 'pass --no-services when the services are already running';

/**
 * The one report for a service boot that did not succeed, or `undefined` when
 * it did. When jamal ran it already printed why it failed on the inherited
 * stderr, so the report only names the exit and keeps that exit code (a
 * Ctrl-C stays 130). When jamal never ran, the report is the reason, with the
 * fix extended by the way to run without it.
 */
function servicesFailure(
  run: JamalRun,
): { readonly message: string; readonly exitCode: number } | undefined {
  if (run.kind === 'exited') {
    if (run.code === 0) return undefined;
    return {
      message: `jsails: jamal up exited with code ${run.code}\n  hint: ${NO_SERVICES_HINT}`,
      exitCode: run.code,
    };
  }
  const { message, suggestion } = run.error;
  const hint =
    suggestion === undefined ? NO_SERVICES_HINT : `${suggestion}, or ${NO_SERVICES_HINT}`;
  return { message: `jsails: ${message}\n  hint: ${hint}`, exitCode: 1 };
}

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
 * `.env.test`) is used as is; otherwise the config is re-evaluated with the
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
      'name in .env.test); refusing to reconcile a non-test database. Pass ' +
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

  // The suite runs as the test environment (.env, .env.test, its sealed
  // credentials), and the bin resolved this process's environment before the
  // command ran: `test` unless JSAILS_ENV or --env named another. Under
  // another the guard would vet the database that environment selects while
  // the tests write to the one test selects, so the two must be the same.
  const nodeEnv = deps.env.NODE_ENV;
  if (nodeEnv !== undefined && nodeEnv !== 'test') {
    deps.stderr(
      'jsails: jsails test runs as JSAILS_ENV=test (NODE_ENV=test), but another ' +
        'environment is selected; unset JSAILS_ENV or set it to test',
    );
    return 1;
  }

  // 1. Boot services (MariaDB/Valkey) unless the caller opts out.
  if (!values.noServices) {
    deps.stdout('Starting services (jamal up)…');
    const services = await deps.runServices(deps.cwd);
    const failure = servicesFailure(services);
    if (failure !== undefined) {
      deps.stderr(failure.message);
      return failure.exitCode;
    }
  }

  // 2. Resolve the test database; never reconcile anything else.
  let target: TestTarget;
  try {
    target = await resolveTestTarget(configPath, values, deps);
  } catch (error) {
    await writeFailure(error, (line) => deps.stderr(line), { env: deps.env });
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
        configPath,
        allowNonTestDatabase: values.allowNonTestDatabase === true,
        ...(values.appConfig !== undefined ? { appConfigPath: values.appConfig } : {}),
      });
    } catch (error) {
      await writeFailure(error, (line) => deps.stderr(line), { env: deps.env });
      return 1;
    }

    // 4. Run the suite, exposing the test connection to the child process.
    const childEnv: Record<string, string> = { JSAILS_ENV: 'test', NODE_ENV: 'test' };
    if (dataSource.options.type !== 'sqljs') childEnv[TEST_ENV_DB_NAME] = database;
    const args: string[] = [];
    if (values.watch) args.push('--watch');
    if (values.testFile !== undefined) args.push(values.testFile);

    return await deps.runTests(args, childEnv);
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

/** `jsails test`. */
export const testCommand: CommandModule<typeof TEST_OPTIONS, 'environment'> = {
  async run(context) {
    const { values } = context;
    // The test runner loads the app config and reconciles the test database;
    // both may reference framework globals by bare name.
    await installGlobals(context.cwd);
    return runTestCommand({
      ...(values.config === undefined ? {} : { config: values.config }),
      ...(values['app-config'] === undefined ? {} : { appConfig: values['app-config'] }),
      noServices: values['no-services'] === true,
      watch: values.watch === true,
      ...(values['test-file'] === undefined ? {} : { testFile: values['test-file'] }),
      allowNonTestDatabase: values['allow-non-test-database'] === true,
    });
  },
};
