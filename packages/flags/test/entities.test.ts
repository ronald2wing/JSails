/**
 * Feature flag entity tests: the portable schema `JsailsFeatureFlag` produces
 * offline, the single `create_table` operation the declarative plan emits for
 * it, and the frozen `flagsEntities` list.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { applyOperations, diffSchemaStates } from 'jsails';
import { JsailsDataSource } from 'jsails/database';
import { tempDir } from 'jsails/testing';
import { JsailsFeatureFlag, flagsEntities } from '../src/index.js';

const EXPECTED_COLUMNS = [
  { name: 'id', type: 'integer', nullable: false, primaryKey: true },
  { name: 'key', type: 'varchar', length: 190, nullable: false },
  { name: 'scope', type: 'varchar', length: 190, nullable: false },
  { name: 'updatedAt', type: 'datetime', nullable: false },
  { name: 'value', type: 'boolean', nullable: false },
];

describe('JsailsFeatureFlag', () => {
  it('builds the expected portable schema offline without connecting', async (t) => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tempDir(t), 'schema.db'),
      entities: [JsailsFeatureFlag],
    });
    const schema = await dataSource.getModelSchema();

    assert.equal(dataSource.isInitialized, false);
    assert.deepEqual(schema, {
      tables: [
        {
          name: 'jsails_feature_flag',
          columns: EXPECTED_COLUMNS,
          indexes: [
            { name: 'jsails_feature_flag_scope_key', columns: ['scope', 'key'], unique: false },
          ],
        },
      ],
    });
  });

  it('emits a single create_table operation with the expected scalar columns', async (t) => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tempDir(t), 'migration.db'),
      entities: [JsailsFeatureFlag],
    });
    const schema = await dataSource.getModelSchema();
    const operations = diffSchemaStates({ tables: [] }, schema);

    assert.equal(operations.length, 1);
    const operation = operations[0];
    assert.ok(operation, 'expected a create_table operation');
    assert.equal(operation.kind, 'create_table');
    if (operation.kind === 'create_table') {
      assert.equal(operation.table.name, 'jsails_feature_flag');
      assert.deepEqual(operation.table.columns, EXPECTED_COLUMNS);
    }
    assert.deepEqual(applyOperations({ tables: [] }, operations), schema);
  });

  it('is the only entity in the frozen flagsEntities', () => {
    assert.deepEqual([...flagsEntities], [JsailsFeatureFlag]);
    assert.ok(Object.isFrozen(flagsEntities));
  });
});
