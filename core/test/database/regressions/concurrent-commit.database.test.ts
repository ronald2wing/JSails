/**
 * Audit finding "Concurrent transaction() calls on the sqljs driver share one
 * connection: a committed transaction is lost when another rolls back", on
 * every driver. sql.js hands every caller one connection, so overlapping work
 * used to land inside whichever transaction was open. M0 queued `transaction()`
 * calls and the connection lease (core/src/database/connection-lease.ts) now
 * queues every runner; DAT-02 replaces sql.js with node:sqlite behind a writer
 * mutex. The server drivers pass trivially and keep the contract honest there.
 */

import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { transaction } from '../../../src/database/transaction.js';
import { openMatrixDataSource } from './matrix-database.js';

function makeItem() {
  @Entity('regression_items')
  class Item extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100 })
    name!: string;
  }
  return Item;
}

async function names(Item: ReturnType<typeof makeItem>): Promise<string[]> {
  return (await Item.find({ order: { id: 'ASC' } })).map((item) => item.name);
}

describe('a committed write survives a concurrent rollback', () => {
  it('of another transaction()', async (t) => {
    const Item = makeItem();
    const dataSource = await openMatrixDataSource(t, { entities: [Item] });

    const committed = transaction(dataSource, async (handle) => {
      await handle.manager.save(Item, { name: 'committed' });
      await pause(20);
    });
    const rolledBack = transaction(dataSource, async (handle) => {
      await handle.manager.save(Item, { name: 'rolled-back' });
      await pause(40);
      throw new Error('abort');
    });
    const [first, second] = await Promise.allSettled([committed, rolledBack]);

    assert.equal(first.status, 'fulfilled');
    assert.equal(second.status, 'rejected');
    assert.deepEqual(await names(Item), ['committed']);
  });

  it('when the committed write is a bare save() outside any transaction', async (t) => {
    const Item = makeItem();
    const dataSource = await openMatrixDataSource(t, { entities: [Item] });

    const rolledBack = transaction(dataSource, async (handle) => {
      await handle.manager.save(Item, { name: 'rolled-back' });
      await pause(40);
      throw new Error('abort');
    });
    await pause(10);
    const bare = Item.create({ name: 'bare' }).save();
    const [first, second] = await Promise.allSettled([rolledBack, bare]);

    assert.equal(first.status, 'rejected');
    assert.equal(second.status, 'fulfilled');
    assert.deepEqual(await names(Item), ['bare']);
  });
});
