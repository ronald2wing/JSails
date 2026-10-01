/**
 * Tests for `db:push`/`db:diff` schema discovery from enabled plugins'
 * `schema.entities` and `schema.unmanagedTables`, without calling plugin
 * `setup`, and for the config module's `unmanagedTables` export.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { runDbDiff, runDbPush } from '../../../src/cli/commands/db.js';
import { MigrationError } from '../../../src/migrations/schema-types.js';

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
    const code = await runDbPush(fixture.configPath, {
      dryRun: false,
      allowDestructive: false,
      appConfigPath: fixture.appConfigPath,
    });
    assert.equal(code, 0);
    const tables = await readTables(fixture.dbPath);
    assert.ok(tables.includes('jsails_tenants'));
    assert.ok(tables.includes('jsails_tenant_memberships'));
  });

  it('creates no plugin tables when the plugin is not enabled', async () => {
    const fixture = writeFixture('disabled');
    const appConfigPath = join(fixture.dir, 'empty.app.js');
    writeFileSync(appConfigPath, 'export default {};\n');
    const code = await runDbPush(fixture.configPath, {
      dryRun: false,
      allowDestructive: false,
      appConfigPath,
    });
    assert.equal(code, 0);
    const tables = await readTables(fixture.dbPath);
    assert.equal(tables.includes('jsails_tenants'), false);
    assert.equal(tables.includes('jsails_tenant_memberships'), false);
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
    const diffCode = await runDbDiff(fixture.configPath, { appConfigPath });
    assert.equal(diffCode, 0);
    const code = await runDbPush(fixture.configPath, {
      dryRun: false,
      allowDestructive: false,
      appConfigPath,
    });
    assert.equal(code, 0);
    assert.ok((await readTables(fixture.dbPath)).includes('owned_user'));
  });

  it('refuses the push as destructive when nothing declares the table', async () => {
    const fixture = writeFixture('undeclared');
    await seedForeignTable(fixture.dbPath, 'owned_user', '"id" integer PRIMARY KEY NOT NULL');
    const appConfigPath = writePluginApp(fixture.dir, '{}');
    const code = await runDbPush(fixture.configPath, {
      dryRun: true,
      allowDestructive: false,
      appConfigPath,
    });
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
    const code = await runDbPush(fixture.configPath, {
      dryRun: false,
      allowDestructive: false,
      appConfigPath,
    });
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
      runDbPush(fixture.configPath, { dryRun: true, allowDestructive: false, appConfigPath }),
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
      runDbPush(fixture.configPath, {
        dryRun: true,
        allowDestructive: false,
        appConfigPath: fixture.appConfigPath,
      }),
      (error) => error instanceof MigrationError && error.code === 'invalid_options',
    );
  });
});
