/**
 * Critic prediction "framework stores that capture a repository from the data
 * source do not join an ambient transaction" (packages/flags/src/database-store.ts
 * resolves `dataSource.getRepository` once): on a server the store's write
 * takes its own pooled connection, commits on its own, and survives the
 * rollback of the transaction it ran in, including `withTestTransaction`'s
 * per-test rollback. On sql.js the connection lease joins the open
 * transaction, so the SQLite leg passes. DAT-04 binds only the new stack's
 * transactions at the engine lease; the store joins them once DAT-13 ports it
 * onto the owned API. On PostgreSQL the store fails before the write today:
 * its entity declares `datetime`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDatabaseFlagStore, flagsEntities } from '@jsails/flags/database';
import { withTestTransaction } from 'jsails/testing';

import { openMatrixDataSource } from '../../src/testing/index.js';

describe('package stores inside a test transaction', () => {
  it('a flag set inside withTestTransaction is rolled back with it', async (t) => {
    const dataSource = await openMatrixDataSource(t, { entities: [...flagsEntities] });
    const flags = createDatabaseFlagStore({ dataSource });

    await withTestTransaction(dataSource, async () => {
      await flags.set('new-checkout', true);
    });

    assert.equal(
      await flags.get('new-checkout'),
      null,
      'the flag write survived the rollback of its test transaction',
    );
  });
});
