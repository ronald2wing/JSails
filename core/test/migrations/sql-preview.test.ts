import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Operation } from '../../src/migrations/operations.js';
import { previewSchemaOperations } from '../../src/migrations/sql-preview.js';

const createUsers: Operation = {
  kind: 'create_table',
  table: {
    name: 'users',
    columns: [
      { name: 'id', type: 'integer', nullable: false, primaryKey: true },
      { name: 'name', type: 'varchar', length: 100, nullable: false },
    ],
  },
};

describe('previewSchemaOperations', () => {
  it('renders Postgres DDL without connecting', async () => {
    const entries = await previewSchemaOperations([createUsers], 'postgres');
    assert.equal(entries.length, 1);
    const statements = entries[0]?.statements ?? [];
    assert.ok(statements.some((sql) => sql.includes('CREATE TABLE "users"')));
  });

  it('renders MySQL DDL with driver quoting', async () => {
    const entries = await previewSchemaOperations([createUsers], 'mysql');
    const statements = entries[0]?.statements ?? [];
    assert.ok(statements.some((sql) => sql.includes('CREATE TABLE `users`')));
    assert.ok(statements.some((sql) => sql.includes('ENGINE=InnoDB')));
  });

  it('renders a copy_column as an UPDATE', async () => {
    const entries = await previewSchemaOperations(
      [
        {
          kind: 'copy_column',
          table: 'users',
          from: 'legacy_status',
          to: 'status',
          expression: 'legacy_status',
        },
      ],
      'postgres',
    );
    assert.deepEqual(entries[0]?.statements, ['UPDATE "users" SET "status" = legacy_status']);
  });

  it('marks metadata-only operations with no SQL', async () => {
    const entries = await previewSchemaOperations(
      [
        {
          kind: 'alter_inheritance',
          table: 'users',
          inheritance: {
            strategy: 'single',
            discriminatorColumn: 'type',
            discriminatorValues: ['a'],
          },
          previous: undefined,
        },
      ],
      'postgres',
    );
    assert.deepEqual(entries[0]?.statements, []);
    assert.equal(entries[0]?.note, undefined);
  });

  it('returns [] for an empty plan', async () => {
    assert.deepEqual(await previewSchemaOperations([], 'postgres'), []);
  });
});
