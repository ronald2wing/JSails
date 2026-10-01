/**
 * Tests for the `jsails test` command seam — proves the boot → `*_test` derive →
 * migrate → `node --test` ordering without Docker or a live database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { runCli } from '../spawn-cli.js';
import { loadDataSourceConfig } from '../../../src/cli/config-loader.js';
import { JamalForwardErrors, runJamal } from '../../../src/cli/jamal-forward.js';
import { JsailsDataSource } from '../../../src/database/data-source.js';
import {
  childExitCode,
  deriveTestDatabaseName,
  looksLikeTestDatabase,
  reconcileTestDatabase,
  runChildProcess,
  runTestCommand,
  type TestCommandDeps,
  type TestDataSource,
} from '../../../src/cli/commands/test.js';

function fakeDataSource(
  name: string,
  type = 'mariadb',
): TestDataSource & { destroyed: number; initialized: boolean } {
  // Only the options, isInitialized, and destroy() are exercised by the seam.
  const fake = {
    options: type === 'sqljs' ? { type, location: name } : { type, database: name },
    initialized: false,
    destroyed: 0,
    get isInitialized() {
      return fake.initialized;
    },
    destroy: async () => {
      fake.destroyed += 1;
      fake.initialized = false;
    },
  };
  return fake as unknown as TestDataSource & { destroyed: number; initialized: boolean };
}

interface Sink {
  out: string[];
  err: string[];
  state: {
    services: number;
    loads: { path: string; fresh: boolean }[];
    sources: ReturnType<typeof fakeDataSource>[];
    reconciles: { db: string; appConfigPath?: string }[];
    ran: { args: readonly string[]; env: Readonly<Record<string, string>> } | undefined;
  };
}

/**
 * `resolveName` models the config module: it receives the environment at load
 * time and returns the database name the config would select.
 */
function makeDeps(
  resolveName: (env: Record<string, string | undefined>, fresh: boolean) => string,
  type = 'mariadb',
): { deps: TestCommandDeps; sink: Sink } {
  const sink: Sink = {
    out: [],
    err: [],
    state: { services: 0, loads: [], sources: [], reconciles: [], ran: undefined },
  };
  const env: Record<string, string | undefined> = {};
  const deps: TestCommandDeps = {
    cwd: '/srv/app',
    stdout: (l) => sink.out.push(l),
    stderr: (l) => sink.err.push(l),
    env,
    runServices: async () => {
      sink.state.services += 1;
      return { kind: 'exited', code: 0 };
    },
    loadDataSource: async (path, options) => {
      sink.state.loads.push({ path, fresh: options.fresh });
      const source = fakeDataSource(resolveName(env, options.fresh), type);
      sink.state.sources.push(source);
      return source;
    },
    reconcileDataSource: async (dataSource, options) => {
      (dataSource as ReturnType<typeof fakeDataSource>).initialized = true;
      const opts = dataSource.options as { database?: unknown; location?: unknown };
      const db = opts.database ?? opts.location;
      sink.state.reconciles.push({
        db: typeof db === 'string' ? db : '',
        ...(options.appConfigPath !== undefined ? { appConfigPath: options.appConfigPath } : {}),
      });
    },
    runTests: async (args, childEnv) => {
      sink.state.ran = { args, env: childEnv };
      return 0;
    },
  };
  return { deps, sink };
}

/** A config that reads DATABASE_NAME only when freshly evaluated (ESM cache). */
const envReadingConfig =
  (dev: string) =>
  (env: Record<string, string | undefined>, fresh: boolean): string =>
    fresh ? (env.DATABASE_NAME ?? dev) : dev;

describe('deriveTestDatabaseName', () => {
  it('suffixes a database name with _test', () => {
    assert.equal(deriveTestDatabaseName('myapp'), 'myapp_test');
  });
  it('names an empty database "test"', () => {
    assert.equal(deriveTestDatabaseName(''), 'test');
  });
});

describe('looksLikeTestDatabase', () => {
  it('accepts test-shaped names and SQLite paths', () => {
    for (const name of [
      'app_test',
      'test',
      'testing',
      'app-testing',
      'shop.tests',
      '/srv/storage/app_test.sqlite',
      'storage/test.db',
    ]) {
      assert.equal(looksLikeTestDatabase(name), true, name);
    }
  });
  it('rejects development-shaped names', () => {
    for (const name of [
      'app',
      'contest',
      'app_dev',
      'attestation',
      '/srv/test/app.sqlite',
      // A leading test segment is free text, not a test database.
      'test_app',
      'test_shop',
      'testing-shop',
      'testing-crm',
      'tests.app',
    ]) {
      assert.equal(looksLikeTestDatabase(name), false, name);
    }
  });
});

describe('childExitCode', () => {
  it('passes a numeric exit code through', () => {
    assert.equal(childExitCode(0, null), 0);
    assert.equal(childExitCode(3, null), 3);
  });
  it('never reports a signal death as success', () => {
    assert.equal(childExitCode(null, 'SIGKILL'), 137);
    assert.equal(childExitCode(null, 'SIGTERM'), 143);
    assert.equal(childExitCode(null, null), 1);
  });
});

describe('runChildProcess', () => {
  // Windows ends a process that kills itself with exit code 1 and reports no
  // signal, so the 128 + signal convention cannot be observed there.
  it(
    'reports a child killed by a signal as a failure',
    { skip: process.platform === 'win32' && 'signal deaths are POSIX-only' },
    async () => {
      const code = await runChildProcess(
        process.execPath,
        ['-e', 'process.kill(process.pid, "SIGKILL")'],
        {},
      );
      assert.equal(code, 137);
    },
  );
  it('resolves 1 when the command cannot be spawned', async () => {
    const code = await runChildProcess(join(tmpdir(), 'jsails-missing-binary-xyz'), [], {});
    assert.equal(code, 1);
  });
  it('passes the exit status and environment through', async () => {
    const code = await runChildProcess(
      process.execPath,
      ['-e', 'process.exit(process.env.JSAILS_PROBE === "x" ? 4 : 9)'],
      { JSAILS_PROBE: 'x' },
    );
    assert.equal(code, 4);
  });
});

describe('runTestCommand', () => {
  it('boots services, re-evaluates the config for *_test, migrates, and runs tests', async () => {
    const { deps, sink } = makeDeps(envReadingConfig('shop'));
    const code = await runTestCommand(
      { noServices: false, watch: false, appConfig: 'custom.app.js' },
      deps,
    );

    assert.equal(code, 0);
    assert.equal(sink.state.services, 1);
    assert.deepEqual(
      sink.state.loads.map((load) => load.fresh),
      [false, true],
      'the second load must bypass the ESM cache',
    );
    assert.deepEqual(sink.state.reconciles, [{ db: 'shop_test', appConfigPath: 'custom.app.js' }]);
    assert.equal(sink.state.ran?.env.DATABASE_NAME, 'shop_test');
    assert.equal(sink.state.ran?.env.NODE_ENV, 'test');
    assert.equal(sink.state.sources[1]!.destroyed, 1, 'the reconciled source is closed');
  });

  it('uses a configured database that is already a test database as is', async () => {
    const { deps, sink } = makeDeps(() => 'shop_test');
    const code = await runTestCommand({ noServices: true, watch: false }, deps);
    assert.equal(code, 0);
    assert.equal(sink.state.loads.length, 1);
    assert.deepEqual(sink.state.reconciles, [{ db: 'shop_test' }]);
    assert.equal(sink.state.ran?.env.DATABASE_NAME, 'shop_test');
  });

  it('refuses to reconcile when the config ignores DATABASE_NAME', async () => {
    const { deps, sink } = makeDeps(() => 'shop');
    const code = await runTestCommand({ noServices: true, watch: false }, deps);
    assert.equal(code, 1);
    assert.equal(sink.state.reconciles.length, 0, 'the development database is never reconciled');
    assert.equal(sink.state.ran, undefined);
    assert.match(sink.err.join('\n'), /refusing to reconcile a non-test database/);
  });

  it('reconciles a non-test database only with --allow-non-test-database', async () => {
    const { deps, sink } = makeDeps(() => 'shop');
    const code = await runTestCommand(
      { noServices: true, watch: false, allowNonTestDatabase: true },
      deps,
    );
    assert.equal(code, 0);
    assert.deepEqual(sink.state.reconciles, [{ db: 'shop' }]);
    assert.match(sink.err.join('\n'), /warning/);
  });

  it('refuses a SQLite location that is not a test database', async () => {
    const { deps, sink } = makeDeps(() => '/srv/app/storage/app.sqlite', 'sqljs');
    const code = await runTestCommand({ noServices: true, watch: false }, deps);
    assert.equal(code, 1);
    assert.equal(sink.state.reconciles.length, 0);
  });

  it('closes the data source and reports failure when the run rejects', async () => {
    const { deps, sink } = makeDeps(() => 'shop_test');
    const failing: TestCommandDeps = {
      ...deps,
      runTests: async () => {
        throw new Error('spawn exploded');
      },
    };
    await assert.rejects(runTestCommand({ noServices: true, watch: false }, failing));
    assert.equal(sink.state.sources[0]!.destroyed, 1);
  });

  it('skips service boot with --no-services', async () => {
    const { deps, sink } = makeDeps(envReadingConfig('shop'));
    await runTestCommand({ noServices: true, watch: false }, deps);
    assert.equal(sink.state.services, 0);
  });

  it('forwards --watch and --test-file to the child', async () => {
    const { deps, sink } = makeDeps(envReadingConfig('shop'));
    await runTestCommand(
      { noServices: true, watch: true, testFile: 'dist/test/foo.test.js' },
      deps,
    );
    assert.ok(sink.state.ran?.args.includes('--watch'));
    assert.ok(sink.state.ran?.args.includes('dist/test/foo.test.js'));
  });
});

describe('runTestCommand service boot failures', () => {
  /** Run the command with `runServices` replaced; the sink records what happened after it. */
  async function bootWith(runServices: TestCommandDeps['runServices']) {
    const { deps, sink } = makeDeps(envReadingConfig('shop'));
    const code = await runTestCommand(
      { noServices: false, watch: false },
      { ...deps, runServices },
    );
    return { code, sink };
  }

  it('reports a missing @jsails/jamal once, with both ways forward, and exits 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsails-test-no-jamal-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"app","type":"module"}\n');
      // The default seam's resolution, against a project that lacks the package.
      const { code, sink } = await bootWith(() =>
        runJamal(['up', '--detach'], {
          cwd: dir,
          run: () => Promise.reject(new Error('must not run')),
        }),
      );
      assert.equal(code, 1);
      assert.deepEqual(sink.err, [
        'jsails: @jsails/jamal is not installed in this project\n' +
          '  hint: Install it: npm install @jsails/jamal, or pass --no-services when the ' +
          'services are already running',
      ]);
      assert.equal(sink.state.loads.length, 0, 'nothing is loaded after a failed boot');
      assert.equal(sink.state.ran, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints exactly one failure from the real CLI when @jsails/jamal is missing', async () => {
    // Through the compiled CLI and the default service seam, so the wiring
    // that once printed the install line and then a Docker guess is covered.
    // The temporary directory lies outside the monorepo, whose node_modules
    // links @jsails/jamal.
    const dir = mkdtempSync(join(tmpdir(), 'jsails-test-cli-no-jamal-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"app","type":"module"}\n');
      const result = await runCli(['test'], {
        cwd: dir,
        env: { ...process.env, NODE_ENV: 'test' },
      });
      assert.equal(result.status, 1);
      assert.equal(
        result.stderr,
        'jsails: @jsails/jamal is not installed in this project\n' +
          '  hint: Install it: npm install @jsails/jamal, or pass --no-services when the ' +
          'services are already running\n',
      );
      assert.equal(result.stdout, 'Starting services (jamal up)…\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names jamal up exit code once and exits with it, leaving the reason to jamal', async () => {
    for (const exit of [1, 3, 130]) {
      const { code, sink } = await bootWith(async () => ({ kind: 'exited', code: exit }));
      assert.equal(code, exit);
      assert.deepEqual(sink.err, [
        `jsails: jamal up exited with code ${exit}\n` +
          '  hint: pass --no-services when the services are already running',
      ]);
      assert.equal(sink.state.loads.length, 0);
    }
  });

  it('reports a jamal bin that could not start once, and exits 1', async () => {
    const { code, sink } = await bootWith(async () => ({
      kind: 'not_run',
      error: new JamalForwardErrors.Error('jamal_start_failed'),
    }));
    assert.equal(code, 1);
    assert.deepEqual(sink.err, [
      'jsails: could not start jamal\n' +
        '  hint: pass --no-services when the services are already running',
    ]);
    assert.equal(sink.state.loads.length, 0);
  });
});

describe('loadDataSourceConfig fresh evaluation', () => {
  it('re-evaluates a config that reads DATABASE_NAME at module top level', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsails-test-config-'));
    const previous = process.env.JSAILS_TEST_CONFIG_DB;
    try {
      mkdirSync(join(dir, 'storage'));
      const dataSourceUrl = new URL('../../../src/database/data-source.js', import.meta.url).href;
      // The starter's config shape: the database name is read once, at import.
      writeFileSync(
        join(dir, 'jsails.database.js'),
        `import { JsailsDataSource } from ${JSON.stringify(dataSourceUrl)};\n` +
          'export default new JsailsDataSource({ type: "mariadb", host: "127.0.0.1", ' +
          'username: "u", password: "p", database: process.env.JSAILS_TEST_CONFIG_DB, entities: [] });\n',
      );
      const config = join(dir, 'jsails.database.js');
      process.env.JSAILS_TEST_CONFIG_DB = 'app';
      const first = await loadDataSourceConfig(config);
      process.env.JSAILS_TEST_CONFIG_DB = 'app_test';
      const cached = await loadDataSourceConfig(config);
      const fresh = await loadDataSourceConfig(config, { fresh: true });
      assert.equal(first.options.database, 'app');
      assert.equal(cached, first, 'a plain import is the cached instance');
      assert.equal(fresh.options.database, 'app_test');
    } finally {
      if (previous === undefined) delete process.env.JSAILS_TEST_CONFIG_DB;
      else process.env.JSAILS_TEST_CONFIG_DB = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A plugin-owned table, declared only through the fixture plugin's `schema.entities`. */
@Entity({ name: 'reconcile_plugin_widgets' })
export class ReconcilePluginWidget {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text' })
  label!: string;
}

describe('reconcileTestDatabase', () => {
  it('migrates plugin schema once and leaves an up-to-date database alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsails-test-reconcile-'));
    const location = join(dir, 'app_test.sqlite');
    const pluginPath = join(dir, 'plugin.mjs');
    const appConfigPath = join(dir, 'jsails.app.js');
    // The plugin imports the entity from this test module, so both see one class.
    writeFileSync(
      pluginPath,
      `import { ReconcilePluginWidget } from ${JSON.stringify(import.meta.url)};\n` +
        'export default { name: "reconcile-fixture", setup() {}, ' +
        'schema: { entities: [ReconcilePluginWidget] } };\n',
    );
    writeFileSync(
      appConfigPath,
      `export default { plugins: { use: [${JSON.stringify(pathToFileURL(pluginPath).href)}] } };\n`,
    );
    const open = (): JsailsDataSource =>
      new JsailsDataSource({ type: 'sqljs', location, autoSave: true, entities: [] });
    try {
      const first = open();
      // Resolving at all proves no second initialize() after reconcile.
      await reconcileTestDatabase(first, { appConfigPath });
      assert.equal(first.isInitialized, true);
      await first.getRepository(ReconcilePluginWidget).save({ label: 'kept' });
      await first.destroy();

      // A second run against the migrated file must not recreate the table.
      const second = open();
      await reconcileTestDatabase(second, { appConfigPath });
      try {
        const rows = await second.getRepository(ReconcilePluginWidget).find();
        assert.deepEqual(
          rows.map((row) => row.label),
          ['kept'],
        );
      } finally {
        await second.destroy();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves tables a plugin or the database config declares unmanaged alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsails-test-unmanaged-'));
    const location = join(dir, 'app_test.sqlite');
    const pluginPath = join(dir, 'plugin.mjs');
    const appConfigPath = join(dir, 'jsails.app.js');
    const configPath = join(dir, 'jsails.database.js');
    writeFileSync(
      pluginPath,
      'export default { name: "owner-fixture", setup() {}, ' +
        'schema: { unmanagedTables: ["owned_user"] } };\n',
    );
    writeFileSync(
      appConfigPath,
      `export default { plugins: { use: [${JSON.stringify(pathToFileURL(pluginPath).href)}] } };\n`,
    );
    // Only the named export is read from the config module here.
    writeFileSync(configPath, "export const unmanagedTables = ['legacy_import'];\n");
    const open = (): JsailsDataSource =>
      new JsailsDataSource({ type: 'sqljs', location, autoSave: true, entities: [] });
    try {
      const seed = open();
      await seed.initialize();
      await seed.query('CREATE TABLE "owned_user" ("id" text PRIMARY KEY NOT NULL)');
      await seed.query('CREATE TABLE "legacy_import" ("id" text PRIMARY KEY NOT NULL)');
      await seed.query('INSERT INTO "owned_user" ("id") VALUES (\'u1\')');
      await seed.destroy();

      const target = open();
      await reconcileTestDatabase(target, { appConfigPath, configPath });
      try {
        const users = await target.query<{ id: string }[]>('SELECT "id" FROM "owned_user"');
        assert.deepEqual(
          users.map((row) => row.id),
          ['u1'],
        );
        const tables = await target.query<{ name: string }[]>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_import'",
        );
        assert.equal(tables.length, 1);
      } finally {
        await target.destroy();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
