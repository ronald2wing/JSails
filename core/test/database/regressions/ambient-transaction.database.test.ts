/**
 * Audit finding "withRollback/loadFixtures do not roll back writes made through
 * dataSource.getRepository on server drivers" and the critic prediction
 * "framework stores that capture a repository from the data source do not join
 * an ambient transaction", on every driver.
 *
 * `transaction()` keeps its manager in AsyncLocalStorage, and the only reader
 * is `ApplicationRecord.getRepository`. Anything that resolves through the data
 * source itself (`dataSource.getRepository`, `dataSource.manager`, fixtures,
 * and every package store holding a repository) takes another pooled
 * connection on a server, so its write commits on its own and survives the
 * rollback. On sql.js the connection lease joins the open transaction, so the
 * SQLite leg passes. DAT-04 binds transactions at the lease, for every caller.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { loadFixtures, withRollback } from '../../../src/database/fixtures.js';
import { transaction } from '../../../src/database/transaction.js';
import { openMatrixDataSource } from './matrix-database.js';

function makeNote() {
  @Entity('regression_notes')
  class Note extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100 })
    body!: string;
  }
  return Note;
}

const ROLLBACK = new Error('roll back');

async function rollingBack(body: () => Promise<void>): Promise<void> {
  await assert.rejects(body(), (error) => error === ROLLBACK);
}

describe('writes inside a transaction roll back with it', () => {
  it('a write through dataSource.getRepository inside transaction()', async (t) => {
    const Note = makeNote();
    const dataSource = await openMatrixDataSource(t, { entities: [Note] });

    await rollingBack(() =>
      transaction(dataSource, async () => {
        await dataSource.getRepository(Note).save({ body: 'repository write' });
        throw ROLLBACK;
      }),
    );

    assert.equal(
      await Note.count(),
      0,
      'the repository write committed on another connection and survived the rollback',
    );
  });

  it('a write through dataSource.manager inside transaction()', async (t) => {
    const Note = makeNote();
    const dataSource = await openMatrixDataSource(t, { entities: [Note] });

    await rollingBack(() =>
      transaction(dataSource, async () => {
        await dataSource.manager.insert(Note, { body: 'manager write' });
        throw ROLLBACK;
      }),
    );

    assert.equal(
      await Note.count(),
      0,
      'the manager write committed on another connection and survived the rollback',
    );
  });

  it('a write through dataSource.getRepository inside withRollback', async (t) => {
    const Note = makeNote();
    const dataSource = await openMatrixDataSource(t, { entities: [Note] });

    await withRollback(dataSource, async () => {
      await dataSource.getRepository(Note).save({ body: 'test isolation' });
    });

    assert.equal(
      await Note.count(),
      0,
      'withRollback left the repository write behind for the next test',
    );
  });

  it('fixtures loaded inside withRollback', async (t) => {
    const Note = makeNote();
    const dataSource = await openMatrixDataSource(t, { entities: [Note] });

    await withRollback(dataSource, async () => {
      await loadFixtures(dataSource, [{ entity: 'Note', rows: [{ body: 'fixture' }] }]);
    });

    assert.equal(await Note.count(), 0, 'withRollback left the fixture rows behind');
  });
});
