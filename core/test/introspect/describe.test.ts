/**
 * Tests for `buildDescribeSchema`: the schema-only describe entry point loads
 * just the database config, memoizes per process on the config file's mtime,
 * and degrades to empty tables for a missing or unusable config.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { buildDescribeSchema } from '../../src/introspect/describe.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-describe-schema-'));
const globals = globalThis as Record<string, unknown>;

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A db config whose `getModelSchema` declares one table and counts evaluations. */
function writeDbConfig(path: string, counter: string, table: string): void {
  writeFileSync(
    path,
    [
      `globalThis.${counter} = (globalThis.${counter} ?? 0) + 1;`,
      'export default {',
      '  async getModelSchema() {',
      `    return { tables: [{ name: ${JSON.stringify(table)}, columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }] }] };`,
      '  },',
      '};',
      '',
    ].join('\n'),
  );
}

describe('buildDescribeSchema', () => {
  it('converts the declared schema without loading an app config', async () => {
    const path = join(root, 'convert.database.js');
    writeDbConfig(path, '__describeSchemaConvert', 'widgets');

    const schema = await buildDescribeSchema(path);

    assert.deepEqual(schema, {
      tables: [
        {
          name: 'widgets',
          columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
          indexes: [],
          uniques: [],
          foreignKeys: [],
        },
      ],
    });
    delete globals.__describeSchemaConvert;
  });

  it('serves an unchanged config from the cache and reloads a rebuilt one', async () => {
    const counter = '__describeSchemaMemo';
    const path = join(root, 'memo.database.js');
    writeDbConfig(path, counter, 'first');
    utimesSync(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    const first = await buildDescribeSchema(path);
    const second = await buildDescribeSchema(path);
    assert.equal(globals[counter], 1, 'an unchanged config is evaluated once');
    assert.deepEqual(second, first);
    assert.notEqual(second, first, 'each call returns its own copy');

    writeDbConfig(path, counter, 'second');
    utimesSync(path, new Date(1_700_000_100_000), new Date(1_700_000_100_000));
    const rebuilt = await buildDescribeSchema(path);
    assert.equal(globals[counter], 2, 'a new mtime evaluates the config again');
    assert.equal(rebuilt.tables[0]?.name, 'second');
    delete globals[counter];
  });

  it('returns empty tables for a missing config or one without a data source', async () => {
    assert.deepEqual(await buildDescribeSchema(join(root, 'absent.database.js')), { tables: [] });

    const path = join(root, 'plain.database.js');
    writeFileSync(path, 'export default {};\n');
    assert.deepEqual(await buildDescribeSchema(path), { tables: [] });
  });
});
