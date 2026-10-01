/**
 * The marker gate: a handler's error text never reaches the failure records,
 * the job signals, or the settle events by default, whatever shape it is
 * thrown in. With `storeErrorMessages` the record keeps the message, and the
 * stack still keeps none.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import type { JobsAdapter, SettleEvent } from '../../src/contract/index.js';
import { createJobCatalog } from '../../src/definition/catalog.js';
import { defineJob } from '../../src/definition/define-job.js';
import { createProducer } from '../../src/definition/jobs-service.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import { MemoryJobsAdapter } from '../../src/memory/memory-adapter.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import { startRuntimeWorker } from '../../src/runtime/runtime-worker.js';
import { RecordingSignalBus } from '../memory/recording-bus.js';

const MARKER = 'MARKER-7f3a';

class PaymentDeclinedError extends Error {
  override readonly name = 'PaymentDeclinedError';
}

const THROWERS: readonly (() => never)[] = [
  () => {
    throw new Error(`pay ${MARKER}`, { cause: new Error(MARKER) });
  },
  () => {
    throw new PaymentDeclinedError(`declined\n    at ${MARKER} (card.js:1:1)\ncard ${MARKER}`);
  },
  () => {
    throw new Error(`wrapped ${MARKER}`, { cause: new JobsErrors.Error('invalid_payload') });
  },
  () => {
    throw new JobsErrors.Error('command_threw', {}, { cause: new Error(MARKER) });
  },
];

async function run(storeErrorMessages: boolean) {
  const definitions = THROWERS.map((thrower, index) =>
    defineJob({ name: `throws.n${index}`, schema: z.unknown(), attempts: 1, handle: thrower }),
  );
  const catalog = createJobCatalog({ queues: defineQueues({}), definitions });
  const memory = new MemoryJobsAdapter({
    namespace: 'app:test',
    queues: catalog.queues.declarations,
  });
  const settles: SettleEvent[] = [];
  // The memory adapter, with every settle event recorded on its way to the runtime.
  const adapter: JobsAdapter = {
    name: memory.name,
    reach: memory.reach,
    capabilities: memory.capabilities,
    enqueue: (queue, envelope) => memory.enqueue(queue, envelope),
    startWorker: (options, process) =>
      memory.startWorker(
        {
          ...options,
          onSettle: (event) => {
            settles.push(event);
            options.onSettle?.(event);
          },
        },
        process,
      ),
    close: () => memory.close(),
  };
  const bus = new RecordingSignalBus();
  const producer = createProducer({ catalog, adapter });
  const worker = await startRuntimeWorker({
    catalog,
    adapter,
    jobs: producer,
    signals: bus,
    storeErrorMessages,
  });
  for (const definition of definitions) await producer.dispatchByName(definition.name, null);
  for (let index = 0; index < 50 && settles.length < THROWERS.length; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await worker.drain();
  // In dispatch order, so each record lines up with its thrower.
  const failures = [...(await memory.capabilities.failedJobs!.list({ queue: 'default' }))].sort(
    (a, b) => Number(a.id) - Number(b.id),
  );
  producer.close();
  await memory.close();
  return { failures, settles, signals: bus.emitted };
}

describe('error text', () => {
  test('no handler error text reaches records, signals or settle events by default', async () => {
    const { failures, settles, signals } = await run(false);
    assert.equal(failures.length, THROWERS.length);
    assert.equal(settles.length, THROWERS.length);
    assert.equal(signals.length, THROWERS.length);
    for (const [where, value] of [
      ['failures', failures],
      ['settle events', settles.map((event) => event.outcome)],
      ['signals', signals],
    ] as const) {
      assert.equal(JSON.stringify(value).includes(MARKER), false, where);
    }
    for (const failure of failures) {
      assert.equal(failure.error.message, undefined);
      assert.ok(failure.error.stack !== undefined, 'frames are kept');
    }
    assert.deepEqual(
      failures.map((failure) => [failure.error.name, failure.error.code]),
      [
        ['Error', 'errors.internal'],
        ['PaymentDeclinedError', 'errors.internal'],
        ['Error', 'errors.internal'],
        ['JobsError', 'jobs.command_threw'],
      ],
    );
  });

  test('with storeErrorMessages the record keeps the message; the stack still does not', async () => {
    const { failures } = await run(true);
    const [first, second] = failures;
    assert.equal(first?.error.message, `pay ${MARKER}`);
    assert.ok(second?.error.message?.includes(MARKER));
    for (const failure of failures) {
      assert.equal(failure.error.stack?.includes(MARKER), false);
    }
  });
});
