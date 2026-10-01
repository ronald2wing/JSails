/**
 * Critic prediction "removing a plugin from `plugins.use` turns its tables
 * into drops, and a single `--allow-destructive` meant for one column also
 * authorises them", and the audit finding "db:push destructive gate is
 * all-or-nothing and one stray table blocks every safe change".
 *
 * `planSchema` (core/src/cli/commands/db.ts) diffs the live database against
 * the declared models with `allowDestructive: true`, and only plugins still
 * listed contribute their tables, so a removed plugin's table is a drop like
 * any other. The schema core has no record of who owns a table. DAT-06 adds the
 * ownership ledger and per-operation approval; DAT-11 plans an orphaned
 * plugin's tables separately, as an explicit owner-scoped action.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, type TestContext } from 'node:test';

import { runDbPush } from '../../../src/cli/commands/db.js';
import { JsailsDataSource } from '../../../src/database/data-source.js';

const PLUGIN_TABLE = 'regression_removed_rows';

interface Fixture {
  /** The database config for the first push and the one after the removal. */
  readonly configPath: string;
  readonly laterConfigPath: string;
  readonly withPlugin: string;
  readonly withoutPlugin: string;
  readonly dbPath: string;
}

/**
 * A SQLite app whose database config lists no models, with two app configs:
 * one enabling a plugin that owns {@link PLUGIN_TABLE}, one with it removed.
 */
function writeFixture(t: TestContext): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-plugin-removal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'app_test.sqlite');
  const typeorm = import.meta.resolve('typeorm');
  const dataSourceModule = new URL('../../../src/database/data-source.js', import.meta.url).href;
  const pluginPath = join(dir, 'plugin.mjs');
  writeFileSync(
    pluginPath,
    [
      `import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from ${JSON.stringify(typeorm)};`,
      'class RemovedRow extends BaseEntity {}',
      `Entity(${JSON.stringify(PLUGIN_TABLE)})(RemovedRow);`,
      "PrimaryGeneratedColumn()(RemovedRow.prototype, 'id');",
      "Column({ type: 'varchar', length: 100 })(RemovedRow.prototype, 'label');",
      "export default () => ({ name: 'regression-removed', schema: { entities: [RemovedRow] }, setup() {} });",
      '',
    ].join('\n'),
  );
  const withPlugin = join(dir, 'with-plugin.app.mjs');
  writeFileSync(
    withPlugin,
    `export default { plugins: { use: [${JSON.stringify(pathToFileURL(pluginPath).href)}] } };\n`,
  );
  const withoutPlugin = join(dir, 'without-plugin.app.mjs');
  writeFileSync(withoutPlugin, 'export default { plugins: { use: [] } };\n');
  // Two modules for one database: a config module is imported once per path,
  // and its data source keeps the entities a push added, as a new process
  // would not.
  const [configPath, laterConfigPath] = ['first', 'later'].map((name) => {
    const path = join(dir, `${name}.database.mjs`);
    writeFileSync(
      path,
      `import { JsailsDataSource } from ${JSON.stringify(dataSourceModule)};\n` +
        `export default new JsailsDataSource({ type: 'sqljs', location: ${JSON.stringify(dbPath)}, entities: [] });\n`,
    );
    return path;
  }) as [string, string];
  return { configPath, laterConfigPath, withPlugin, withoutPlugin, dbPath };
}

async function liveTables(dbPath: string): Promise<string[]> {
  const dataSource = new JsailsDataSource({ type: 'sqljs', location: dbPath, entities: [] });
  await dataSource.initialize();
  try {
    return (await dataSource.getLiveSchema()).tables.map((table) => table.name);
  } finally {
    await dataSource.destroy();
  }
}

async function pushWithPlugin(fixture: Fixture): Promise<void> {
  const code = await runDbPush(fixture.configPath, {
    dryRun: false,
    allowDestructive: false,
    appConfigPath: fixture.withPlugin,
  });
  assert.equal(code, 0);
  assert.ok((await liveTables(fixture.dbPath)).includes(PLUGIN_TABLE));
}

describe('db:push after a plugin is removed from plugins.use', () => {
  it("a push with nothing destructive of the app's own is not blocked", async (t) => {
    const fixture = writeFixture(t);
    await pushWithPlugin(fixture);

    const code = await runDbPush(fixture.laterConfigPath, {
      dryRun: false,
      allowDestructive: false,
      appConfigPath: fixture.withoutPlugin,
    });

    assert.equal(code, 0, "the removed plugin's table blocked a push that changes nothing");
  });

  it("--allow-destructive does not drop the removed plugin's table", async (t) => {
    const fixture = writeFixture(t);
    await pushWithPlugin(fixture);

    const code = await runDbPush(fixture.laterConfigPath, {
      dryRun: false,
      allowDestructive: true,
      appConfigPath: fixture.withoutPlugin,
    });

    assert.equal(code, 0);
    assert.ok(
      (await liveTables(fixture.dbPath)).includes(PLUGIN_TABLE),
      "the app's push dropped the removed plugin's table and its data",
    );
  });
});
