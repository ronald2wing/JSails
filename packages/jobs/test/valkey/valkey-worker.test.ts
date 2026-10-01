/**
 * One `startWorker` of the Valkey transport over a fake BullMQ: a close that
 * lands while the worker is still opening its dedicated connections leaves
 * no BullMQ worker and no connection behind, and refuses the start; a start
 * that fails closes what it opened; a batch child records under the
 * incarnation its own job id names; and the pure reads the worker builds on
 * (`batchMembershipOf`, `stalledOutcome`).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ProcessJob, SettleEvent } from '../../src/contract/index.js';
import { runtimeSummary } from '../../src/errors/error-summary.js';
import { BATCH_STATUS_RETENTION_MS } from '../../src/flows/flow-limits.js';
import { childJobId } from '../../src/valkey/key-layout.js';
import { batchMembershipOf, stalledOutcome, ValkeyWorker } from '../../src/valkey/valkey-worker.js';
import { fakeBackend, fakeJob, held, type FakeBackend } from './fake-bullmq.js';
import { envelope, fakeAdapter, refused } from './fixtures/fake-adapter.js';

const completing: ProcessJob = () => Promise.resolve({ kind: 'completed' });

/** A backend whose dedicated connection `name` is handed out only once the returned hold is released. */
function gatedConnect(name: string): {
  readonly backend: FakeBackend;
  readonly gate: ReturnType<typeof held<void>>;
} {
  const backend = fakeBackend();
  const gate = held<void>();
  backend.connectGate = (requested) => {
    if (requested !== name) return Promise.resolve();
    gate.reach();
    return gate.promise;
  };
  return { backend, gate };
}

describe('a close while a worker starts', () => {
  test('waits for the connection still opening, then closes everything the start opened', async () => {
    const { backend, gate } = gatedConnect('jobs-mail');
    const { adapter, reported } = await fakeAdapter({ mail: {} }, { backend });
    const refusedStart = assert.rejects(
      adapter.startWorker({ queues: ['default', 'mail'] }, completing),
      refused('adapter_closed'),
    );
    await gate.reached;
    const closing = adapter.close().then(() => {
      backend.events.push('adapter closed');
    });
    gate.release();
    await closing;
    await refusedStart;
    assert.deepEqual(
      backend.workers.map((worker) => [worker.queue, worker.closed]),
      [['default', true]],
      'no BullMQ worker is created on a queue whose connection opened after the close',
    );
    assert.deepEqual(
      backend.dedicated.map((entry) => [entry.name, entry.disconnected]),
      [
        ['jobs-default', true],
        ['jobs-mail', true],
      ],
    );
    assert.ok(
      backend.events.indexOf('disconnect jobs-mail') < backend.events.indexOf('adapter closed'),
      'the late connection is disconnected before the close resolves',
    );
    assert.deepEqual(reported, []);
  });

  test('during the first connection, opens no BullMQ worker at all', async () => {
    const { backend, gate } = gatedConnect('jobs-default');
    const { adapter } = await fakeAdapter({}, { backend });
    const refusedStart = assert.rejects(
      adapter.startWorker({ queues: ['default'] }, completing),
      refused('adapter_closed'),
    );
    await gate.reached;
    const closing = adapter.close();
    gate.release();
    await closing;
    await refusedStart;
    assert.deepEqual(backend.workers, []);
    assert.deepEqual(backend.dedicated, [{ name: 'jobs-default', disconnected: true }]);
  });

  test('a connection that then fails refuses the start as closed and reports nothing', async () => {
    const { backend, gate } = gatedConnect('jobs-mail');
    const { adapter, reported } = await fakeAdapter({ mail: {} }, { backend });
    const refusedStart = assert.rejects(
      adapter.startWorker({ queues: ['default', 'mail'] }, completing),
      refused('adapter_closed'),
    );
    await gate.reached;
    const closing = adapter.close();
    gate.fail(new Error('connect timeout'));
    await closing;
    await refusedStart;
    assert.ok(backend.workers.every((worker) => worker.closed));
    assert.ok(backend.dedicated.every((entry) => entry.disconnected));
    assert.deepEqual(reported, []);
  });

  test('fires no schedule: the ticker of a refused start never starts', async () => {
    const { backend, gate } = gatedConnect('jobs-default');
    const { adapter } = await fakeAdapter({}, { backend });
    const refusedStart = assert.rejects(
      adapter.startWorker({ queues: ['default'] }, completing),
      refused('adapter_closed'),
    );
    await gate.reached;
    const closing = adapter.close();
    gate.release();
    await closing;
    await refusedStart;
    assert.ok(
      backend.scriptCalls.every((call) => !call.script.startsWith('schedule')),
      'no schedule was read or fired',
    );
  });
});

describe('a start that fails', () => {
  test('closes the queues it already opened and rejects as transport_failed', async () => {
    const { backend, gate } = gatedConnect('jobs-mail');
    const { adapter, reported } = await fakeAdapter({ mail: {} }, { backend });
    const failedStart = assert.rejects(
      adapter.startWorker({ queues: ['default', 'mail'] }, completing),
      refused('transport_failed'),
    );
    await gate.reached;
    gate.fail(new Error('connect timeout'));
    await failedStart;
    assert.deepEqual(
      backend.workers.map((worker) => [worker.queue, worker.closed]),
      [['default', true]],
    );
    assert.ok(backend.dedicated.every((entry) => entry.disconnected));
    assert.deepEqual(reported, []);
    // The adapter keeps working: a later start opens afresh.
    backend.connectGate = undefined;
    const worker = await adapter.startWorker({ queues: ['mail'] }, completing);
    assert.ok(worker instanceof ValkeyWorker);
    assert.deepEqual(worker.fetching, ['mail']);
    await adapter.close();
    assert.ok(backend.workers.every((entry) => entry.closed));
  });
});

describe('a drained worker', () => {
  test('fetches from no queue, and a second drain is the first', async () => {
    const { backend, adapter } = await fakeAdapter({ mail: {} });
    const worker = await adapter.startWorker({ queues: ['default', 'mail'] }, completing);
    assert.ok(worker instanceof ValkeyWorker);
    assert.deepEqual(worker.fetching, ['default', 'mail']);
    const draining = worker.drain();
    assert.deepEqual(worker.fetching, []);
    assert.equal(worker.drain(), draining);
    await draining;
    assert.ok(backend.workers.every((entry) => entry.closed));
    await adapter.close();
  });
});

describe('a batch child', () => {
  test('records its outcome under the incarnation its job id names', async () => {
    const { backend, adapter } = await fakeAdapter();
    const settled: SettleEvent[] = [];
    await adapter.startWorker(
      { queues: ['default'], onSettle: (event) => settled.push(event) },
      () => Promise.resolve({ kind: 'completed' }),
    );
    const child = envelope({ flow: { kind: 'batch', id: 'nightly', index: 2 } });
    const job = fakeJob(child, { id: childJobId('bDIGEST.inc0', 2) });
    assert.equal(await backend.workers[0]!.processor(job, 'token-1'), 'c');
    const record = backend.scriptCalls.find((call) => call.script === 'batchRecord');
    assert.ok(record !== undefined);
    assert.equal(record.args[0], 2);
    assert.equal(record.args[1], 'c');
    assert.equal(record.args[3], BATCH_STATUS_RETENTION_MS);
    assert.equal(record.args[4], 'bDIGEST.inc0');
    backend.workers[0]!.emit('completed', job);
    assert.equal(settled.length, 1);
    await adapter.close();
  });

  test('whose job id is no child id for its index records nothing', async () => {
    const { backend, adapter } = await fakeAdapter();
    await adapter.startWorker({ queues: ['default'] }, completing);
    const child = envelope({ flow: { kind: 'batch', id: 'nightly', index: 2 } });
    await backend.workers[0]!.processor(fakeJob(child, { id: 'bDIGEST.inc0.3' }), 'token-1');
    assert.equal(
      backend.scriptCalls.some((call) => call.script === 'batchRecord'),
      false,
    );
    await adapter.close();
  });
});

describe('batchMembershipOf', () => {
  const data = (flow: unknown): unknown => ({ meta: { flow } });

  test('reads the batch id, index and incarnation of a child', () => {
    assert.deepEqual(batchMembershipOf(data({ kind: 'batch', id: 'b-1', index: 0 }), 'bX.i.0'), {
      id: 'b-1',
      index: 0,
      finalizerId: 'bX.i',
    });
  });

  test('is undefined for anything that is no child at its index', () => {
    for (const value of [
      undefined,
      [],
      { meta: [] },
      data(undefined),
      data({ kind: 'chain', id: 'b-1', index: 0 }),
      data({ kind: 'batch', id: '', index: 0 }),
      data({ kind: 'batch', id: 'b-1', index: -1 }),
      data({ kind: 'batch', id: 'b-1', index: 1.5 }),
      data({ kind: 'batch', id: 'b-1', index: '0' }),
    ]) {
      assert.equal(batchMembershipOf(value, 'bX.i.0'), undefined);
    }
    assert.equal(
      batchMembershipOf(data({ kind: 'batch', id: 'b-1', index: 0 }), undefined),
      undefined,
    );
    assert.equal(
      batchMembershipOf(data({ kind: 'batch', id: 'b-1', index: 0 }), 'job-1'),
      undefined,
    );
  });
});

describe('stalledOutcome', () => {
  test('a job that is no chain step fails as job_stalled with no follow-up', () => {
    const outcome = stalledOutcome(envelope(), () => true);
    assert.deepEqual(outcome, {
      kind: 'failed',
      error: runtimeSummary('job_stalled'),
      retryable: false,
    });
  });

  test('a chain step whose catch names an undeclared queue fires no catch', () => {
    const step = envelope({
      flow: {
        kind: 'chain',
        id: 'c1',
        step: 0,
        next: [],
        catch: { queue: 'mail', name: 'on-catch', payload: null, options: {} },
      },
    });
    const outcome = stalledOutcome(step, (queue) => queue === 'default');
    assert.equal(outcome.kind === 'failed' && outcome.catchFired, undefined);
  });
});
