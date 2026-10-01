/**
 * `upsertRow`: insert, update of the changed columns, and the concurrent
 * first-write race resolved as an update.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn, Repository } from 'typeorm';

import { JsailsDataSource } from '../../src/database/data-source.js';
import { upsertRow } from '../../src/database/upsert.js';
import { diffSchemaStates } from '../../src/migrations/autodetector.js';
import { executeSchemaPlan } from '../../src/migrations/schema-executor.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'upsert-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

function makeEntry() {
  @Entity('entries')
  @Index('uq_entries_key', ['key'], { unique: true })
  class Entry extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 50 })
    key!: string;

    @Column({ type: 'varchar', length: 50 })
    value!: string;

    @Column({ type: 'json', nullable: true })
    data!: { count: number } | null;
  }
  return Entry;
}

let seq = 0;

async function setup() {
  const Entry = makeEntry();
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location: join(tmpRoot, `db-${seq++}.sqlite`),
    entities: [Entry],
  });
  await dataSource.initialize();
  await executeSchemaPlan(
    dataSource,
    diffSchemaStates({ tables: [] }, await dataSource.getModelSchema()),
  );
  return { Entry, dataSource };
}

function upsert(dataSource: JsailsDataSource, Entry: ReturnType<typeof makeEntry>, value: string) {
  return upsertRow({
    dataSource,
    entity: Entry,
    where: { key: 'k' },
    update: (existing) => {
      existing.value = value;
    },
    create: () => ({ key: 'k', value }),
  });
}

function bumpData(dataSource: JsailsDataSource, Entry: ReturnType<typeof makeEntry>) {
  return upsertRow({
    dataSource,
    entity: Entry,
    where: { key: 'k' },
    update: (existing) => {
      // Mutated in place: the column keeps the same object reference.
      existing.data!.count += 1;
    },
    create: () => ({ key: 'k', value: 'v', data: { count: 0 } }),
  });
}

describe('upsertRow', () => {
  it('inserts, then updates the same row', async () => {
    const { Entry, dataSource } = await setup();
    await upsert(dataSource, Entry, 'one');
    await upsert(dataSource, Entry, 'two');
    const rows = await Entry.find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.value, 'two');
    await dataSource.destroy();
  });

  it('writes a JSON column the mutator changed in place', async () => {
    const { Entry, dataSource } = await setup();
    await bumpData(dataSource, Entry);
    await bumpData(dataSource, Entry);
    await bumpData(dataSource, Entry);
    const rows = await Entry.find();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.data, { count: 2 });
    await dataSource.destroy();
  });

  it('a writer that loses the first-insert race updates the winner row', async () => {
    const { Entry, dataSource } = await setup();
    // Make the lookup miss once, as if another writer inserted right after it.
    const original = Repository.prototype.findOneBy;
    let missed = false;
    Repository.prototype.findOneBy = async function (this: Repository<any>, where: any) {
      if (!missed) {
        missed = true;
        await dataSource.query(`INSERT INTO entries (key, value) VALUES ('k', 'winner')`);
        return null;
      }
      return original.call(this, where);
    } as typeof original;
    try {
      await upsert(dataSource, Entry, 'loser');
    } finally {
      Repository.prototype.findOneBy = original;
    }
    const rows = await Entry.find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.value, 'loser');
    await dataSource.destroy();
  });

  it('an update writes only by primary key, with no transaction or reload', async () => {
    const { Entry, dataSource } = await setup();
    await upsert(dataSource, Entry, 'one');
    const statements: string[] = [];
    const runner = dataSource.driver as unknown as { createQueryRunner: (m: string) => any };
    const create = runner.createQueryRunner.bind(runner);
    // sql.js hands out one shared runner, so each runner is wrapped once.
    const wrapped = new WeakSet<object>();
    runner.createQueryRunner = (mode: string) => {
      const qr = create(mode);
      if (wrapped.has(qr)) return qr;
      wrapped.add(qr);
      const query = qr.query.bind(qr);
      qr.query = (sql: string, ...rest: unknown[]) => {
        statements.push(sql);
        return query(sql, ...rest);
      };
      return qr;
    };
    try {
      await upsert(dataSource, Entry, 'two');
    } finally {
      runner.createQueryRunner = create;
    }
    assert.equal(statements.filter((sql) => /^(BEGIN|COMMIT)/i.test(sql)).length, 0);
    assert.equal(statements.filter((sql) => /^SELECT/i.test(sql)).length, 1);
    assert.equal(statements.filter((sql) => /^UPDATE/i.test(sql)).length, 1);
    await dataSource.destroy();
  });
});
