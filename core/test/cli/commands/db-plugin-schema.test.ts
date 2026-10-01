/**
 * Tests for `db:push`/`db:diff` schema discovery from enabled plugins'
 * `schema.entities` and `schema.unmanagedTables` and a `definePlugin`
 * instance's lazy `schema` contribution, without calling plugin `setup`, and
 * for the config module's `unmanagedTables` export. The plugins are the
 * kernel's plugin graph in safe mode: a managed app contributes the plugins
 * its config declares and nothing else, and legacy `extensions` contribute as
 * `plugins.use` does. With every
 * first-party plugin in `plugins.use`, `db:push` creates each declared table
 * on an empty database.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { runDbDiff, runDbPush } from '../../../src/cli/commands/db.js';
import { MigrationError } from '../../../src/migrations/schema-types.js';
import { PluginErrors } from '../../../src/plugins/contract/errors.js';
import { bundleManifestJson } from '../../plugins/manifest-fixture.js';

/** The environment the in-process commands run in. */
const COMMAND_ENV = { JSAILS_ENV: 'test', NODE_ENV: 'test' } as const;

const fixtureRoot = mkdtempSync(
  join(fileURLToPath(new URL('../..', import.meta.url)), 'schema-plugin-'),
);

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

interface SqlDatabase {
  exec(sql: string): { values: unknown[][] }[];
  export(): Uint8Array;
  close(): void;
}

type SqlDatabaseConstructor = new (data?: Uint8Array) => SqlDatabase;

async function loadSqlJs(): Promise<SqlDatabaseConstructor> {
  const require = createRequire(import.meta.url);
  const initSqlJs = require('sql.js') as (config?: unknown) => Promise<unknown>;
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = (await initSqlJs({ locateFile: () => wasmPath })) as {
    Database: SqlDatabaseConstructor;
  };
  return SQL.Database;
}

/**
 * Create a live table the declared models do not know, as another migrator
 * would. The default string primary key, like Better Auth's, does not fit the
 * portable model, so introspecting it at all would fail.
 */
async function seedForeignTable(
  dbPath: string,
  name: string,
  idColumn = '"id" varchar(36) PRIMARY KEY NOT NULL',
): Promise<void> {
  const Database = await loadSqlJs();
  const db = new Database();
  try {
    db.exec(`CREATE TABLE "${name}" (${idColumn}, "email" varchar(255))`);
    writeFileSync(dbPath, db.export());
  } finally {
    db.close();
  }
}

async function readTables(dbPath: string): Promise<string[]> {
  if (!existsSync(dbPath)) return [];
  const Database = await loadSqlJs();
  const db = new Database(readFileSync(dbPath));
  try {
    return (
      db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0]?.values ?? []
    ).map((row) => String(row[0]));
  } finally {
    db.close();
  }
}

function writeFixture(name: string): {
  dir: string;
  configPath: string;
  appConfigPath: string;
  dbPath: string;
} {
  const dir = mkdtempSync(join(fixtureRoot, `${name}-`));
  const dbPath = join(dir, 'data.db');
  const dataSourceModule = fileURLToPath(
    new URL('../../../src/database/data-source.js', import.meta.url),
  );
  const tenancyModule = fileURLToPath(
    new URL('../../../../../packages/tenancy/dist/src/index.js', import.meta.url),
  );
  const pluginPath = join(dir, 'plugin.mjs');
  const appConfigPath = join(dir, 'jsails.app.js');
  const configPath = join(dir, 'jsails.database.js');

  writeFileSync(
    pluginPath,
    `import { tenancyPlugin } from ${JSON.stringify(pathToFileURL(tenancyModule).href)};\nexport default (options) => tenancyPlugin(options);\n`,
  );
  writeFileSync(
    appConfigPath,
    `export default { plugins: { use: [[${JSON.stringify(pathToFileURL(pluginPath).href)}, { resolveTenant: () => null }]] } };\n`,
  );
  writeFileSync(
    configPath,
    `import { JsailsDataSource } from ${JSON.stringify(pathToFileURL(dataSourceModule).href)};\nexport default new JsailsDataSource({ type: 'sqljs', location: ${JSON.stringify(dbPath)}, entities: [] });\n`,
  );
  return { dir, configPath, appConfigPath, dbPath };
}

describe('schema discovery from enabled plugins', () => {
  it('creates plugin-owned tables without listing entities', async () => {
    const fixture = writeFixture('enabled');
    const code = await runDbPush(
      fixture.configPath,
      {
        dryRun: false,
        allowDestructive: false,
        appConfigPath: fixture.appConfigPath,
      },
      COMMAND_ENV,
    );
    assert.equal(code, 0);
    const tables = await readTables(fixture.dbPath);
    assert.ok(tables.includes('jsails_tenants'));
    assert.ok(tables.includes('jsails_tenant_memberships'));
  });

  it('creates no plugin tables when the plugin is not enabled', async () => {
    const fixture = writeFixture('disabled');
    const appConfigPath = join(fixture.dir, 'empty.app.js');
    writeFileSync(appConfigPath, 'export default {};\n');
    const code = await runDbPush(
      fixture.configPath,
      {
        dryRun: false,
        allowDestructive: false,
        appConfigPath,
      },
      COMMAND_ENV,
    );
    assert.equal(code, 0);
    const tables = await readTables(fixture.dbPath);
    assert.equal(tables.includes('jsails_tenants'), false);
    assert.equal(tables.includes('jsails_tenant_memberships'), false);
  });
});

describe('schema contributions of definePlugin instances', () => {
  /**
   * An app config enabling one kernel plugin whose lazy `schema` module
   * default-exports `contribution` (source text over `tenancyEntities`), and
   * whose setup throws, so a test proves the commands never run it.
   */
  function writeKernelPluginApp(dir: string, contribution: string): string {
    const kernelModule = fileURLToPath(new URL('../../../src/kernel/index.js', import.meta.url));
    const tenancyModule = fileURLToPath(
      new URL('../../../../../packages/tenancy/dist/src/index.js', import.meta.url),
    );
    const schemaPath = join(dir, 'owner-schema.mjs');
    writeFileSync(
      schemaPath,
      `import { tenancyEntities } from ${JSON.stringify(pathToFileURL(tenancyModule).href)};\nexport default ${contribution};\n`,
    );
    const pluginPath = join(dir, 'owner-plugin.mjs');
    writeFileSync(
      pluginPath,
      [
        `import { definePlugin, lazy } from ${JSON.stringify(pathToFileURL(kernelModule).href)};`,
        'export default definePlugin({',
        "  name: 'owner',",
        `  schema: lazy(() => import(${JSON.stringify(pathToFileURL(schemaPath).href)})),`,
        "  setup() { throw new Error('setup ran'); },",
        '});',
        '',
      ].join('\n'),
    );
    const appConfigPath = join(dir, 'kernel.app.js');
    writeFileSync(
      appConfigPath,
      `export default { plugins: { use: [${JSON.stringify(pathToFileURL(pluginPath).href)}] } };\n`,
    );
    return appConfigPath;
  }

  it('creates the tables of the models a plugin contributes', async () => {
    const fixture = writeFixture('kernel-models');
    const appConfigPath = writeKernelPluginApp(fixture.dir, '{ models: tenancyEntities }');
    const code = await runDbPush(
      fixture.configPath,
      {
        dryRun: false,
        allowDestructive: false,
        appConfigPath,
      },
      COMMAND_ENV,
    );
    assert.equal(code, 0);
    const tables = await readTables(fixture.dbPath);
    assert.ok(tables.includes('jsails_tenants'));
    assert.ok(tables.includes('jsails_tenant_memberships'));
    assert.equal(await runDbDiff(fixture.configPath, { appConfigPath }, COMMAND_ENV), 0);
  });

  it('refuses table specs and data migrations it cannot apply yet', async () => {
    for (const [part, contribution] of [
      ['tables', "{ models: tenancyEntities, tables: [{ name: 'owner_rows' }] }"],
      ['dataMigrations', "{ dataMigrations: [{ name: 'backfill' }] }"],
    ] as const) {
      const fixture = writeFixture(`kernel-${part}`);
      const appConfigPath = writeKernelPluginApp(fixture.dir, contribution);
      for (const run of [
        () =>
          runDbPush(
            fixture.configPath,
            { dryRun: true, allowDestructive: false, appConfigPath },
            COMMAND_ENV,
          ),
        () => runDbDiff(fixture.configPath, { appConfigPath }, COMMAND_ENV),
      ]) {
        await assert.rejects(
          run(),
          (error: unknown) =>
            PluginErrors.is(error, 'unsupported_contribution') &&
            error.context['plugin'] === 'owner' &&
            error.context['part'] === part,
        );
      }
      assert.deepEqual(await readTables(fixture.dbPath), []);
    }
  });
});

describe('unmanaged tables', () => {
  /** An app config enabling one plugin that declares `schema` inline. */
  function writePluginApp(dir: string, schemaSource: string): string {
    const pluginPath = join(dir, 'owner-plugin.mjs');
    writeFileSync(
      pluginPath,
      `export default () => ({ name: 'owner', schema: ${schemaSource}, setup() {} });\n`,
    );
    const appConfigPath = join(dir, 'owner.app.js');
    writeFileSync(
      appConfigPath,
      `export default { plugins: { use: [${JSON.stringify(pathToFileURL(pluginPath).href)}] } };\n`,
    );
    return appConfigPath;
  }

  it('leaves a plugin-declared unmanaged table alone', async () => {
    const fixture = writeFixture('plugin-unmanaged');
    await seedForeignTable(fixture.dbPath, 'owned_user');
    const appConfigPath = writePluginApp(fixture.dir, "{ unmanagedTables: ['owned_user'] }");
    const diffCode = await runDbDiff(fixture.configPath, { appConfigPath }, COMMAND_ENV);
    assert.equal(diffCode, 0);
    const code = await runDbPush(
      fixture.configPath,
      {
        dryRun: false,
        allowDestructive: false,
        appConfigPath,
      },
      COMMAND_ENV,
    );
    assert.equal(code, 0);
    assert.ok((await readTables(fixture.dbPath)).includes('owned_user'));
  });

  it('refuses the push as destructive when nothing declares the table', async () => {
    const fixture = writeFixture('undeclared');
    await seedForeignTable(fixture.dbPath, 'owned_user', '"id" integer PRIMARY KEY NOT NULL');
    const appConfigPath = writePluginApp(fixture.dir, '{}');
    const code = await runDbPush(
      fixture.configPath,
      {
        dryRun: true,
        allowDestructive: false,
        appConfigPath,
      },
      COMMAND_ENV,
    );
    assert.equal(code, 1);
  });

  it('reads the config module unmanagedTables export', async () => {
    const fixture = writeFixture('config-unmanaged');
    await seedForeignTable(fixture.dbPath, 'legacy_import');
    writeFileSync(
      fixture.configPath,
      `${readFileSync(fixture.configPath, 'utf8')}export const unmanagedTables = ['legacy_import'];\n`,
    );
    const appConfigPath = writePluginApp(fixture.dir, '{}');
    const code = await runDbPush(
      fixture.configPath,
      {
        dryRun: false,
        allowDestructive: false,
        appConfigPath,
      },
      COMMAND_ENV,
    );
    assert.equal(code, 0);
    assert.ok((await readTables(fixture.dbPath)).includes('legacy_import'));
  });

  it('rejects a malformed config module unmanagedTables export', async () => {
    const fixture = writeFixture('config-invalid');
    writeFileSync(
      fixture.configPath,
      `${readFileSync(fixture.configPath, 'utf8')}export const unmanagedTables = 'legacy_import';\n`,
    );
    const appConfigPath = writePluginApp(fixture.dir, '{}');
    await assert.rejects(
      runDbPush(
        fixture.configPath,
        { dryRun: true, allowDestructive: false, appConfigPath },
        COMMAND_ENV,
      ),
      (error) => error instanceof MigrationError && error.code === 'invalid_config',
    );
  });

  it('refuses a table declared as a plugin entity and as unmanaged', async () => {
    const fixture = writeFixture('collision');
    // The tenancy plugin owns jsails_tenants as an entity; a second plugin
    // claiming the same name as unmanaged must fail, not split ownership.
    const ownerPath = join(fixture.dir, 'owner-plugin.mjs');
    writeFileSync(
      ownerPath,
      "export default () => ({ name: 'owner', schema: { unmanagedTables: ['jsails_tenants'] }, setup() {} });\n",
    );
    const appConfig = readFileSync(fixture.appConfigPath, 'utf8').replace(
      ']] } };',
      `], ${JSON.stringify(pathToFileURL(ownerPath).href)}] } };`,
    );
    writeFileSync(fixture.appConfigPath, appConfig);
    await assert.rejects(
      runDbPush(
        fixture.configPath,
        {
          dryRun: true,
          allowDestructive: false,
          appConfigPath: fixture.appConfigPath,
        },
        COMMAND_ENV,
      ),
      (error) => error instanceof MigrationError && error.code === 'invalid_options',
    );
  });
});

describe('schema discovery reads the config, never plugin state', () => {
  it('pushes a managed app in safe mode: a bundle on disk is never imported', async () => {
    const fixture = writeFixture('managed-safe');
    const versionDir = join(fixture.dir, 'storage', 'plugins', 'state-plugin', '1.0.0');
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(
      join(versionDir, 'manifest.json'),
      `${JSON.stringify(
        bundleManifestJson({
          id: 'state-plugin',
          version: '1.0.0',
          jsailsCompat: '^0.1.0',
          entry: './index.mjs',
        }),
      )}\n`,
    );
    writeFileSync(
      join(versionDir, 'index.mjs'),
      "globalThis.__dbSchemaBundleImported = true;\nexport default { name: 'state-plugin', setup() {} };\n",
    );
    const appConfigPath = join(fixture.dir, 'managed.app.js');
    writeFileSync(
      appConfigPath,
      [
        'export default {',
        '  plugins: {',
        "    activation: { mode: 'managed' },",
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    const code = await runDbPush(
      fixture.configPath,
      {
        dryRun: false,
        allowDestructive: false,
        appConfigPath,
      },
      COMMAND_ENV,
    );
    assert.equal(code, 0);
    const probe = globalThis as { __dbSchemaBundleImported?: true };
    assert.equal(probe.__dbSchemaBundleImported, undefined);
  });

  it('collects the schema of legacy extensions as well as plugins.use', async () => {
    const fixture = writeFixture('extensions');
    const tenancyModule = fileURLToPath(
      new URL('../../../../../packages/tenancy/dist/src/index.js', import.meta.url),
    );
    const appConfigPath = join(fixture.dir, 'extensions.app.js');
    writeFileSync(
      appConfigPath,
      `import { tenancyPlugin } from ${JSON.stringify(pathToFileURL(tenancyModule).href)};\nexport default { extensions: [tenancyPlugin({ resolveTenant: () => null })] };\n`,
    );
    const code = await runDbPush(
      fixture.configPath,
      {
        dryRun: false,
        allowDestructive: false,
        appConfigPath,
      },
      COMMAND_ENV,
    );
    assert.equal(code, 0);
    assert.ok((await readTables(fixture.dbPath)).includes('jsails_tenants'));
  });
});

describe('db:push with every first-party plugin in plugins.use', () => {
  const packagesRoot = fileURLToPath(new URL('../../../../../packages/', import.meta.url));
  const coreDist = fileURLToPath(new URL('../../../src/', import.meta.url));

  /**
   * How each first-party plugin is constructed: a module body over `m` (the
   * package's built entry), `dep(name)` (another package's) and `core(path)`
   * (a built core module). The set must equal the packages that ship a
   * manifest, so a new first-party plugin fails here until it is added.
   */
  const CONSTRUCT: Readonly<Record<string, string>> = {
    admin:
      "m.adminPlugin(m.defineAdminPanel({ auth: (await dep('auth')).authSessionToken, authorize: () => false, adminPlugins: [] }))",
    auth: 'm.authPlugin()',
    blog: 'm.blogPlugin()',
    cache: "m.cachePlugin({ store: 'memory' })",
    config:
      "m.configPlugin({ sets: [m.defineConfig('test.site', { fields: { title: m.text({ default: 'x' }) } })] })",
    diagnostics: 'm.diagnosticsPlugin()',
    filesystem: "m.filesystemPlugin({ disks: { memory: { driver: 'memory' } } })",
    flags: 'm.flagsPlugin()',
    live: "m.livePlugin({ registry: (await core('live/index.js')).createPublicationRegistry(), allowedOrigins: ['http://localhost'] })",
    logging: 'm.loggingPlugin()',
    mail: 'm.mailPlugin({ allowMemory: true })',
    notifications: 'm.notificationsPlugin({ mail: true })',
    tenancy: 'm.tenancyPlugin({ resolveTenant: () => null })',
    theme: 'm.themePlugin()',
    webhook:
      "m.webhookPlugin({ endpoints: [{ id: 'hook', path: '/webhooks/hook', secret: 'test-only-signing-secret', onEvent() {} }] })",
  };

  /** The first-party packages that ship a manifest, with their declared table prefix. */
  function firstParty(): readonly { readonly dir: string; readonly tablePrefix?: string }[] {
    return readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(packagesRoot, entry.name, 'package.json'))
      .filter((path) => existsSync(path))
      .map((path) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      .flatMap((pkg) => {
        const manifest = pkg['jsails'] as
          { readonly schema?: { readonly tablePrefix?: string } } | undefined;
        if (manifest === undefined) return [];
        const dir = (pkg['name'] as string).replace(/^@jsails\//, '');
        const tablePrefix = manifest.schema?.tablePrefix;
        return [tablePrefix === undefined ? { dir } : { dir, tablePrefix }];
      })
      .sort((a, b) => a.dir.localeCompare(b.dir));
  }

  it('creates every declared plugin table on an empty database', async () => {
    const plugins = firstParty();
    assert.deepEqual(
      plugins.map(({ dir }) => dir),
      Object.keys(CONSTRUCT).sort(),
    );
    const fixture = writeFixture('first-party');
    const uses = plugins.map(({ dir }) => {
      const wrapper = join(fixture.dir, `use-${dir}.mjs`);
      writeFileSync(
        wrapper,
        [
          `const dep = (name) => import(new URL(name + '/dist/src/index.js', ${JSON.stringify(pathToFileURL(packagesRoot).href)}).href);`,
          `const core = (path) => import(new URL(path, ${JSON.stringify(pathToFileURL(coreDist).href)}).href);`,
          `const m = await dep(${JSON.stringify(dir)});`,
          `export default async () => ${CONSTRUCT[dir] as string};`,
          '',
        ].join('\n'),
      );
      return pathToFileURL(wrapper).href;
    });
    const appConfigPath = join(fixture.dir, 'first-party.app.js');
    writeFileSync(appConfigPath, `export default { plugins: { use: ${JSON.stringify(uses)} } };\n`);
    const code = await runDbPush(
      fixture.configPath,
      {
        dryRun: false,
        allowDestructive: false,
        appConfigPath,
      },
      COMMAND_ENV,
    );
    assert.equal(code, 0);
    const tables = await readTables(fixture.dbPath);
    const prefixes = plugins.flatMap(({ tablePrefix }) => tablePrefix ?? []);
    assert.ok(prefixes.length > 0);
    for (const prefix of prefixes) {
      assert.ok(
        tables.some((table) => table.startsWith(prefix)),
        `no table starts with ${prefix}`,
      );
    }
    assert.equal(await runDbDiff(fixture.configPath, { appConfigPath }, COMMAND_ENV), 0);
  });
});
