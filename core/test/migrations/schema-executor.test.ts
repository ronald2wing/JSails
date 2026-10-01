/**
 * The schema-plan executor's non-transactional path: a MySQL/MariaDB plan that
 * fails part-way reports what was applied.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QueryRunner } from 'typeorm';

import type { Operation } from '../../src/migrations/operations.js';
import { executeSchemaPlan, PartialSchemaPlanError } from '../../src/migrations/schema-executor.js';
import { MigrationError } from '../../src/migrations/schema-types.js';

function addColumn(name: string): Operation {
  return { kind: 'add_column', table: 'users', column: { name, type: 'integer', nullable: true } };
}

describe('executeSchemaPlan on mysql', () => {
  it('names the applied operations when one fails part-way', async () => {
    const added: string[] = [];
    const runner = {
      connect: async () => {},
      release: async () => {},
      addColumn: async (_table: string, column: { name: string }) => {
        if (column.name === 'b') throw new Error('duplicate column');
        added.push(column.name);
      },
    };
    const dataSource = {
      isInitialized: true,
      jsailsDriver: 'mysql' as const,
      createQueryRunner: () => runner as unknown as QueryRunner,
      initialize: async () => undefined,
    };
    const plan = [addColumn('a'), addColumn('b'), addColumn('c')];

    await assert.rejects(executeSchemaPlan(dataSource, plan), (err: unknown) => {
      assert.ok(err instanceof PartialSchemaPlanError);
      assert.ok(err instanceof MigrationError);
      assert.equal(err.code, 'partially_applied');
      assert.deepEqual(
        err.applied.map((op) => (op.kind === 'add_column' ? op.column.name : '')),
        ['a'],
      );
      assert.equal(err.failed.kind === 'add_column' && err.failed.column.name, 'b');
      assert.match(err.message, /operation 2 of 3/);
      assert.equal((err.cause as Error).message, 'duplicate column');
      return true;
    });
    assert.deepEqual(added, ['a']);
  });
});
