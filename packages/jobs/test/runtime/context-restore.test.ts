/**
 * Execution-context restore around an attempt: the carried request id and
 * trace (as a child span), a fresh context without a carrier, a newer carrier
 * version released as deploy skew, a malformed one failed for good, and, end
 * to end, a tenant set around a dispatch is the tenant the handler runs
 * under, with the system as its actor.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createExecutionContext,
  currentContext,
  runInContext,
  serializeContext,
  type ExecutionContext,
} from 'jsails/context';
import { currentTenantId, runWithTenant } from 'jsails/database';
import { z } from 'zod';

import type { JobEnvelope, TransportJob } from '../../src/contract/index.js';
import { createJobCatalog } from '../../src/definition/catalog.js';
import { defineJob, type JobContext } from '../../src/definition/define-job.js';
import { createProducer, type Jobs } from '../../src/definition/jobs-service.js';
import { buildEnvelope } from '../../src/envelope/codec.js';
import { MemoryJobsAdapter } from '../../src/memory/memory-adapter.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import { createProcessor } from '../../src/runtime/processor.js';
import { startRuntimeWorker } from '../../src/runtime/runtime-worker.js';
import { VirtualClock } from '../timing/virtual-clock.js';
import { unusedJobs } from './fixtures/unused-jobs.js';

const jobs: Jobs = unusedJobs;

interface Seen {
  readonly ambient: ExecutionContext | undefined;
  readonly context: JobContext;
}

function setup() {
  const seen: Seen[] = [];
  const Probe = defineJob({
    name: 'probe',
    schema: z.unknown(),
    handle: (_payload, context) => {
      seen.push({ ambient: currentContext(), context });
    },
  });
  const process = createProcessor({
    catalog: createJobCatalog({ queues: defineQueues({}), definitions: [Probe] }),
    jobs,
    transport: { capabilities: {} },
    clock: new VirtualClock(0),
    handlerGraceMs: 30_000,
    storeErrorMessages: false,
    ledger: { enter: () => undefined, leave: () => undefined, poison: () => undefined },
  });
  const run = (context: unknown, unknownReleases = 0) => {
    const envelope: JobEnvelope = buildEnvelope({
      name: 'probe',
      payload: null,
      options: {},
      ...(context === undefined ? {} : { context }),
      dispatchedAt: 0,
    });
    const job: TransportJob = {
      id: '1',
      queue: 'default',
      envelope,
      attemptsMade: 0,
      unknownReleases,
    };
    return process(job, new AbortController().signal);
  };
  return { seen, run };
}

describe('context restore', () => {
  test('the carried request id and trace are restored as a child span', async () => {
    const { seen, run } = setup();
    const dispatcher = createExecutionContext({ requestId: 'req-42' });
    const carrier = serializeContext(dispatcher);
    assert.deepEqual(await run(carrier), { kind: 'completed' });
    const [entry] = seen;
    assert.ok(entry !== undefined);
    assert.equal(entry.ambient?.requestId, 'req-42');
    assert.equal(entry.context.requestId, 'req-42');
    assert.equal(entry.context.trace, entry.ambient?.trace);
    assert.equal(entry.context.trace.traceId, dispatcher.trace.traceId);
    assert.notEqual(entry.context.trace.spanId, dispatcher.trace.spanId);
  });

  test('without a carrier the attempt runs in a fresh context', async () => {
    const { seen, run } = setup();
    assert.deepEqual(await run(undefined), { kind: 'completed' });
    assert.ok(seen[0]?.ambient !== undefined);
    assert.equal(seen[0].context.requestId, undefined);
  });

  test('a newer carrier version is released as skew and counted', async () => {
    const { seen, run } = setup();
    const carrier = { ...serializeContext(createExecutionContext()), v: 2 };
    assert.deepEqual(await run(carrier), { kind: 'released', reason: 'unknown_job', delayMs: 500 });
    const capped = await run(carrier, 10);
    assert.equal(capped.kind === 'failed' && capped.error.code, 'jobs.unknown_job');
    assert.equal(seen.length, 0);
  });

  test('a malformed carrier or value fails for good with its context code', async () => {
    const { seen, run } = setup();
    const valid = serializeContext(createExecutionContext())!;
    for (const [carrier, code] of [
      [{ v: 1, traceparent: 'nope' }, 'context.invalid_carrier'],
      [{ ...valid, values: { 'jsails.tenant': 'not json' } }, 'context.invalid_value'],
    ] as const) {
      const outcome = await run(carrier);
      assert.equal(outcome.kind, 'failed');
      assert.equal(outcome.kind === 'failed' && outcome.error.code, code);
      assert.equal(outcome.kind === 'failed' && outcome.retryable, false);
    }
    assert.equal(seen.length, 0);
  });

  test('a job dispatched under a tenant and a request runs under both, as the system', async () => {
    const seen: { tenant: unknown; requestId: string | undefined; context: JobContext }[] = [];
    const Tenanted = defineJob({
      name: 'tenanted',
      schema: z.object({ n: z.number() }),
      handle: (_payload, context) => {
        seen.push({ tenant: currentTenantId(), requestId: currentContext()?.requestId, context });
      },
    });
    const catalog = createJobCatalog({ queues: defineQueues({}), definitions: [Tenanted] });
    const adapter = new MemoryJobsAdapter({
      namespace: 'app:test',
      queues: catalog.queues.declarations,
    });
    const producer = createProducer({ catalog, adapter });
    await runInContext(createExecutionContext({ requestId: 'req-7' }), () =>
      runWithTenant('t-1', () => producer.dispatch(Tenanted.with({ n: 1 }))),
    );
    assert.equal(currentTenantId(), undefined);
    const worker = await startRuntimeWorker({ catalog, adapter, jobs: producer });
    for (let index = 0; index < 20 && seen.length === 0; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.tenant, 't-1');
    assert.equal(seen[0]?.requestId, 'req-7');
    assert.equal(seen[0]?.context.actor.kind, 'system');
    assert.equal(currentTenantId(), undefined, 'the tenant did not leak out of the attempt');
    await worker.drain();
    producer.close();
    await adapter.close();
  });
});
