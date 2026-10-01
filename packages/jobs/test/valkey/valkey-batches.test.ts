/**
 * Batches on the Valkey transport over a fake BullMQ, whose script replies
 * stand for the server and whose flow producer stores a bulk add in one
 * transaction: a batch that is not chunked stores every child or none, under
 * a staged record that lapses unless the children are found stored; a batch
 * id issued again after its record expired stores fresh children under a
 * new incarnation; a batch issued again while its record lives resumes it;
 * and the status read, the failure list, a child's record releasing the
 * finalizer, and the retry bookkeeping, with the arguments each sends.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { BatchEnqueue } from '../../src/contract/index.js';
import { runtimeSummary } from '../../src/errors/error-summary.js';
import { BATCH_FINALIZER_JOB } from '../../src/flows/batch-finalizer.js';
import { BATCH_STATUS_RETENTION_MS, MAX_CHILD_FAILURES } from '../../src/flows/flow-limits.js';
import { encodeFailure } from '../../src/valkey/failure-record.js';
import { childJobId } from '../../src/valkey/key-layout.js';
import type { ValkeyBatches } from '../../src/valkey/valkey-batches.js';
import type { FakeBackend, ScriptName } from './fake-bullmq.js';
import { envelope, fakeAdapter, refused } from './fixtures/fake-adapter.js';

/** Batch `id` with one child per entry of `queues`, child `i` on `queues[i]`. */
function batchOf(
  id: string,
  queues: readonly string[],
  options: { readonly chunked?: boolean; readonly runAt?: number } = {},
): BatchEnqueue {
  return {
    id,
    children: queues.map((queue, index) => ({
      queue,
      envelope: envelope({
        name: `child-${index}`,
        flow: { kind: 'batch', id, index },
        ...(options.runAt === undefined ? {} : { runAt: options.runAt }),
      }),
    })),
    finalizer: { queue: 'default', envelope: envelope({ name: BATCH_FINALIZER_JOB }) },
    chunked: options.chunked ?? false,
  };
}

/** Answer the claim script as for a batch with no record: created, under the finalizer id it was given. */
function claimsNew(
  backend: FakeBackend,
  others: (script: ScriptName, args: readonly unknown[]) => unknown = () => 1,
): void {
  backend.scriptReply = (script, _keys, args) =>
    script === 'batchClaim' ? ['new', '0', String(args[3])] : others(script, args);
}

function claims(backend: FakeBackend): (string | number)[][] {
  return backend.scriptCalls
    .filter((call) => call.script === 'batchClaim')
    .map((call) => [...call.args]);
}

function scriptsRun(backend: FakeBackend, script: ScriptName): (string | number)[][] {
  return backend.scriptCalls.filter((call) => call.script === script).map((call) => [...call.args]);
}

async function flowsOf(queues: Parameters<typeof fakeAdapter>[0] = { mail: {} }) {
  const fake = await fakeAdapter(queues);
  return { ...fake, flows: fake.adapter.capabilities.flows as ValkeyBatches };
}

describe('a batch that is not chunked', () => {
  test('stores every child in one transaction across its queues, then marks them stored', async () => {
    const { backend, adapter, flows } = await flowsOf();
    claimsNew(backend);
    const result = await flows.enqueueBatch(batchOf('b-1', ['default', 'mail', 'default']));
    assert.deepEqual(result, { deduplicated: false });
    const finalizerId = String(claims(backend)[0]![3]);
    assert.deepEqual(
      backend.adds.map((add) => [add.queue, add.options.jobId, add.flow]),
      [
        ['default', childJobId(finalizerId, 0), true],
        ['mail', childJobId(finalizerId, 1), true],
        ['default', childJobId(finalizerId, 2), true],
      ],
    );
    assert.ok(backend.adds.every((add) => add.options.deduplication === undefined));
    assert.deepEqual(scriptsRun(backend, 'batchStored'), [[3]]);
    await adapter.close();
  });

  test('a transaction that fails stores no child and leaves only a staged record that lapses', async () => {
    const { backend, adapter, flows } = await flowsOf();
    claimsNew(backend);
    backend.failQueues.add('mail');
    await assert.rejects(
      flows.enqueueBatch(batchOf('b-1', ['default', 'mail'])),
      refused('transport_failed'),
    );
    assert.deepEqual(backend.adds, [], 'no child on the queue that took its add runs');
    const [claim] = claims(backend);
    assert.equal(claim![4], '1', 'the record is created staged');
    assert.equal(claim![5], BATCH_STATUS_RETENTION_MS, 'and expires as a settled record does');
    assert.deepEqual(scriptsRun(backend, 'batchStored'), []);
    await adapter.close();
  });

  test('a staged record outlives the latest time a child may first run', async () => {
    const { backend, adapter, flows } = await flowsOf();
    claimsNew(backend);
    const runAt = Date.now() + 3_600_000;
    await flows.enqueueBatch(batchOf('b-1', ['default'], { runAt }));
    const ttl = Number(claims(backend)[0]![5]);
    assert.ok(ttl > BATCH_STATUS_RETENTION_MS + 3_590_000, `a staged record lived ${ttl} ms`);
    assert.ok(ttl <= BATCH_STATUS_RETENTION_MS + 3_600_000);
    await adapter.close();
  });

  test('issued again while staged, stores the batch as new under the staged incarnation', async () => {
    const { backend, adapter, flows } = await flowsOf();
    backend.scriptReply = (script) => {
      if (script === 'batchClaim') return ['staged', '0', 'bSTAGED.inc'];
      if (script === 'batchRecorded') return ['', ''];
      return 1;
    };
    const result = await flows.enqueueBatch(batchOf('b-1', ['default', 'mail']));
    assert.deepEqual(result, { deduplicated: false }, 'a staged record was never known stored');
    assert.deepEqual(
      backend.adds.map((add) => add.options.jobId),
      ['bSTAGED.inc.0', 'bSTAGED.inc.1'],
    );
    await adapter.close();
  });
});

describe('a batch id issued again', () => {
  test('after its record expired stores fresh children, never meeting the jobs BullMQ kept', async () => {
    const { backend, adapter, flows } = await flowsOf();
    claimsNew(backend);
    const batch = batchOf('weekly-export', ['default', 'default']);
    await flows.enqueueBatch(batch);
    // The record lapsed; BullMQ still keeps both children (say, in the failed set).
    const again = await flows.enqueueBatch(batch);
    assert.deepEqual(again, { deduplicated: false });
    const [first, second] = claims(backend).map((claim) => String(claim[3]));
    assert.notEqual(first, second, 'each record draws its own incarnation');
    assert.deepEqual(
      backend.adds.map((add) => add.options.jobId),
      [
        childJobId(first!, 0),
        childJobId(first!, 1),
        childJobId(second!, 0),
        childJobId(second!, 1),
      ],
    );
    await adapter.close();
  });

  test('while its record lives resumes from the stored count, skipping recorded children', async () => {
    const { backend, adapter, flows } = await flowsOf();
    backend.scriptReply = (script, _keys, args) => {
      if (script === 'batchClaim') return ['exists', '1', 'bOLD.inc'];
      if (script === 'batchRecorded') return args.map((index) => (index === 1 ? '1' : ''));
      return 1;
    };
    const result = await flows.enqueueBatch(batchOf('b-1', ['default', 'default', 'mail']));
    assert.deepEqual(result, { deduplicated: true });
    assert.deepEqual(scriptsRun(backend, 'batchRecorded'), [[1, 2]]);
    assert.deepEqual(
      backend.adds.map((add) => add.options.jobId),
      ['bOLD.inc.2'],
      'child 0 was stored before, child 1 recorded',
    );
    assert.deepEqual(scriptsRun(backend, 'batchStored'), [[3]]);
    await adapter.close();
  });

  test('with another total is a conflict that stores nothing', async () => {
    const { backend, adapter, flows } = await flowsOf();
    backend.scriptReply = () => ['conflict', '0', ''];
    await assert.rejects(flows.enqueueBatch(batchOf('b-1', ['default'])), refused('flow_conflict'));
    assert.deepEqual(backend.adds, []);
    await adapter.close();
  });
});

describe('a chunked batch', () => {
  test('is not staged, and marks each chunk of 1,000 stored as it goes', async () => {
    const { backend, adapter, flows } = await flowsOf();
    claimsNew(backend);
    const queues = Array.from({ length: 2_500 }, () => 'default');
    await flows.enqueueBatch(batchOf('big', queues, { chunked: true }));
    assert.equal(claims(backend)[0]![4], '0');
    assert.deepEqual(scriptsRun(backend, 'batchStored'), [[1_000], [2_000], [2_500]]);
    assert.equal(backend.adds.length, 2_500);
    await adapter.close();
  });
});

describe('enqueueBatch refuses', () => {
  test('on a closed adapter, and a malformed batch before any script', async () => {
    const { backend, adapter, flows } = await flowsOf();
    await assert.rejects(
      flows.enqueueBatch({ ...batchOf('b-1', ['default']), id: '' }),
      refused('invalid_flow'),
    );
    await assert.rejects(flows.enqueueBatch(batchOf('b-1', ['audit'])), refused('unknown_queue'));
    assert.deepEqual(backend.scriptCalls, []);
    await adapter.close();
    await assert.rejects(
      flows.enqueueBatch(batchOf('b-1', ['default'])),
      refused('adapter_closed'),
    );
  });
});

describe('batchStatus', () => {
  test('is one read of the record, pending being the children not yet recorded', async () => {
    const { backend, adapter, flows } = await flowsOf();
    backend.scriptReply = () => ['10', '4', '2', '1', '7', '0', '0'];
    assert.deepEqual(await flows.batchStatus('b-1'), {
      total: 10,
      completed: 4,
      failed: 2,
      skipped: 1,
      pending: 3,
      settled: false,
      retriedAfterSettlement: 0,
    });
    backend.scriptReply = () => ['2', '2', '0', '0', '2', '1', '3'];
    const settled = await flows.batchStatus('b-1');
    assert.equal(settled?.settled, true);
    assert.equal(settled?.retriedAfterSettlement, 3);
    assert.equal(backend.scriptCalls.length, 2);
    await adapter.close();
  });

  test('is undefined for an unknown or staged batch, and for an id no batch can have', async () => {
    const { backend, adapter, flows } = await flowsOf();
    backend.scriptReply = () => [];
    assert.equal(await flows.batchStatus('b-1'), undefined);
    assert.equal(await flows.batchStatus(''), undefined);
    assert.equal(backend.scriptCalls.length, 1);
    await adapter.close();
  });
});

describe('childFailures', () => {
  test('decodes each failed index and its record, by ascending index', async () => {
    const { backend, adapter, flows } = await flowsOf();
    const error = runtimeSummary('attempt_timeout');
    backend.scriptReply = () => ['1', encodeFailure('child-1', error), '4', 'not a record'];
    const failures = await flows.childFailures('b-1', 10);
    assert.deepEqual(failures[0], { index: 1, name: 'child-1', error });
    assert.equal(failures[1]?.index, 4);
    assert.equal(failures[1]?.name, '');
    assert.deepEqual(scriptsRun(backend, 'batchFailures'), [[10]]);
    await adapter.close();
  });

  test('refuses a limit out of bounds, and reads nothing for an id no batch can have', async () => {
    const { backend, adapter, flows } = await flowsOf();
    for (const limit of [0, 1.5, MAX_CHILD_FAILURES + 1, '5' as unknown as number]) {
      await assert.rejects(
        flows.childFailures('b-1', limit),
        refused('invalid_option', { option: 'limit' }),
      );
    }
    assert.deepEqual(await flows.childFailures('', 5), []);
    assert.deepEqual(backend.scriptCalls, []);
    await adapter.close();
  });
});

describe('recordChild', () => {
  const batch = { id: 'b-1', index: 1, finalizerId: 'bF.inc' };

  test('records under the child incarnation, releasing nothing while the batch runs', async () => {
    const { backend, adapter, flows } = await flowsOf();
    backend.scriptReply = () => [0];
    await flows.recordChild(batch, 'c');
    const [record] = scriptsRun(backend, 'batchRecord');
    assert.equal(record![0], 1);
    assert.equal(record![1], 'c');
    assert.equal(record![3], BATCH_STATUS_RETENTION_MS);
    assert.equal(record![4], 'bF.inc');
    assert.deepEqual(backend.adds, []);
    await adapter.close();
  });

  test('the record that settles the batch stores the finalizer under the record id, then marks it', async () => {
    const { backend, adapter, flows } = await flowsOf();
    const finalizer = envelope({ name: BATCH_FINALIZER_JOB });
    backend.scriptReply = (script) =>
      script === 'batchRecord' ? [1, 'mail', JSON.stringify(finalizer), 'bF.inc'] : 1;
    await flows.recordChild(batch, 'c');
    assert.deepEqual(
      backend.adds.map((add) => [add.queue, add.name, add.options.jobId, add.flow]),
      [['mail', BATCH_FINALIZER_JOB, 'bF.inc', false]],
    );
    assert.equal(scriptsRun(backend, 'batchReleased').length, 1);
    await adapter.close();
  });
});

describe('retry bookkeeping', () => {
  const batch = { id: 'b-1', index: 1, finalizerId: 'bF.inc' };

  test('a job that is no batch child needs none', async () => {
    const { backend, adapter, flows } = await flowsOf();
    const preparation = await flows.prepareRetry(undefined);
    assert.deepEqual(preparation, { kind: 'none' });
    await flows.finishRetry(preparation, true);
    assert.deepEqual(backend.scriptCalls, []);
    await adapter.close();
  });

  test('on an unsettled batch, the failure taken back is restored when the retry did not happen', async () => {
    const { backend, adapter, flows } = await flowsOf();
    backend.scriptReply = (script) => (script === 'batchUnrecord' ? ['unrecorded', 'REC'] : [0]);
    const preparation = await flows.prepareRetry(batch);
    assert.deepEqual(preparation, { kind: 'unrecorded', batch, value: 'REC' });
    assert.deepEqual(scriptsRun(backend, 'batchUnrecord'), [[1, 'bF.inc']]);
    await flows.finishRetry(preparation, true);
    assert.deepEqual(
      scriptsRun(backend, 'batchRecord'),
      [],
      'a retry that happened restores nothing',
    );
    await flows.finishRetry(preparation, false);
    const [restored] = scriptsRun(backend, 'batchRecord');
    assert.equal(restored![1], 'REC');
    assert.equal(restored![4], 'bF.inc');
    await adapter.close();
  });

  test('on a settled batch, a retry that happened is counted against that incarnation', async () => {
    const { backend, adapter, flows } = await flowsOf();
    backend.scriptReply = (script) => (script === 'batchUnrecord' ? ['settled'] : 1);
    const preparation = await flows.prepareRetry(batch);
    assert.deepEqual(preparation, { kind: 'settled', batch });
    await flows.finishRetry(preparation, false);
    assert.deepEqual(scriptsRun(backend, 'batchRetried'), []);
    await flows.finishRetry(preparation, true);
    assert.deepEqual(scriptsRun(backend, 'batchRetried'), [['bF.inc']]);
    await adapter.close();
  });

  test('a child of an expired incarnation finds no batch', async () => {
    const { backend, adapter, flows } = await flowsOf();
    backend.scriptReply = () => ['absent'];
    assert.deepEqual(await flows.prepareRetry(batch), { kind: 'none' });
    await adapter.close();
  });
});
