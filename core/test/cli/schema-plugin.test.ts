import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { runDbPush } from '../../src/cli/schema-commands.js';

const fixtureRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'schema-plugin-'),
);

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

interface SqlDatabase {
  exec(sql: string): { values: unknown[][] }[];
  close(): void;
}

async function readTables(dbPath: string): Promise<string[]> {
  if (!existsSync(dbPath)) return [];
  const require = createRequire(import.meta.url);
  const initSqlJs = require('sql.js') as (config?: unknown) => Promise<unknown>;
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = (await initSqlJs({ locateFile: () => wasmPath })) as {
    Database: new (data: Uint8Array) => SqlDatabase;
  };
  const db = new SQL.Database(readFileSync(dbPath));
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
    new URL('../../src/database/data-source.js', import.meta.url),
  );
  const tenancyModule = fileURLToPath(
    new URL('../../../../plugins/tenancy/dist/src/index.js', import.meta.url),
  );
  const pluginPath = join(dir, 'plugin.mjs');
  const appConfigPath = join(dir, 'jsails.app.js');
  const configPath = join(dir, 'jsails.config.js');

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
