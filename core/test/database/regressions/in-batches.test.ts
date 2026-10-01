/**
 * Audit findings "ModelQuery.in_batches permanently mutates the query" and
 * "`in_batches`/`find_each` are quadratic on SQLite: the cursor predicate
 * forces a full scan per batch".
 *
 * `in_batches` writes its ORDER BY, LIMIT and cursor predicate into the query's
 * shared builder and leaves them there, so the same query afterwards returns
 * only the rows after the last cursor. Its predicate,
 * `(:active = 0 OR (id > :cursor OR (:cursor IS NULL AND ...)))`, switches on a
 * parameter, which SQLite cannot turn into an index range, so every page scans
 * the table. DAT-07 builds each page from an immutable query with a plain
 * keyset predicate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { query } from '../../../src/database/model-query.js';
import { openMatrixDataSource } from './matrix-database.js';
import { createStatementLog } from './statement-log.js';

function makeItem() {
  @Entity('regression_batch_items')
  class Item extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100 })
    name!: string;
  }
  return Item;
}

async function seed(Item: ReturnType<typeof makeItem>, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await Item.create({ name: `item ${index}` }).save();
  }
}

describe('ModelQuery.in_batches', () => {
  it('leaves the query as it was: getMany() afterwards returns every row', async (t) => {
    const Item = makeItem();
    await openMatrixDataSource(t, { entities: [Item] });
    await seed(Item, 5);
    const items = query<InstanceType<typeof Item>>(Item);

    await items.in_batches(2, () => undefined);

    assert.equal((await items.getMany()).length, 5, 'the query kept the batch walk state');
  });

  it('walks every row again when run a second time', async (t) => {
    const Item = makeItem();
    await openMatrixDataSource(t, { entities: [Item] });
    await seed(Item, 5);
    const items = query<InstanceType<typeof Item>>(Item);
    let first = 0;
    let second = 0;

    await items.in_batches(2, (rows) => {
      first += rows.length;
    });
    await items.in_batches(2, (rows) => {
      second += rows.length;
    });

    assert.equal(first, 5);
    assert.equal(second, 5, 'the second walk started after the first walk ended');
  });

  it('reads each page after the first through the primary key index on SQLite', async (t) => {
    const Item = makeItem();
    const log = createStatementLog();
    const dataSource = await openMatrixDataSource(t, { entities: [Item], logger: log.logger });
    await seed(Item, 5);
    log.reset();

    await query<InstanceType<typeof Item>>(Item).in_batches(2, () => undefined);

    const pages = log.selects();
    const secondPage = pages[1];
    assert.ok(secondPage !== undefined, 'in_batches read fewer than two pages');
    const plan: { detail: string }[] = await dataSource.query(
      `EXPLAIN QUERY PLAN ${secondPage.sql}`,
      [...secondPage.parameters],
    );
    const details = plan.map((row) => row.detail);
    assert.ok(
      !details.some((detail) => /^SCAN\b/.test(detail)),
      `the page scans the table: ${details.join('; ')}`,
    );
  });
});
