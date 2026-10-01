/**
 * The change feed of a data source on the run's driver: key-only records of
 * record writes and set writes, delivered at once outside a transaction and
 * after the outermost commit inside one, coalesced per commit, dropped with a
 * rollback (a savepoint's own records only), scoped to a subscription's
 * models, keyed by primary key when the condition names it and
 * `invalidate` otherwise (a foreign-key action included), and isolated from
 * listener failures.
 */

import assert from 'node:assert/strict';
import { before, beforeEach, it } from 'node:test';

import { insertAll, query, type JsailsDataSource } from '../../src/index.js';
import { forEachDriver } from '../../src/testing/index.js';
import { suiteLifecycle } from '../query/fixtures/open-data-source.js';
import { describeRecord, openWriteSource, recordChanges } from './fixtures/open-write-source.js';
import {
  Log,
  Member,
  Note,
  PIPELINE_MODELS,
  resetHooks,
  Squad,
  Task,
  Team,
} from './fixtures/pipeline-models.js';

void forEachDriver('the change feed', () => {
  const lifecycle = suiteLifecycle();
  let dataSource: JsailsDataSource;

  before(async () => {
    dataSource = await openWriteSource(lifecycle, PIPELINE_MODELS);
  });

  beforeEach(async () => {
    await Member.all().deleteAll({ skipHooks: true });
    await Note.all().deleteAll();
    await Log.all().deleteAll();
    await Team.all().deleteAll();
    await Task.all().deleteAll();
    await Squad.all().deleteAll();
    resetHooks();
  });

  it('reports each record write by key, at once outside a transaction', async () => {
    const changes = recordChanges(dataSource);
    try {
      const task = await Task.create({ title: 'a' });
      assert.deepEqual(changes.take().map(describeRecord), [`insert wp_tasks ${task.id}`]);
      task.title = 'b';
      await task.save();
      assert.deepEqual(changes.take().map(describeRecord), [`update wp_tasks ${task.id}`]);
      await task.save();
      assert.deepEqual(changes.take(), [], 'a save with nothing to write reports nothing');
      await task.destroy();
      assert.deepEqual(changes.take().map(describeRecord), [`delete wp_tasks ${task.id}`]);
      assert.ok(changes.take().every((record) => Object.isFrozen(record)));
    } finally {
      changes.stop();
    }
  });

  it('reports a primary-key change as a delete and an insert', async () => {
    const changes = recordChanges(dataSource);
    try {
      const note = await Note.create({ body: 'moved' });
      changes.take();
      const old = note.id;
      note.id = old + 1000;
      await note.save();
      assert.deepEqual(changes.take().map(describeRecord), [
        `delete wp_notes ${old}`,
        `insert wp_notes ${old + 1000}`,
      ]);
    } finally {
      changes.stop();
    }
  });

  it('delivers after the outermost commit, coalesced, and drops rolled-back records', async () => {
    const changes = recordChanges(dataSource);
    try {
      const kept = await Task.create({ title: 'kept' });
      changes.take();
      let created = 0;
      await dataSource.transaction(async () => {
        const task = await Task.create({ title: 'new' });
        created = task.id;
        task.title = 'edited';
        await task.save();
        const fleeting = await Task.create({ title: 'fleeting' });
        await fleeting.destroy();
        kept.title = 'changed';
        await kept.save();
        await kept.reload();
        await assert.rejects(
          dataSource.transaction(async () => {
            await Note.create({ body: 'savepoint' });
            throw new Error('inner');
          }),
          /inner/,
        );
        assert.equal(changes.batches.length, 0, 'nothing before the commit');
      });
      assert.equal(changes.batches.length, 1, 'one batch per commit');
      assert.deepEqual(changes.take().map(describeRecord), [
        `insert wp_tasks ${created}`,
        `update wp_tasks ${kept.id}`,
      ]);

      await assert.rejects(
        dataSource.transaction(async () => {
          await Task.create({ title: 'rolled back' });
          throw new Error('outer');
        }),
        /outer/,
      );
      assert.deepEqual(changes.take(), []);
    } finally {
      changes.stop();
    }
  });

  it('keys a set write by its primary-key condition, and invalidates otherwise', async () => {
    const tasks = await Promise.all(['a', 'b', 'c'].map((title) => Task.create({ title })));
    const [a, b] = tasks as [Task, Task, Task];
    const changes = recordChanges(dataSource);
    try {
      await Task.where({ id: [a.id, b.id] }).updateAll({ title: 'x' });
      // The tasks were created concurrently, so either may hold the lower key.
      assert.deepEqual(
        changes.take().map(describeRecord).toSorted(),
        [`update wp_tasks ${a.id}`, `update wp_tasks ${b.id}`].toSorted(),
      );
      await Task.where({ title: 'x' }).updateAll({ title: 'y' });
      assert.deepEqual(changes.take().map(describeRecord), ['invalidate wp_tasks']);
      await Task.where({ title: 'none' }).updateAll({ title: 'z' });
      assert.deepEqual(changes.take(), [], 'a write that matched nothing reports nothing');
      await Task.where({ id: a.id }).deleteAll();
      assert.deepEqual(changes.take().map(describeRecord), [`delete wp_tasks ${a.id}`]);
      const inserted = await insertAll(Note, [{ body: 'one' }, { body: 'two' }]);
      assert.equal(inserted.affected, 2);
      const notes = await Note.all().orderBy('id').getMany();
      assert.deepEqual(
        changes.take().map(describeRecord),
        notes.map((note) => `insert wp_notes ${note.id}`),
      );
    } finally {
      changes.stop();
    }
  });

  it('reports what a foreign-key action and an effect changed', async () => {
    const team = await Team.create({ name: 'T' });
    const member = await Member.create({ name: 'm', teamId: team.id });
    await Note.create({ body: 'n', teamId: team.id });
    await Log.create({ line: 'l', teamId: team.id });
    const changes = recordChanges(dataSource);
    try {
      await Member.create({ name: 'counted', teamId: team.id });
      const inserted = changes.take().map(describeRecord);
      assert.equal(inserted.length, 2);
      assert.ok(inserted.includes(`update wp_teams ${team.id}`), 'the counter write');
      await team.destroy();
      assert.deepEqual(changes.take().map(describeRecord).toSorted(), [
        `delete wp_teams ${team.id}`,
        'invalidate wp_logs',
        'invalidate wp_members',
        'invalidate wp_notes',
      ]);
      assert.equal((await Member.find(member.id)).teamId, null);
    } finally {
      changes.stop();
    }
  });

  it('scopes a subscription to its models, read at each delivery', async () => {
    const models = new Set<typeof Task | typeof Note>([Task]);
    const received: string[] = [];
    const stop = dataSource.changes.subscribe(
      (records) => received.push(...records.map(describeRecord)),
      { models: () => models, onError: (error) => assert.fail(String(error)) },
    );
    try {
      await Note.create({ body: 'unseen' });
      assert.deepEqual(received, []);
      models.add(Note);
      const note = await Note.create({ body: 'seen' });
      assert.deepEqual(received, [`insert wp_notes ${note.id}`]);
    } finally {
      stop();
      stop();
    }
    await Note.create({ body: 'after unsubscribe' });
    assert.equal(received.length, 1);
  });

  it('hands listener failures to onError, never to the write', async () => {
    const errors: unknown[] = [];
    const stopThrowing = dataSource.changes.subscribe(
      () => {
        throw new Error('listener threw');
      },
      { models: () => new Set([Task]), onError: (error) => errors.push(error) },
    );
    let rejected!: () => void;
    const settled = new Promise<void>((resolve) => {
      rejected = resolve;
    });
    const stopRejecting = dataSource.changes.subscribe(
      () => Promise.reject(new Error('listener rejected')),
      {
        models: () => new Set([Task]),
        onError: (error) => {
          errors.push(error);
          rejected();
        },
      },
    );
    try {
      const task = await Task.create({ title: 'written' });
      await settled;
      assert.equal((await Task.find(task.id)).title, 'written');
      assert.deepEqual(errors.map((error) => (error as Error).message).toSorted(), [
        'listener rejected',
        'listener threw',
      ]);
      assert.throws(() => dataSource.changes.subscribe('nope' as never, {} as never), {
        code: 'data_source.invalid_options',
        context: { field: 'listener' },
      });
      assert.throws(
        () => dataSource.changes.subscribe(() => undefined, { models: () => new Set() } as never),
        { code: 'data_source.invalid_options', context: { field: 'subscription' } },
      );
    } finally {
      stopThrowing();
      stopRejecting();
    }
  });

  it('folds the key records of a commit into its invalidate of the same collection', async () => {
    const changes = recordChanges(dataSource);
    try {
      const first = await Task.create({ title: 'p' });
      changes.take();
      await dataSource.transaction(async () => {
        await query(Task).where({ id: first.id }).updateAll({ title: 'q' });
        await Task.all().updateAll({ title: 'r' });
      });
      assert.deepEqual(changes.take().map(describeRecord), ['invalidate wp_tasks']);
    } finally {
      changes.stop();
    }
  });
});
