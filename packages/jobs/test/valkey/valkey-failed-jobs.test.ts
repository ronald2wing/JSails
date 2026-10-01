/**
 * Failed jobs on the Valkey transport over a fake BullMQ, whose script
 * replies stand for the server: the list merges each queue's page newest
 * first and leaves out what retention no longer reports; `get`, `retry`,
 * `remove` and `prune` find a job on any declared queue and map what BullMQ
 * answers; and a batch child's retry tells its batch before and after the
 * move.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { FailedJobsCapability } from '../../src/contract/index.js';
import { runtimeSummary } from '../../src/errors/error-summary.js';
import { encodeFailure } from '../../src/valkey/failure-record.js';
import { fakeJob, type FakeBackend } from './fake-bullmq.js';
import { envelope, fakeAdapter, refused } from './fixtures/fake-adapter.js';

const DAY_MS = 86_400_000;
const error = runtimeSummary('attempt_timeout');

async function failedOf() {
  const fake = await fakeAdapter({ mail: { retention: { failed: { age: '1d' } } } });
  return { ...fake, failedJobs: fake.adapter.capabilities.failedJobs! };
}

/** A failed-page entry: id, failure time, stored data, reason. */
function entry(id: string, failedAt: number, data = JSON.stringify(envelope({ name: id }))) {
  return [id, String(failedAt), data, encodeFailure(id, error)];
}

/** Answer the find script as the server would for job `id` found on the queue at `position`. */
function finds(
  backend: FakeBackend,
  found: readonly unknown[],
  others: (script: string, args: readonly unknown[]) => unknown = () => 1,
): void {
  backend.scriptReply = (script, _keys, args) =>
    script === 'findJob' ? found : others(script, args);
}

describe('list', () => {
  test('merges every queue newest first, leaving out what retention no longer reports', async () => {
    const { backend, adapter, failedJobs } = await failedOf();
    const now = Date.now();
    backend.scriptReply = (_script, keys) =>
      keys[0] === 'app:test:jobs:default:failed'
        ? [...entry('d-new', now - 1_000), ...entry('d-old', now - 2 * DAY_MS)]
        : [
            ...entry('m-mid', now - 5_000),
            ...entry('m-gone', now - 2 * DAY_MS),
            ...entry('m-evicted', now - 2_000, ''),
          ];
    const listed = await failedJobs.list();
    assert.deepEqual(
      listed.map((job) => [job.id, job.queue]),
      [
        ['d-new', 'default'],
        ['m-mid', 'mail'],
        ['d-old', 'default'],
      ],
      'mail keeps failures one day, default seven; a job with no data is gone',
    );
    assert.deepEqual(listed[0]?.error, error);
    assert.equal(listed[0]?.envelope.name, 'd-new');
    assert.deepEqual(
      backend.scriptCalls.map((call) => [call.keys[0], ...call.args]),
      [
        ['app:test:jobs:default:failed', '+inf', 50, 'app:test:jobs:default:'],
        ['app:test:jobs:mail:failed', '+inf', 50, 'app:test:jobs:mail:'],
      ],
    );
    await adapter.close();
  });

  test('pages from a cursor on one queue, keeping only jobs after it, up to the limit', async () => {
    const { backend, adapter, failedJobs } = await failedOf();
    const at = Date.now() - 10_000;
    backend.scriptReply = () => [
      ...entry('b', at),
      ...entry('a', at),
      ...entry('c', at - 1),
      ...entry('d', at - 2),
    ];
    const listed = await failedJobs.list({
      queue: 'mail',
      limit: 2,
      before: { failedAt: at, id: 'b' },
    });
    assert.deepEqual(
      listed.map((job) => job.id),
      ['a', 'c'],
    );
    assert.deepEqual(backend.scriptCalls[0]!.args, [at, 2, 'app:test:jobs:mail:']);
    assert.equal(backend.scriptCalls.length, 1);
    await adapter.close();
  });

  test('refuses an undeclared queue', async () => {
    const { adapter, failedJobs } = await failedOf();
    await assert.rejects(failedJobs.list({ queue: 'audit' }), refused('unknown_queue'));
    await adapter.close();
  });
});

describe('get', () => {
  test('a failed job retention still reports, from whichever queue holds it', async () => {
    const { backend, adapter, failedJobs } = await failedOf();
    const failedAt = Date.now() - 1_000;
    finds(backend, [
      2,
      String(failedAt),
      JSON.stringify(envelope({ name: 'letter' })),
      encodeFailure('letter', error),
    ]);
    const job = await failedJobs.get('job-1');
    assert.equal(job?.queue, 'mail');
    assert.equal(job?.failedAt, failedAt);
    assert.equal(job?.envelope.name, 'letter');
    assert.deepEqual(backend.scriptCalls[0]!.args, [
      'job-1',
      'app:test:jobs:default:',
      'app:test:jobs:mail:',
    ]);
    await adapter.close();
  });

  test('undefined for a job no queue holds, one not failed, one past retention or with no data', async () => {
    const { backend, adapter, failedJobs } = await failedOf();
    const data = JSON.stringify(envelope());
    for (const found of [
      [0],
      [1, '', data, ''],
      [2, String(Date.now() - 2 * DAY_MS), data, ''],
      [1, String(Date.now()), '', ''],
    ]) {
      finds(backend, found);
      assert.equal(await failedJobs.get('job-1'), undefined);
    }
    const calls = backend.scriptCalls.length;
    assert.equal(await failedJobs.get(''), undefined);
    assert.equal(backend.scriptCalls.length, calls, 'an empty id reaches no script');
    await adapter.close();
  });
});

describe('retry', () => {
  const failedNow = (data: string = JSON.stringify(envelope())) => [
    1,
    String(Date.now() - 1_000),
    data,
    encodeFailure('job', error),
  ];

  test('resets the counts, then has BullMQ move the job back with its attempts reset', async () => {
    const { backend, adapter, failedJobs } = await failedOf();
    const job = fakeJob(envelope());
    backend.jobs.set('default:job-1', job);
    finds(backend, failedNow());
    assert.equal(await failedJobs.retry('job-1'), 'retried');
    const reset = backend.scriptCalls.find((call) => call.script === 'resetCounts');
    assert.deepEqual(reset?.keys, ['app:test:jobs:default:failed', 'app:test:jobs:default:job-1']);
    assert.deepEqual(job.calls, [{ call: 'retry', state: 'failed' }]);
    await adapter.close();
  });

  test('maps what it finds: no job, a job not failed, past retention, not retryable', async () => {
    const { backend, adapter, failedJobs } = await failedOf();
    const retry = (found: readonly unknown[]): ReturnType<FailedJobsCapability['retry']> => {
      finds(backend, found);
      return failedJobs.retry('job-1');
    };
    assert.equal(await retry([0]), 'not_found');
    assert.equal(await retry([1, '', '{}', '']), 'not_failed');
    assert.equal(await retry([1, String(Date.now() - 8 * DAY_MS), '{}', '']), 'not_found');
    assert.equal(await retry(failedNow('not json')), 'not_retryable');
    assert.equal(await failedJobs.retry(''), 'not_found');
    assert.equal(
      backend.scriptCalls.some((call) => call.script === 'resetCounts'),
      false,
      'nothing is reset before the retry is known to proceed',
    );
    await adapter.close();
  });

  test('a chain step whose catch fired is retried only by force', async () => {
    const { backend, adapter, failedJobs } = await failedOf();
    backend.jobs.set('default:job-1', fakeJob(envelope()));
    const step = envelope({
      flow: { kind: 'chain', id: 'c1', step: 0, next: [], catchFired: true },
    });
    finds(backend, failedNow(JSON.stringify(step)));
    assert.equal(await failedJobs.retry('job-1'), 'not_retryable');
    assert.equal(await failedJobs.retry('job-1', { force: true }), 'retried');
    await adapter.close();
  });

  test('maps BullMQ refusing the move: gone is not_found, moved on is not_failed', async () => {
    const { backend, adapter, failedJobs } = await failedOf();
    finds(backend, failedNow());
    assert.equal(await failedJobs.retry('job-1'), 'not_found', 'getJob found nothing');
    const scriptError = (code: number) => Object.assign(new Error('script'), { code });
    backend.jobs.set('default:job-1', fakeJob(envelope(), { retryError: scriptError(-1) }));
    assert.equal(await failedJobs.retry('job-1'), 'not_found');
    backend.jobs.set('default:job-1', fakeJob(envelope(), { retryError: scriptError(-3) }));
    assert.equal(await failedJobs.retry('job-1'), 'not_failed');
    backend.jobs.set('default:job-1', fakeJob(envelope(), { retryError: new Error('reset') }));
    await assert.rejects(failedJobs.retry('job-1'), refused('transport_failed'));
    await adapter.close();
  });

  test('a batch child takes back its failure, and restores it when the move fails', async () => {
    const { backend, adapter, failedJobs } = await failedOf();
    const child = envelope({ flow: { kind: 'batch', id: 'b-1', index: 3 } });
    backend.jobs.set('default:bF.inc.3', fakeJob(child, { retryError: new Error('reset') }));
    finds(backend, failedNow(JSON.stringify(child)), (script) =>
      script === 'batchUnrecord' ? ['unrecorded', 'REC'] : [0],
    );
    await assert.rejects(failedJobs.retry('bF.inc.3'), refused('transport_failed'));
    const scripts = backend.scriptCalls.map((call) => call.script);
    assert.deepEqual(scripts, ['findJob', 'resetCounts', 'batchUnrecord', 'batchRecord']);
    assert.deepEqual(backend.scriptCalls[2]!.args, [3, 'bF.inc']);
    assert.deepEqual(backend.scriptCalls[3]!.args.slice(0, 2), [3, 'REC']);
    await adapter.close();
  });

  test('refuses options that are not { force: boolean }', async () => {
    const { adapter, failedJobs } = await failedOf();
    for (const [options, option] of [
      ['force', 'options'],
      [{ force: true, now: 1 }, 'options'],
      [{ force: 'yes' }, 'force'],
    ] as const) {
      await assert.rejects(
        failedJobs.retry('job-1', options as unknown as { force?: boolean }),
        refused('invalid_option', { option }),
      );
    }
    await adapter.close();
  });
});

describe('remove', () => {
  test('deletes a failed job retention still reports, its key kept', async () => {
    const { backend, adapter, failedJobs } = await failedOf();
    const failedAt = Date.now() - 1_000;
    finds(backend, [2, String(failedAt), '{}', '']);
    assert.equal(await failedJobs.remove('job-1'), true);
    const call = backend.scriptCalls.at(-1)!;
    assert.equal(call.script, 'removeFailed');
    assert.deepEqual(call.keys, [
      'app:test:jobs:mail:failed',
      'app:test:jobs:mail:job-1',
      'app:test:jobs:mail:job-1:logs',
    ]);
    assert.equal(call.args[0], 'job-1');
    assert.ok(Number(call.args[1]) <= Date.now() - DAY_MS);
    finds(backend, [2, String(failedAt), '{}', ''], () => 0);
    assert.equal(await failedJobs.remove('job-1'), false, 'the server found it gone');
    finds(backend, [0]);
    assert.equal(await failedJobs.remove('job-1'), false);
    await adapter.close();
  });
});

describe('prune', () => {
  test('deletes in chunks of 1,000 per queue until a chunk comes back short', async () => {
    const { backend, adapter, failedJobs } = await failedOf();
    const replies = [1_000, 3, 0];
    backend.scriptReply = () => replies.shift();
    const before = Date.now();
    assert.equal(await failedJobs.prune({ olderThanMs: DAY_MS }), 1_003);
    assert.deepEqual(
      backend.scriptCalls.map((call) => [call.keys[0], call.args[0], call.args[2]]),
      [
        ['app:test:jobs:default:failed', 'app:test:jobs:default:', 1_000],
        ['app:test:jobs:default:failed', 'app:test:jobs:default:', 1_000],
        ['app:test:jobs:mail:failed', 'app:test:jobs:mail:', 1_000],
      ],
    );
    assert.ok(Number(backend.scriptCalls[0]!.args[1]) >= before - DAY_MS);
    await assert.rejects(
      failedJobs.prune({ olderThanMs: -1 }),
      refused('invalid_option', { option: 'olderThanMs' }),
    );
    await adapter.close();
  });
});
