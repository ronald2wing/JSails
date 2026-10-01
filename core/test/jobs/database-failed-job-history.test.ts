/**
 * Tests for `createDatabaseFailedJobHistory` and the `jsails_failed_job`
 * entity, against a real on-disk sql.js database whose table is created by
 * the declarative schema history, never by the history itself.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { JsailsDataSource } from '../../src/database/data-source.js';
import { diffSchemaStates } from '../../src/migrations/autodetector.js';
import { createDatabaseFailedJobHistory } from '../../src/jobs/database-failed-job-history.js';
import {
  FAILED_JOB_TABLE,
  JsailsFailedJob,
  failedJobEntities,
} from '../../src/jobs/failed-job-entity.js';
import {
  FailedJobHistoryError,
  type FailedJobRecordInput,
} from '../../src/jobs/failed-job-history.js';
import { createEmptyDataSource } from '../../src/testing/index.js';

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'jobs-failed-history-db-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function input(overrides: Partial<FailedJobRecordInput> = {}): FailedJobRecordInput {
  return {
    queue: 'default',
    name: 'sendEmail',
    data: { to: 'a@example.com', tags: ['x'] },
    error: { name: 'MailError', code: 'io_failed', message: 'smtp down' },
    attempts: 3,
    failedAt: new Date('2026-01-01T00:00:00.000Z'),
    requestId: 'req-1',
    ...overrides,
  };
}

describe('JsailsFailedJob entity', () => {
  it('is the only entity in failedJobEntities and plans one create_table', async () => {
    assert.deepEqual(failedJobEntities, [JsailsFailedJob]);
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'schema.db'),
      entities: [...failedJobEntities],
    });
    const schema = await dataSource.getModelSchema();
    const operations = diffSchemaStates({ tables: [] }, schema);
    assert.equal(operations.length, 1);
    const operation = operations[0];
    assert.ok(operation !== undefined && operation.kind === 'create_table');
    assert.equal(operation.table.name, FAILED_JOB_TABLE);
    assert.deepEqual(operation.table.columns.map((column) => column.name).sort(), [
      'attempts',
      'dispatchOptions',
      'errorCode',
      'errorMessage',
      'errorName',
      'failedAt',
      'id',
      'membership',
      'name',
      'payload',
      'queue',
      'requestId',
      'tags',
    ]);
  });
});

describe('createDatabaseFailedJobHistory', () => {
  it('records, reads back, lists newest first, and filters by queue', async () => {
    const dataSource = await createEmptyDataSource([...failedJobEntities], {
      location: join(tmpRoot, 'roundtrip.db'),
    });
    const history = createDatabaseFailedJobHistory({ dataSource });

    const first = await history.record(input());
    await history.record(input({ queue: 'mail', name: 'digest', requestId: undefined }));
    await history.record(input({ name: 'third', error: { name: 'Error', message: 'x' } }));

    assert.equal(first.id, '1');
    const read = await history.get(first.id);
    assert.ok(read);
    assert.equal(read.queue, 'default');
    assert.equal(read.name, 'sendEmail');
    assert.deepEqual(read.data, { to: 'a@example.com', tags: ['x'] });
    assert.equal(read.error, 'smtp down');
    assert.equal(read.errorName, 'MailError');
    assert.equal(read.errorCode, 'io_failed');
    assert.equal(read.attempts, 3);
    assert.equal(read.requestId, 'req-1');
    assert.equal(read.failedAt.toISOString(), '2026-01-01T00:00:00.000Z');

    assert.deepEqual(
      (await history.list()).map((entry) => entry.name),
      ['third', 'digest', 'sendEmail'],
    );
    assert.deepEqual(
      (await history.list({ queue: 'mail' })).map((entry) => entry.name),
      ['digest'],
    );
    assert.deepEqual(
      (await history.list({ limit: 1 })).map((entry) => entry.name),
      ['third'],
    );
    const digest = (await history.list({ queue: 'mail' }))[0];
    assert.equal(digest?.requestId, undefined);

    await dataSource.destroy();
  });

  it('round-trips monitoring tags and stores none as absent', async () => {
    const dataSource = await createEmptyDataSource([...failedJobEntities], {
      location: join(tmpRoot, 'tags.db'),
    });
    const history = createDatabaseFailedJobHistory({ dataSource });
    const tagged = await history.record(input({ tags: ['tenant:1', 'mail'] }));
    const plain = await history.record(input());

    assert.deepEqual(tagged.tags, ['tenant:1', 'mail']);
    assert.deepEqual((await history.get(tagged.id))?.tags, ['tenant:1', 'mail']);
    assert.equal((await history.get(plain.id))?.tags, undefined);
    await dataSource.destroy();
  });

  it('round-trips the replayed dispatch options and the membership', async () => {
    const dataSource = await createEmptyDataSource([...failedJobEntities], {
      location: join(tmpRoot, 'options.db'),
    });
    const history = createDatabaseFailedJobHistory({ dataSource });
    const recorded = await history.record(
      input({
        options: { attempts: 4, priority: 2, delay: 500, jobId: 'x' },
        membership: ['chain'],
      }),
    );
    const plain = await history.record(input());

    const read = await history.get(recorded.id);
    assert.deepEqual(read?.options, { attempts: 4, priority: 2 });
    assert.deepEqual(read?.membership, ['chain']);
    assert.equal((await history.get(plain.id))?.options, undefined);
    assert.equal((await history.get(plain.id))?.membership, undefined);
    await dataSource.destroy();
  });

  it('takes an entry for one caller only and restores it under its id', async () => {
    const dataSource = await createEmptyDataSource([...failedJobEntities], {
      location: join(tmpRoot, 'take.db'),
    });
    const history = createDatabaseFailedJobHistory({ dataSource });
    await history.record(input({ name: 'older' }));
    const recorded = await history.record(input({ options: { attempts: 2 } }));
    await history.record(input({ name: 'newer' }));

    const [first, second] = await Promise.all([
      history.take(recorded.id),
      history.take(recorded.id),
    ]);
    const taken = first ?? second;
    assert.ok(taken !== undefined);
    assert.equal([first, second].filter((entry) => entry !== undefined).length, 1);
    assert.equal(await history.get(recorded.id), undefined);
    assert.equal(await history.take('999'), undefined);

    const restored = await history.restore(taken);
    assert.equal(restored.id, recorded.id);
    assert.deepEqual(await history.get(recorded.id), recorded);
    assert.deepEqual(
      (await history.list()).map((entry) => entry.name),
      ['newer', 'sendEmail', 'older'],
    );
    await dataSource.destroy();
  });

  it('pages older entries with the beforeId cursor', async () => {
    const dataSource = await createEmptyDataSource([...failedJobEntities], {
      location: join(tmpRoot, 'cursor.db'),
    });
    const history = createDatabaseFailedJobHistory({ dataSource });
    for (const queue of ['a', 'b', 'a', 'b', 'a']) await history.record(input({ queue }));

    const ids = async (options: Parameters<typeof history.list>[0]): Promise<string[]> =>
      (await history.list(options)).map((entry) => entry.id);
    assert.deepEqual(await ids({ beforeId: '4', limit: 2 }), ['3', '2']);
    assert.deepEqual(await ids({ beforeId: '5', queue: 'a' }), ['3', '1']);
    assert.deepEqual(await ids({ beforeId: '99' }), ['5', '4', '3', '2', '1']);
    assert.deepEqual(await ids({ beforeId: '1' }), []);
    assert.deepEqual(await ids({ beforeId: 'nope' }), []);
    await dataSource.destroy();
  });

  it('removes one entry and clears by queue or entirely', async () => {
    const dataSource = await createEmptyDataSource([...failedJobEntities], {
      location: join(tmpRoot, 'remove.db'),
    });
    const history = createDatabaseFailedJobHistory({ dataSource });
    await history.record(input({ queue: 'mail' }));
    await history.record(input());
    await history.record(input({ queue: 'mail' }));

    assert.equal(await history.remove('2'), true);
    assert.equal(await history.remove('2'), false);
    assert.equal(await history.remove('not-an-id'), false);
    assert.equal(await history.get('0'), undefined);
    assert.equal(await history.clear({ queue: 'other' }), 0);
    assert.equal(await history.clear({ queue: 'mail' }), 2);
    await history.record(input());
    assert.equal(await history.clear(), 1);
    assert.deepEqual(await history.list(), []);

    await dataSource.destroy();
  });

  it('stores a payload that is not JSON-serializable as null and still records', async () => {
    const dataSource = await createEmptyDataSource([...failedJobEntities], {
      location: join(tmpRoot, 'payload.db'),
    });
    const history = createDatabaseFailedJobHistory({ dataSource });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const entry = await history.record(input({ data: circular }));
    assert.equal((await history.get(entry.id))?.data, undefined);
    await dataSource.destroy();
  });

  it('fails value-free when the table is missing and never creates it', async () => {
    const dataSource = await createEmptyDataSource([...failedJobEntities], {
      location: join(tmpRoot, 'missing.db'),
      migrate: false,
    });
    const history = createDatabaseFailedJobHistory({ dataSource });
    await assert.rejects(history.record(input()), (error: unknown) => {
      assert.ok(error instanceof FailedJobHistoryError);
      assert.equal(error.code, 'missing_table');
      assert.doesNotMatch(error.message, /a@example\.com/);
      return true;
    });
    const runner = dataSource.createQueryRunner();
    assert.equal(await runner.hasTable(FAILED_JOB_TABLE), false);
    await runner.release();
    await dataSource.destroy();
  });

  it('initializes a lazy data source on first use and destroys it on close', async () => {
    const location = join(tmpRoot, 'lazy.db');
    const seed = await createEmptyDataSource([...failedJobEntities], { location });
    await seed.destroy();

    const lazy = new JsailsDataSource({
      type: 'sqljs',
      location,
      entities: [...failedJobEntities],
    });
    const history = createDatabaseFailedJobHistory({ getDataSource: () => lazy });
    assert.equal(lazy.isInitialized, false);
    await history.record(input());
    assert.equal(lazy.isInitialized, true);
    await history.close?.();
    assert.equal(lazy.isInitialized, false);
  });

  it('leaves a caller-owned data source open on close and requires it initialized', async () => {
    const dataSource = await createEmptyDataSource([...failedJobEntities], {
      location: join(tmpRoot, 'owned.db'),
    });
    const history = createDatabaseFailedJobHistory({ dataSource });
    await history.list();
    await history.close?.();
    assert.equal(dataSource.isInitialized, true);
    await dataSource.destroy();

    const uninitialized = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'uninit.db'),
      entities: [...failedJobEntities],
    });
    await assert.rejects(
      createDatabaseFailedJobHistory({ dataSource: uninitialized }).list(),
      (error: unknown) =>
        error instanceof FailedJobHistoryError && error.code === 'missing_data_source',
    );
  });

  it('requires exactly one data source option', () => {
    assert.throws(
      () => createDatabaseFailedJobHistory({}),
      (error: unknown) =>
        error instanceof FailedJobHistoryError && error.code === 'missing_data_source',
    );
  });
});
