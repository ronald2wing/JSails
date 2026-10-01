/**
 * Session entity tests: the portable schema `JsailsSession` produces offline,
 * the single `create_table` operation the declarative plan emits for it, and
 * the frozen `sessionEntities` list.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { applyOperations, diffSchemaStates } from 'jsails';
import { JsailsDataSource } from 'jsails/database';
import { tempDir } from 'jsails/testing';
import { JsailsSession, SESSION_TABLE, sessionEntities } from '../src/index.js';

const EXPECTED_COLUMNS = [
  { name: 'id', type: 'integer', nullable: false, primaryKey: true },
  { name: 'createdAt', type: 'datetime', nullable: false },
  { name: 'data', type: 'text', nullable: false },
  { name: 'expiresAt', type: 'datetime', nullable: false },
  { name: 'sessionId', type: 'varchar', length: 190, nullable: false },
];

describe('JsailsSession', () => {
  it('builds the expected portable schema offline without connecting', async (t) => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tempDir(t), 'schema.db'),
      entities: [JsailsSession],
    });
    const schema = await dataSource.getModelSchema();

    assert.equal(dataSource.isInitialized, false);
    assert.deepEqual(schema, {
      tables: [
        {
          name: SESSION_TABLE,
          columns: EXPECTED_COLUMNS,
          indexes: [
            { name: 'jsails_session_expires_at', columns: ['expiresAt'], unique: false },
            { name: 'jsails_session_session_id_unique', columns: ['sessionId'], unique: true },
          ],
        },
      ],
    });
  });

  it('emits a single create_table operation with the expected scalar columns', async (t) => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tempDir(t), 'migration.db'),
      entities: [JsailsSession],
    });
    const schema = await dataSource.getModelSchema();
    const operations = diffSchemaStates({ tables: [] }, schema);

    assert.equal(operations.length, 1);
    const operation = operations[0];
    assert.ok(operation, 'expected a create_table operation');
    assert.equal(operation.kind, 'create_table');
    if (operation.kind === 'create_table') {
      assert.equal(operation.table.name, SESSION_TABLE);
      assert.deepEqual(operation.table.columns, EXPECTED_COLUMNS);
    }
    assert.deepEqual(applyOperations({ tables: [] }, operations), schema);
  });

  it('is the only entity in the frozen sessionEntities', () => {
    assert.deepEqual([...sessionEntities], [JsailsSession]);
    assert.ok(Object.isFrozen(sessionEntities));
  });
});
