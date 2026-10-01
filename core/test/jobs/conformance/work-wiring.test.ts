/**
 * What `jsails work` actually wires. The jobs conformance suite
 * (`packages/jobs/test/conformance/`) runs the old runtime in the most capable
 * configuration its API allows; this file checks the worker the shipped
 * command starts, `jobsPlugin`'s `jobs.worker` unit, which is what an app
 * gets without hand-building a runtime. The producer is a runtime on the same
 * in-memory adapter, as a web process's dispatch is.
 *
 * Correct behaviour: a chain advances and a batch settles on a worker started
 * by `jsails work`, with no extra registration. Today's failures are listed in
 * `scripts/expected-failures/jobs.json`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import { runExtensions } from '../../../src/extensions/extension.js';
import { createJobBatch, InMemoryBatchCoordinator } from '../../../src/jobs/batch.js';
import { createJobChain } from '../../../src/jobs/chain.js';
import { MemoryJobsAdapter } from '../../../src/jobs/memory-adapter.js';
import { jobsPlugin } from '../../../src/jobs/plugin.js';
import { createJobRegistry, defineJob } from '../../../src/jobs/registry.js';
import { JobsRuntimeImpl } from '../../../src/jobs/runtime.js';

/** The worker `jsails work` starts, recording which jobs ran, and a producer beside it. */
async function workWorker(): Promise<{
  readonly runtime: JobsRuntimeImpl;
  readonly adapter: MemoryJobsAdapter;
  readonly ran: string[];
  close(): Promise<void>;
}> {
  const ran: string[] = [];
  const record = (name: string) =>
    defineJob(z.unknown(), () => {
      ran.push(name);
    });
  const registry = createJobRegistry({
    first: record('first'),
    second: record('second'),
    done: record('done'),
  });
  const adapter = new MemoryJobsAdapter();
  const app = await runExtensions(
    [jobsPlugin({ registry, adapter, prefix: 'work-wiring', concurrency: 1 })],
    { rootDir: import.meta.dirname, roles: ['worker'], units: 'collect' },
  );
  const worker = app.units.find((registration) => registration.unit.name === 'jobs.worker');
  assert.ok(worker !== undefined, 'jobsPlugin registers the jobs.worker unit');
  await worker.unit.start();
  const runtime = new JobsRuntimeImpl({ registry, adapter, prefix: 'work-wiring' });
  return {
    runtime,
    adapter,
    ran,
    async close() {
      try {
        await runtime.close();
      } finally {
        await app.close();
      }
    },
  };
}

describe('jsails work wiring', () => {
  test('a chain advances on a worker started by jsails work', async () => {
    const { runtime, adapter, ran, close } = await workWorker();
    try {
      await createJobChain(runtime, [
        { job: 'first', data: null, opts: { attempts: 1 } },
        { job: 'second', data: null, opts: { attempts: 1 } },
      ]).dispatch();
      await adapter.drain();
      assert.deepEqual(
        ran,
        ['first', 'second'],
        `jsails work ran ${JSON.stringify(ran)} of a two-step chain`,
      );
    } finally {
      await close();
    }
  });

  test('a batch settles on a worker started by jsails work', async () => {
    const { runtime, adapter, ran, close } = await workWorker();
    try {
      let settled = 0;
      await createJobBatch(
        runtime,
        new InMemoryBatchCoordinator(),
        [
          { job: 'first', data: 1, opts: { attempts: 1 } },
          { job: 'first', data: 2, opts: { attempts: 1 } },
        ],
        {
          finally: () => {
            settled += 1;
          },
        },
      ).dispatch();
      await adapter.drain();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(ran, ['first', 'first'], 'the batch children did not run');
      assert.equal(settled, 1, `a batch on a jsails work worker settled ${settled} times`);
    } finally {
      await close();
    }
  });
});
