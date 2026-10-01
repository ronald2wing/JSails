/**
 * The processor's flow and overlap actions, as the follow-ups of its
 * outcomes (it enqueues nothing itself): chain advance (keyed, after the lease
 * is released), discard and skip, a completed step never failed over its
 * follow-up, a step whose follow-up queue this worker lacks left unrun, the
 * catch on a final failure with its `catchFired` flag, a fired catch carried
 * past a forced retry, `drop`, the batch finalizer, the handler's flow
 * position, and the overlap lease (held, unavailable, missing, lost, and a
 * shutdown during acquire).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import type {
  AttemptOutcome,
  JobFlowMembership,
  JobFlowStep,
  LeaseCapability,
  TransportJob,
} from '../../src/contract/index.js';
import { createJobCatalog } from '../../src/definition/catalog.js';
import {
  defineJob,
  type JobDefinition,
  type JobDefinitionInput,
  type JobMeta,
} from '../../src/definition/define-job.js';
import { buildEnvelope, type EnvelopeParts } from '../../src/envelope/codec.js';
import { BATCH_FINALIZER_JOB, finalizerEnvelope } from '../../src/flows/batch-finalizer.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import { createProcessor } from '../../src/runtime/processor.js';
import { FlowRecorder } from '../flows/flow-recorder.js';
import { flush, VirtualClock } from '../timing/virtual-clock.js';
import { unusedJobs } from './fixtures/unused-jobs.js';

const START = 1_700_000_000_000;

type Input = Partial<JobDefinitionInput<string, z.ZodType, 'default'>>;

function job(input: Input = {}): JobDefinition<string, z.ZodType, 'default'> {
  return defineJob({ name: 'work', schema: z.unknown(), handle: () => undefined, ...input });
}

/** Leases whose answers the test sets; every call is logged in `log`. */
class Leases implements LeaseCapability {
  acquireWith: () => Promise<string | undefined> = () => Promise.resolve('token');
  renewWith: () => Promise<boolean> = () => Promise.resolve(true);
  constructor(private readonly log: string[]) {}
  acquire(key: string): Promise<string | undefined> {
    this.log.push(`acquire ${key}`);
    return this.acquireWith();
  }
  renew(): Promise<boolean> {
    return this.renewWith();
  }
  release(key: string): Promise<boolean> {
    this.log.push(`release ${key}`);
    return Promise.resolve(true);
  }
}

function setup(
  definitions: readonly JobDefinition<string, z.ZodType, 'default'>[],
  withLeases = true,
) {
  const log: string[] = [];
  const transport = new FlowRecorder();
  const leases = new Leases(log);
  if (withLeases) transport.capabilities = { ...transport.capabilities, leases };
  const enqueue = transport.enqueue.bind(transport);
  transport.enqueue = (queue, envelope) => {
    log.push(`enqueue ${envelope.name}`);
    return enqueue(queue, envelope);
  };
  const clock = new VirtualClock(START);
  const process = createProcessor({
    catalog: createJobCatalog({ queues: defineQueues({ other: {} }), definitions }),
    jobs: unusedJobs,
    transport,
    clock,
    handlerGraceMs: 30_000,
    storeErrorMessages: false,
    ledger: { enter: () => undefined, leave: () => undefined, poison: () => undefined },
  });
  const run = (job: TransportJob, signal = new AbortController().signal) => process(job, signal);
  return { transport, leases, log, clock, run };
}

function step(name: string, queue = 'default'): JobFlowStep {
  return { queue, name, payload: null, options: {} };
}

function delivery(parts: Partial<EnvelopeParts> = {}, attemptsMade = 0): TransportJob {
  return {
    id: '1',
    queue: 'default',
    envelope: buildEnvelope({
      name: 'work',
      payload: null,
      options: {},
      dispatchedAt: START,
      ...parts,
    }),
    attemptsMade,
    unknownReleases: 0,
  };
}

function chain(
  extra: Partial<Extract<JobFlowMembership, { kind: 'chain' }>> = {},
): JobFlowMembership {
  return {
    kind: 'chain',
    id: 'c',
    step: 0,
    next: [step('next')],
    catch: step('on-catch'),
    ...extra,
  };
}

function failure(outcome: AttemptOutcome) {
  assert.equal(outcome.kind, 'failed');
  return outcome.kind === 'failed'
    ? {
        code: outcome.error.code,
        retryable: outcome.retryable,
        catchFired: outcome.catchFired,
        drop: outcome.drop,
      }
    : undefined;
}

/** The follow-ups of an outcome as `[queue, name, key]`. */
function followUps(outcome: AttemptOutcome) {
  const list = outcome.kind === 'released' ? undefined : outcome.followUps;
  return (list ?? []).map(({ queue, envelope }) => [queue, envelope.name, envelope.meta.key]);
}

const fails = () => {
  throw new Error('handler failed');
};

describe('processor flows', () => {
  test('a completed step carries the next one, keyed; the last step carries nothing', async () => {
    const { transport, run } = setup([job(), job({ name: 'next' })]);
    const outcome = await run(delivery({ flow: chain() }));
    assert.equal(outcome.kind, 'completed');
    assert.deepEqual(followUps(outcome), [['default', 'next', 'jsails:chain:c:1']]);
    assert.deepEqual(await run(delivery({ flow: chain({ next: [] }) })), { kind: 'completed' });
    assert.equal(transport.enqueued.length, 0, 'the processor enqueues nothing itself');
  });

  test('a discarded step advances; a skipped one only with onSkip continue', async () => {
    const discarding = setup([job({ handle: fails, onError: () => 'discard' })]);
    const discarded = await discarding.run(delivery({ flow: chain() }));
    assert.equal(discarded.kind, 'discarded');
    assert.equal(followUps(discarded).length, 1);

    for (const [onSkip, advanced] of [
      ['stop', 0],
      ['continue', 1],
    ] as const) {
      const skipping = setup([job({ overlap: true, onSkip })]);
      skipping.leases.acquireWith = () => Promise.resolve(undefined);
      const skipped = await skipping.run(
        delivery({ flow: chain(), overlap: { key: 'k', ttlMs: 1_000 } }),
      );
      assert.equal(skipped.kind, 'skipped', onSkip);
      assert.equal(followUps(skipped).length, advanced, onSkip);
    }
  });

  test('a step whose handler completed is never failed over its follow-up, on its last attempt too', async () => {
    let runs = 0;
    const { transport, run } = setup([job({ handle: () => void (runs += 1) })]);
    transport.refuseNext(new Error('connection reset'));
    const outcome = await run(delivery({ options: { attempts: 1 }, flow: chain() }));
    assert.equal(outcome.kind, 'completed', 'a transport error cannot fail a completed step');
    assert.deepEqual(followUps(outcome), [['default', 'next', 'jsails:chain:c:1']]);
    assert.equal(runs, 1);
  });

  test('a step whose next step or catch is on a queue this worker lacks is left to a newer one, unrun', async () => {
    let runs = 0;
    const { run } = setup([job({ handle: () => void (runs += 1) })]);
    for (const flow of [
      chain({ next: [step('next', 'nope')] }),
      chain({ catch: step('on-catch', 'nope') }),
    ]) {
      assert.deepEqual(await run(delivery({ flow })), {
        kind: 'released',
        reason: 'unknown_job',
        delayMs: 500,
      });
    }
    const exhausted: TransportJob = {
      ...delivery({ flow: chain({ next: [step('next', 'nope')] }) }),
      unknownReleases: 10,
    };
    assert.deepEqual(failure(await run(exhausted)), {
      code: 'jobs.unknown_queue',
      retryable: false,
      catchFired: true,
      drop: undefined,
    });
    const noCatch: TransportJob = {
      ...delivery({ flow: chain({ catch: step('on-catch', 'nope') }) }),
      unknownReleases: 10,
    };
    const lost = await run(noCatch);
    assert.equal(failure(lost)?.catchFired, undefined, 'a catch it cannot enqueue is not claimed');
    assert.deepEqual(followUps(lost), []);
    assert.equal(runs, 0);
  });

  test('a final failure carries the catch and flags it; a retried one does not', async () => {
    const { transport, run } = setup([job({ handle: fails, attempts: 2 })]);
    const retried = await run(delivery({ options: { attempts: 2 }, flow: chain() }, 0));
    assert.equal(failure(retried)?.catchFired, undefined);
    assert.deepEqual(followUps(retried), []);
    transport.refuseNext(new Error('connection reset'));
    const final = await run(delivery({ options: { attempts: 2 }, flow: chain() }, 1));
    assert.equal(failure(final)?.catchFired, true, 'a transport error cannot lose the catch');
    assert.deepEqual(
      final.kind === 'failed'
        ? final.followUps?.map(({ envelope }) => [
            envelope.name,
            envelope.meta.key,
            envelope.meta.flow,
          ])
        : undefined,
      [
        [
          'on-catch',
          'jsails:chain:c:catch',
          { kind: 'callback', flow: 'chain', id: 'c', callback: 'catch' },
        ],
      ],
    );
    const without = await run(delivery({ flow: chain({ catch: undefined }) }));
    assert.equal(failure(without)?.catchFired, undefined);
    assert.deepEqual(followUps(without), []);
    assert.equal(transport.enqueued.length, 0);
  });

  test('after a forced retry the chain carries its fired catch, which no later step fires again', async () => {
    const completing = setup([job(), job({ name: 'next' })]);
    const advanced = await completing.run(delivery({ flow: chain({ catchFired: true }) }));
    const next = advanced.kind === 'completed' ? advanced.followUps?.[0] : undefined;
    assert.deepEqual(next?.envelope.meta.flow, {
      kind: 'chain',
      id: 'c',
      step: 1,
      next: [],
      catch: step('on-catch'),
      catchFired: true,
    });
    const failing = setup([job({ name: 'next', handle: fails })]);
    const later = await failing.run({ ...delivery(), envelope: next.envelope });
    assert.deepEqual(failure(later), {
      code: 'errors.internal',
      retryable: true,
      catchFired: undefined,
      drop: undefined,
    });
    assert.deepEqual(followUps(later), [], 'the catch fired once, whenever the later step fails');
  });

  test('onFinalFailure drop flags a final failure, alone or with the catch', async () => {
    const { run } = setup([job({ handle: fails, onFinalFailure: 'drop' })]);
    assert.deepEqual(failure(await run(delivery())), {
      code: 'errors.internal',
      retryable: true,
      catchFired: undefined,
      drop: true,
    });
    const outcome = await run(delivery({ flow: chain() }));
    const both = failure(outcome);
    assert.deepEqual([both?.catchFired, both?.drop], [true, true]);
    assert.equal(followUps(outcome).length, 1);
  });

  test('a job this worker does not know can still fire its catch when it fails for good', async () => {
    const { run } = setup([job()]);
    const unknown: TransportJob = {
      ...delivery({ name: 'gone', flow: chain() }),
      unknownReleases: 10,
    };
    const outcome = await run(unknown);
    assert.deepEqual(failure(outcome), {
      code: 'jobs.unknown_job',
      retryable: false,
      catchFired: true,
      drop: undefined,
    });
    assert.deepEqual(followUps(outcome), [['default', 'on-catch', 'jsails:chain:c:catch']]);
  });

  test('the batch finalizer runs whatever the catalog holds', async () => {
    const { transport, run } = setup([job()]);
    transport.status = {
      total: 1,
      completed: 1,
      failed: 0,
      skipped: 0,
      pending: 0,
      settled: true,
      retriedAfterSettlement: 0,
    };
    const finalizer = (payload: Parameters<typeof finalizerEnvelope>[0], releases = 0) => ({
      id: '9',
      queue: 'default',
      envelope: finalizerEnvelope(payload, undefined, START),
      attemptsMade: 0,
      unknownReleases: releases,
    });
    const outcome = await run(finalizer({ id: 'b', total: 1, then: step('work') }));
    assert.deepEqual(followUps(outcome), [['default', 'work', 'jsails:batch:b:then']]);
    assert.equal(finalizer({ id: 'b', total: 1 }).envelope.name, BATCH_FINALIZER_JOB);
    const skewed = { id: 'b', total: 1, then: step('work'), finally: step('notify', 'notify') };
    assert.deepEqual(await run(finalizer(skewed)), {
      kind: 'released',
      reason: 'unknown_job',
      delayMs: 500,
    });
    assert.deepEqual(failure(await run(finalizer(skewed, 10))), {
      code: 'jobs.unknown_queue',
      retryable: false,
      catchFired: undefined,
      drop: undefined,
    });
    assert.equal(transport.enqueued.length, 0);
  });

  test('the handler sees its flow position, not the stored steps', async () => {
    let meta: JobMeta | undefined;
    const { run } = setup([
      job({ handle: (_payload, context) => void (meta = context.meta) }),
      job({ name: 'next' }),
    ]);
    await run(delivery({ flow: chain({ step: 2, next: [step('next'), step('next')] }) }));
    assert.deepEqual(meta?.flow, { kind: 'chain', id: 'c', step: 2, remaining: 2 });
    await run(delivery({ flow: { kind: 'batch', id: 'b', index: 4 } }));
    assert.deepEqual(meta?.flow, { kind: 'batch', id: 'b', index: 4 });
  });
});

describe('processor overlap', () => {
  const overlap = { key: 'tenant:1', ttlMs: 3_000 };

  test('holds the lease for the run and releases it before the outcome carries the next step', async () => {
    const { log, run } = setup([job(), job({ name: 'next' })]);
    const outcome = await run(delivery({ overlap, flow: chain() }));
    assert.deepEqual(followUps(outcome), [['default', 'next', 'jsails:chain:c:1']]);
    assert.deepEqual(log, ['acquire overlap:tenant:1', 'release overlap:tenant:1']);
  });

  test('a store that cannot be reached fails retryably, value-free', async () => {
    const { leases, run } = setup([job()]);
    leases.acquireWith = () => Promise.reject(new Error('redis://user:secret@host'));
    const outcome = await run(delivery({ overlap }));
    assert.deepEqual(failure(outcome), {
      code: 'jobs.overlap_unavailable',
      retryable: true,
      catchFired: undefined,
      drop: undefined,
    });
    assert.equal(JSON.stringify(outcome).includes('secret'), false);
  });

  test('an adapter without leases fails it for good', async () => {
    const { run } = setup([job()], false);
    assert.deepEqual(failure(await run(delivery({ overlap }))), {
      code: 'jobs.capability_missing',
      retryable: false,
      catchFired: undefined,
      drop: undefined,
    });
  });

  test('a lost lease aborts the run with overlap_lost', async () => {
    let signal: AbortSignal | undefined;
    const { leases, clock, run } = setup([
      job({
        handle: (_payload, context) =>
          new Promise<void>((_resolve, reject) => {
            signal = context.signal;
            context.signal.addEventListener('abort', () => reject(context.signal.reason as Error));
          }),
      }),
    ]);
    leases.renewWith = () => Promise.resolve(false);
    const running = run(delivery({ overlap }));
    await flush();
    await clock.advance(1_000);
    const outcome = await running;
    assert.equal(signal?.aborted, true);
    assert.deepEqual(failure(outcome), {
      code: 'jobs.overlap_lost',
      retryable: true,
      catchFired: undefined,
      drop: undefined,
    });
  });

  test('a shutdown while the lease is acquired releases it and the job', async () => {
    const { leases, log, run } = setup([job()]);
    const controller = new AbortController();
    leases.acquireWith = () => {
      controller.abort();
      return Promise.resolve('token');
    };
    assert.deepEqual(await run(delivery({ overlap }), controller.signal), {
      kind: 'released',
      reason: 'shutdown',
    });
    assert.deepEqual(log, ['acquire overlap:tenant:1', 'release overlap:tenant:1']);
  });
});
