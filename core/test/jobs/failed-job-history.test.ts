/** Tests for the failed-job history contract helpers and `InMemoryFailedJobHistory`. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_JOB_ERROR_MESSAGE } from '../../src/jobs/events.js';
import {
  DEFAULT_FAILED_JOB_HISTORY_ENTRIES,
  DEFAULT_FAILED_JOB_LIST_LIMIT,
  FailedJobHistoryError,
  InMemoryFailedJobHistory,
  MAX_FAILED_JOB_LIST_LIMIT,
  isFailedJobHistory,
  jobMembership,
  replayableJobOptions,
  resolveFailedJobListLimit,
  retryFailedJob,
  type FailedJobRecordInput,
} from '../../src/jobs/failed-job-history.js';
import { FailedJobNotFoundError } from '../../src/jobs/failed-jobs.js';

function input(overrides: Partial<FailedJobRecordInput> = {}): FailedJobRecordInput {
  return {
    queue: 'default',
    name: 'sendEmail',
    data: { to: 'a@example.com' },
    error: { name: 'Error', message: 'boom' },
    attempts: 3,
    failedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('InMemoryFailedJobHistory', () => {
  it('records an entry with an assigned id, the payload as given, and the error summary', async () => {
    const history = new InMemoryFailedJobHistory();
    const data = { to: 'a@example.com', nested: { n: 1 } };
    const entry = await history.record(
      input({
        data,
        error: { name: 'MailError', code: 'io_failed', message: 'smtp down' },
        requestId: 'req-1',
      }),
    );
    assert.equal(entry.id, '1');
    assert.equal(entry.queue, 'default');
    assert.equal(entry.name, 'sendEmail');
    assert.equal(entry.data, data);
    assert.equal(entry.error, 'smtp down');
    assert.equal(entry.errorName, 'MailError');
    assert.equal(entry.errorCode, 'io_failed');
    assert.equal(entry.requestId, 'req-1');
    assert.equal(entry.attempts, 3);
    assert.deepEqual(await history.get('1'), entry);
    assert.deepEqual(history.store.list(), [entry]);
  });

  it('caps an over-long error message to the runtime bound', async () => {
    const history = new InMemoryFailedJobHistory();
    const entry = await history.record(
      input({ error: { name: 'Error', message: 'x'.repeat(5000) } }),
    );
    assert.equal(entry.error.length, MAX_JOB_ERROR_MESSAGE + 1);
  });

  it('is bounded: the oldest entry is evicted past maxEntries (default 1000)', async () => {
    assert.equal(DEFAULT_FAILED_JOB_HISTORY_ENTRIES, 1000);
    const history = new InMemoryFailedJobHistory({ maxEntries: 2 });
    await history.record(input({ name: 'a' }));
    await history.record(input({ name: 'b' }));
    await history.record(input({ name: 'c' }));
    const names = (await history.list()).map((entry) => entry.name);
    assert.deepEqual(names, ['c', 'b']);
    assert.equal(await history.get('1'), undefined);
  });

  it('drops entries older than maxAgeMs', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const history = new InMemoryFailedJobHistory({ maxAgeMs: 1000, now: () => now });
    await history.record(input({ failedAt: new Date(now) }));
    now += 5000;
    assert.deepEqual(await history.list(), []);
  });

  it('lists newest first, filtered by queue and bounded by limit', async () => {
    const history = new InMemoryFailedJobHistory();
    await history.record(input({ queue: 'mail', name: 'a' }));
    await history.record(input({ queue: 'default', name: 'b' }));
    await history.record(input({ queue: 'mail', name: 'c' }));
    assert.deepEqual(
      (await history.list()).map((entry) => entry.name),
      ['c', 'b', 'a'],
    );
    assert.deepEqual(
      (await history.list({ queue: 'mail' })).map((entry) => entry.name),
      ['c', 'a'],
    );
    assert.deepEqual(
      (await history.list({ limit: 1 })).map((entry) => entry.name),
      ['c'],
    );
  });

  it('removes and clears, optionally by queue', async () => {
    const history = new InMemoryFailedJobHistory();
    await history.record(input({ queue: 'mail' }));
    await history.record(input({ queue: 'default' }));
    await history.record(input({ queue: 'mail' }));
    assert.equal(await history.remove('2'), true);
    assert.equal(await history.remove('2'), false);
    assert.equal(await history.clear({ queue: 'mail' }), 2);
    await history.record(input());
    assert.equal(await history.clear(), 1);
    assert.deepEqual(await history.list(), []);
  });

  it('rejects malformed record input value-free', async () => {
    const history = new InMemoryFailedJobHistory();
    for (const bad of [
      input({ queue: '' }),
      input({ name: '' }),
      input({ attempts: 1.5 }),
      input({ failedAt: new Date(Number.NaN) }),
      { ...input(), error: 'boom' } as unknown as FailedJobRecordInput,
      { ...input(), tags: [1] } as unknown as FailedJobRecordInput,
    ]) {
      await assert.rejects(history.record(bad), (error: unknown) => {
        assert.ok(error instanceof FailedJobHistoryError);
        assert.equal(error.code, 'invalid_entry');
        assert.doesNotMatch(error.message, /a@example\.com/);
        return true;
      });
    }
  });
});

describe('resolveFailedJobListLimit', () => {
  it('defaults and bounds the listing size', () => {
    assert.equal(resolveFailedJobListLimit(undefined), DEFAULT_FAILED_JOB_LIST_LIMIT);
    assert.equal(resolveFailedJobListLimit(MAX_FAILED_JOB_LIST_LIMIT), MAX_FAILED_JOB_LIST_LIMIT);
    for (const bad of [0, -1, 1.5, MAX_FAILED_JOB_LIST_LIMIT + 1, '5']) {
      assert.throws(
        () => resolveFailedJobListLimit(bad),
        (error: unknown) =>
          error instanceof FailedJobHistoryError && error.code === 'invalid_limit',
      );
    }
  });
});

describe('retryFailedJob', () => {
  it('dispatches the entry and leaves it out of the history', async () => {
    const history = new InMemoryFailedJobHistory();
    const recorded = await history.record(input());
    const dispatched: unknown[] = [];
    const result = await retryFailedJob(history, recorded.id, (found) => {
      dispatched.push([found.name, found.data]);
    });
    assert.equal(result.status, 'dispatched');
    assert.equal(result.entry.id, recorded.id);
    assert.deepEqual(dispatched, [['sendEmail', { to: 'a@example.com' }]]);
    assert.equal(await history.get(recorded.id), undefined);
  });

  it('dispatches an entry once when two retries of it run at the same time', async () => {
    const history = new InMemoryFailedJobHistory();
    const recorded = await history.record(input());
    let dispatches = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = async (): Promise<void> => {
      dispatches += 1;
      await gate;
    };

    const first = retryFailedJob(history, recorded.id, dispatch);
    const second = retryFailedJob(history, recorded.id, dispatch);
    const secondOutcome = assert.rejects(second, FailedJobNotFoundError);
    release();

    assert.equal((await first).status, 'dispatched');
    await secondOutcome;
    assert.equal(dispatches, 1);
  });

  it('puts the entry back under its id when the dispatch fails', async () => {
    const history = new InMemoryFailedJobHistory();
    const older = await history.record(input({ name: 'older' }));
    const recorded = await history.record(input());
    await history.record(input({ name: 'newer' }));
    const failure = new Error('down');

    const result = await retryFailedJob(history, recorded.id, () => Promise.reject(failure));

    assert.equal(result.status, 'restored');
    assert.equal(result.status === 'restored' ? result.dispatchError : undefined, failure);
    assert.equal(result.entry.id, recorded.id);
    assert.deepEqual(await history.get(recorded.id), recorded);
    assert.deepEqual(
      (await history.list()).map((entry) => entry.name),
      ['newer', 'sendEmail', 'older'],
      'the restored entry keeps its place in the listing order',
    );
    assert.deepEqual(
      (await history.list({ beforeId: recorded.id })).map((entry) => entry.id),
      [older.id],
    );
  });

  it('reports an entry it could not put back instead of rejecting', async () => {
    const history = new InMemoryFailedJobHistory();
    const recorded = await history.record(input());
    const restoreFailure = new Error('connection lost');
    history.restore = () => Promise.reject(restoreFailure);

    const result = await retryFailedJob(history, recorded.id, () => {
      throw new Error('down');
    });

    assert.equal(result.status, 'lost');
    assert.equal(result.status === 'lost' ? result.restoreError : undefined, restoreFailure);
    assert.deepEqual(result.entry, recorded, 'the caller holds the only copy');
  });

  it('rejects an unknown id with FailedJobNotFoundError', async () => {
    const history = new InMemoryFailedJobHistory();
    await assert.rejects(
      retryFailedJob(history, '42', () => undefined),
      FailedJobNotFoundError,
    );
  });
});

describe('replayed dispatch options and membership', () => {
  it('keeps the options a retry replays and drops delay, job id, and descriptors', () => {
    assert.deepEqual(
      replayableJobOptions({
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        priority: 3,
        lifo: true,
        delay: 60_000,
        jobId: 'dedupe-1',
        __jsailsChain: { steps: [] },
        __jsailsBatch: { id: 'b', total: 2, index: 0 },
        __jsailsOverlap: { key: 'x' },
        __jsailsRequestId: 'req-1',
        timestamp: 123,
      }),
      { attempts: 5, backoff: { type: 'exponential', delay: 1000 }, priority: 3, lifo: true },
    );
    assert.equal(replayableJobOptions({ delay: 5, jobId: 'x' }), undefined);
    assert.deepEqual(replayableJobOptions({ attempts: 0, priority: 2 }), { priority: 2 });
  });

  it('names the chain and batch a job belonged to', () => {
    assert.deepEqual(jobMembership({ __jsailsChain: {}, __jsailsBatch: {} }), ['chain', 'batch']);
    assert.equal(jobMembership({ attempts: 3 }), undefined);
  });

  it('stores re-picked options, never a delay or job id from a hand-built input', async () => {
    const history = new InMemoryFailedJobHistory();
    const entry = await history.record(
      input({
        options: { attempts: 4, delay: 1000, jobId: 'x' },
        membership: ['batch'],
      }),
    );
    assert.deepEqual(entry.options, { attempts: 4 });
    assert.deepEqual(entry.membership, ['batch']);
    await assert.rejects(
      history.record(input({ membership: ['group' as 'chain'] })),
      FailedJobHistoryError,
    );
  });
});

describe('InMemoryFailedJobHistory: beforeId cursor', () => {
  it('lists only entries recorded before the cursor, even after it was removed', async () => {
    const history = new InMemoryFailedJobHistory();
    for (const queue of ['a', 'b', 'a', 'b', 'a']) await history.record(input({ queue }));
    await history.remove('4');

    const ids = async (beforeId: string, queue?: string): Promise<string[]> =>
      (await history.list({ beforeId, ...(queue === undefined ? {} : { queue }) })).map(
        (entry) => entry.id,
      );
    assert.deepEqual(await ids('4'), ['3', '2', '1']);
    assert.deepEqual(await ids('5', 'a'), ['3', '1']);
    assert.deepEqual(await ids('1'), []);
    assert.deepEqual(await ids('x'), []);
    await assert.rejects(
      history.list({ beforeId: 4 as unknown as string }),
      (error: unknown) => error instanceof FailedJobHistoryError && error.code === 'invalid_cursor',
    );
  });
});

describe('isFailedJobHistory', () => {
  it('accepts the contract shape and rejects anything else', () => {
    assert.equal(isFailedJobHistory(new InMemoryFailedJobHistory()), true);
    assert.equal(isFailedJobHistory(null), false);
    assert.equal(isFailedJobHistory({ record() {}, list() {} }), false);
    assert.equal(
      isFailedJobHistory({
        record() {},
        list() {},
        get() {},
        remove() {},
        clear() {},
        close: 'no',
      }),
      false,
    );
    assert.equal(
      isFailedJobHistory({ record() {}, list() {}, get() {}, remove() {}, clear() {} }),
      false,
      'a history without take/restore cannot claim an entry before retrying it',
    );
  });
});
