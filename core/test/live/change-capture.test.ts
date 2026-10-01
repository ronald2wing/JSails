/**
 * Tests for the live layer's post-commit change capture.
 *
 * `createChangeCapture` turns committed ORM writes into `LiveChange` records via
 * a TypeORM subscriber with a depth-stacked per-query-runner buffer. These tests
 * exercise the correctness core against a real on-disk sql.js database driven by
 * a `JsailsDataSource` (whose `liveCapture` handle carries the wired subscriber):
 *
 * - insert/update/delete each emit one full-row `LiveChange` (delete: `row: null`);
 * - a rolled-back transaction emits nothing;
 * - a savepoint rollback drops only that frame (the outer rows still flush);
 * - a savepoint commit inside a later-rolled-back outer transaction emits nothing;
 * - a bulk save emits one flush with all three changes; and
 * - a throwing flush never fails the `save()`.
 *
 * Savepoints come from raw TypeORM nested `dataSource.transaction` /
 * `manager.transaction`; the JSails `transaction()` wrapper joins nested calls
 * without savepoints, so it cannot exercise the depth stack (LIVE-PLAN.md Phase 3
 * note 3).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { JsailsDataSource } from '../../src/database/data-source.js';
import type { LiveChange } from '../../src/live/change-record.js';
import { diffSchemaStates } from '../../src/migrations/autodetector.js';
import { executeSchemaPlan } from '../../src/migrations/schema-executor.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'jsails-change-capture-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeItem() {
  @Entity('cap_items')
  class Item extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;

    @Column({ type: 'integer', nullable: true })
    rank!: number | null;
  }
  return Item;
}

let locationSeq = 0;

/** Build, initialize, and table-create a sqljs data source bound to `Item`. */
async function createDataSource(Item: ReturnType<typeof makeItem>): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `db-${locationSeq++}.sqlite`);
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities: [Item],
  });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  const operations = diffSchemaStates({ tables: [] }, schema);
  await executeSchemaPlan(dataSource, operations);
  return dataSource;
}

describe('change capture', () => {
  it('emits one full-row LiveChange for an insert', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const collected: LiveChange[] = [];
    ds.liveCapture.setListener((changes) => {
      collected.push(...changes);
    });

    const item = await Item.create({ name: 'alice', rank: 1 }).save();

    assert.equal(collected.length, 1);
    const change = collected[0]!;
    assert.equal(change.operation, 'insert');
    assert.equal(change.id, String(item.id));
    assert.equal(change.collection, 'Item');
    // Provisional: the capture emits the entity name (metadata.name). The
    // publication-scoped collection key is resolved by the multiplexer/service
    // in Phases 4-5 (LIVE-PLAN.md §4.1, Phase 4-5).
    assert.equal(change.sequence, 0);
    assert.equal(typeof change.at, 'number');
    assert.deepEqual(change.row, { id: item.id, name: 'alice', rank: 1 });

    await ds.destroy();
  });

  it('emits one full-row LiveChange for an update', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const collected: LiveChange[] = [];
    ds.liveCapture.setListener((changes) => {
      collected.push(...changes);
    });

    const item = await Item.create({ name: 'alice', rank: 1 }).save();
    collected.length = 0;

    item.name = 'alice-updated';
    await item.save();

    assert.equal(collected.length, 1);
    const change = collected[0]!;
    assert.equal(change.operation, 'update');
    assert.equal(change.id, String(item.id));
    assert.deepEqual(change.row, { id: item.id, name: 'alice-updated', rank: 1 });

    await ds.destroy();
  });

  it('emits a delete with row: null', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const collected: LiveChange[] = [];
    ds.liveCapture.setListener((changes) => {
      collected.push(...changes);
    });

    const item = await Item.create({ name: 'alice', rank: 1 }).save();
    collected.length = 0;

    // TypeORM's remove() clears the PK on the removed instance, so snapshot it
    // before the delete: the capture re-reads it from databaseEntity, not entity.
    const itemId = item.id;
    await item.remove();

    assert.equal(collected.length, 1);
    const change = collected[0]!;
    assert.equal(change.operation, 'delete');
    assert.equal(change.id, String(itemId));
    assert.equal(change.row, null);

    await ds.destroy();
  });

  it('emits nothing for a rolled-back transaction', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const collected: LiveChange[] = [];
    ds.liveCapture.setListener((changes) => {
      collected.push(...changes);
    });

    await assert.rejects(
      ds.transaction(async (manager) => {
        await manager.save(Item, { name: 'should-not-persist', rank: 1 });
        throw new Error('boom');
      }),
      /boom/,
    );

    assert.deepEqual(collected, []);
    assert.equal(await Item.count(), 0);

    await ds.destroy();
  });

  it('drops only the rolled-back savepoint frame, keeping the outer rows', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const collected: LiveChange[] = [];
    ds.liveCapture.setListener((changes) => {
      collected.push(...changes);
    });

    await ds.transaction(async (manager) => {
      await manager.save(Item, { name: 'outer', rank: 1 });
      await assert.rejects(
        manager.transaction(async (inner) => {
          await inner.save(Item, { name: 'inner-rolled-back', rank: 2 });
          throw new Error('inner-boom');
        }),
        /inner-boom/,
      );
    });

    // Only the outer row flushed; the savepoint's row was dropped.
    assert.equal(await Item.count(), 1);
    assert.equal(collected.length, 1);
    const change = collected[0]!;
    assert.equal(change.operation, 'insert');
    assert.equal(change.row?.name, 'outer');

    await ds.destroy();
  });

  it('emits nothing when a savepoint commit is inside a transaction that later rolls back', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const collected: LiveChange[] = [];
    ds.liveCapture.setListener((changes) => {
      collected.push(...changes);
    });

    await assert.rejects(
      ds.transaction(async (manager) => {
        // The nested (savepoint) commit must NOT flush — it merges upward.
        await manager.transaction(async (inner) => {
          await inner.save(Item, { name: 'inner-committed-then-rolled-back', rank: 1 });
        });
        await manager.save(Item, { name: 'outer', rank: 2 });
        throw new Error('outer-boom');
      }),
      /outer-boom/,
    );

    assert.deepEqual(collected, []);
    assert.equal(await Item.count(), 0);

    await ds.destroy();
  });

  it('merges a savepoint commit and flushes once at depth zero', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const flushes: LiveChange[][] = [];
    ds.liveCapture.setListener((changes) => {
      flushes.push([...changes]);
    });

    await ds.transaction(async (manager) => {
      await manager.save(Item, { name: 'outer', rank: 1 });
      await manager.transaction(async (inner) => {
        await inner.save(Item, { name: 'inner', rank: 2 });
      });
      await manager.save(Item, { name: 'outer-last', rank: 3 });
    });

    // One flush (depth-zero commit), carrying all three rows in capture order.
    assert.equal(flushes.length, 1);
    assert.equal(flushes[0]!.length, 3);
    assert.deepEqual(
      flushes[0]!.map((c) => c.row?.name),
      ['outer', 'inner', 'outer-last'],
    );
    assert.equal(await Item.count(), 3);

    await ds.destroy();
  });

  it('a bulk save produces one flush with all changes', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const flushes: LiveChange[][] = [];
    ds.liveCapture.setListener((changes) => {
      flushes.push([...changes]);
    });

    const a = Item.create({ name: 'a', rank: 1 });
    const b = Item.create({ name: 'b', rank: 2 });
    const c = Item.create({ name: 'c', rank: 3 });
    await Item.save([a, b, c]);

    // The bulk save is one transaction: one flush with three inserts.
    assert.equal(flushes.length, 1);
    assert.equal(flushes[0]!.length, 3);
    assert.deepEqual(flushes[0]!.map((ch) => ch.row?.name).sort(), ['a', 'b', 'c']);

    await ds.destroy();
  });

  it('a throwing listener does not fail the save', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    ds.liveCapture.setListener(() => {
      throw new Error('flush-boom');
    });

    const item = await Item.create({ name: 'alice', rank: 1 }).save();

    // The write committed despite the throwing listener (LIVE-PLAN.md note 7).
    assert.equal(await Item.count(), 1);
    assert.equal(typeof item.id, 'number');

    await ds.destroy();
  });

  it('closes cleanly: no emission and no state after close', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const collected: LiveChange[] = [];
    ds.liveCapture.setListener((changes) => {
      collected.push(...changes);
    });
    ds.liveCapture.close();

    await Item.create({ name: 'alice', rank: 1 }).save();

    assert.deepEqual(collected, []);
    assert.equal(await Item.count(), 1);

    await ds.destroy();
  });
});
