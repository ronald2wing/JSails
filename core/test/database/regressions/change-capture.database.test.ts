/**
 * Critic prediction "live capture silently drops set-form writes", on every
 * driver: the change capture reads the primary key off the written entity, and
 * a set-form write (`Model.update(criteria, set)`, `repository.increment`, or
 * the framework's own counter-cache bookkeeping) carries none, so it never
 * reaches a live subscriber. The correct behaviour is a change record for
 * every committed write; DAT-08 emits key-only records from the one write
 * pipeline, in row and set form.
 */

import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import type { LiveChange } from '../../../src/live/change-record.js';
import { openMatrixDataSource } from './matrix-database.js';

function makeCounter() {
  @Entity('regression_counters')
  class Counter extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100 })
    label!: string;

    @Column({ type: 'integer', default: 0 })
    hits!: number;
  }
  return Counter;
}

describe('live change capture of set-form writes', () => {
  it('a record save is captured (the row form, which works today)', async (t) => {
    const Counter = makeCounter();
    const dataSource = await openMatrixDataSource(t, { entities: [Counter] });
    const counter = await Counter.create({ label: 'before' }).save();
    const changes: LiveChange[] = [];
    dataSource.liveCapture.setListener((batch) => {
      changes.push(...batch);
    });

    counter.label = 'after';
    await counter.save();
    await nextTurn();

    assert.deepEqual(
      changes.map((change) => [change.operation, change.id]),
      [['update', String(counter.id)]],
    );
  });

  it('Model.update(criteria, set) is captured', async (t) => {
    const Counter = makeCounter();
    const dataSource = await openMatrixDataSource(t, { entities: [Counter] });
    const counter = await Counter.create({ label: 'before' }).save();
    const changes: LiveChange[] = [];
    dataSource.liveCapture.setListener((batch) => {
      changes.push(...batch);
    });

    await Counter.update({ id: counter.id }, { label: 'after' });
    await nextTurn();

    assert.deepEqual(
      changes.map((change) => [change.operation, change.id]),
      [['update', String(counter.id)]],
      'the committed update reached no live subscriber',
    );
  });

  it('repository.increment is captured', async (t) => {
    const Counter = makeCounter();
    const dataSource = await openMatrixDataSource(t, { entities: [Counter] });
    const counter = await Counter.create({ label: 'counted' }).save();
    const changes: LiveChange[] = [];
    dataSource.liveCapture.setListener((batch) => {
      changes.push(...batch);
    });

    await dataSource.getRepository(Counter).increment({ id: counter.id }, 'hits', 1);
    await nextTurn();

    assert.deepEqual(
      changes.map((change) => [change.operation, change.id]),
      [['update', String(counter.id)]],
      'the committed increment reached no live subscriber',
    );
  });
});
