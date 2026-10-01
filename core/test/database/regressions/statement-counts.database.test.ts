/**
 * Statement budgets the data layer's design states, measured against today's
 * stack on every driver (the PERF-6 step: today's counts become the record).
 *
 * - "Eager loading runs two queries per relation and re-fetches rows by
 *   primary key in 1000-id chunks": the loader selects (pk, fk) pairs and then
 *   re-selects the same children by primary key, because the hydrated child
 *   does not carry its foreign key. DAT-09 loads one statement per level.
 * - Critic prediction "`save()` on a loaded record pays a SELECT before every
 *   UPDATE": TypeORM reloads the row to diff it although the record was just
 *   loaded. DAT-08's full-instance record write sends the UPDATE alone.
 *
 * Each failure message states the count measured, and the ledger pins today's
 * count, so the budget is also a ceiling: a stack that gets worse (one
 * statement per parent, a second SELECT before the UPDATE) fails as an
 * unexpected failure instead of hiding behind the expected one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BaseEntity,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { query } from '../../../src/database/model-query.js';
import { openMatrixDataSource } from './matrix-database.js';
import { createStatementLog } from './statement-log.js';

function makeModels() {
  @Entity('regression_threads')
  class Thread extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100 })
    title!: string;

    @OneToMany('Reply', 'thread')
    replies!: Reply[];
  }

  @Entity('regression_replies')
  class Reply extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100 })
    body!: string;

    @ManyToOne('Thread', 'replies', { nullable: false })
    @JoinColumn({ name: 'thread_id' })
    thread!: Thread;
  }

  return { Thread, Reply };
}

function describeStatements(statements: readonly { sql: string }[]): string {
  return statements.map((statement) => statement.sql.replace(/\s+/g, ' ')).join('\n  ');
}

describe('statement budgets', () => {
  it('loading a has-many relation for many parents costs one statement for the children', async (t) => {
    const { Thread, Reply } = makeModels();
    const log = createStatementLog();
    await openMatrixDataSource(t, { entities: [Thread, Reply], logger: log.logger });
    for (let index = 0; index < 3; index += 1) {
      const thread = await Thread.create({ title: `thread ${index}` }).save();
      await Reply.create({ body: 'first', thread }).save();
      await Reply.create({ body: 'second', thread }).save();
    }
    log.reset();

    const threads = await query<InstanceType<typeof Thread>>(Thread)
      .includes({ replies: true })
      .getMany();

    assert.equal(threads.length, 3);
    assert.equal(threads.flatMap((thread) => thread.replies).length, 6);
    const selects = log.selects();
    assert.equal(
      selects.length,
      2,
      `expected 2 SELECTs (the parents, then their replies), got ${selects.length}:\n  ${describeStatements(selects)}`,
    );
  });

  it('saving a loaded, modified record sends no SELECT', async (t) => {
    const { Thread, Reply } = makeModels();
    const log = createStatementLog();
    await openMatrixDataSource(t, { entities: [Thread, Reply], logger: log.logger });
    const created = await Thread.create({ title: 'before' }).save();
    const loaded = await Thread.findOneByOrFail({ id: created.id });
    log.reset();

    loaded.title = 'after';
    await loaded.save();

    const selects = log.selects();
    assert.equal(
      selects.length,
      0,
      `expected no SELECT before the UPDATE, got ${selects.length}:\n  ${describeStatements(selects)}`,
    );
    assert.equal((await Thread.findOneByOrFail({ id: created.id })).title, 'after');
  });
});
