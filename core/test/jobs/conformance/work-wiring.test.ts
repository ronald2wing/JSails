/**
 * What `jsails work` actually wires. The jobs conformance suite
 * (`packages/jobs/test/conformance/`) runs the old runtime in the most capable
 * configuration its API allows; this file checks the configuration the
 * shipped command builds from a runtime config (`jobsRuntimeOptions`), which
 * is what an app gets without hand-building a runtime.
 *
 * Correct behaviour: a chain advances and a batch settles on a worker started
 * by `jsails work`, with no extra registration. Today's failures are listed in
 * `scripts/expected-failures/jobs.json`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import { jobsRuntimeOptions } from '../../../src/cli/commands/runtime.js';
import { createJobBatch, InMemoryBatchCoordinator } from '../../../src/jobs/batch.js';
import { createJobChain } from '../../../src/jobs/chain.js';
import { MemoryJobsAdapter } from '../../../src/jobs/memory-adapter.js';
import { createJobRegistry, defineJob } from '../../../src/jobs/registry.js';
import type { ResolvedRuntimeConfig } from '../../../src/jobs/runtime-config.js';
import { JobsRuntimeImpl } from '../../../src/jobs/runtime.js';

/** A worker built exactly as `jsails work` builds it, recording which jobs ran. */
async function workWorker(): Promise<{
  readonly runtime: JobsRuntimeImpl;
  readonly adapter: MemoryJobsAdapter;
  readonly ran: string[];
}> {
  const ran: string[] = [];
  const record = (name: string) =>
    defineJob(z.unknown(), () => {
      ran.push(name);
    });
  const adapter = new MemoryJobsAdapter();
  const config: ResolvedRuntimeConfig = {
    registry: createJobRegistry({
      first: record('first'),
      second: record('second'),
      done: record('done'),
    }),
    adapter,
    schedules: [],
    queueName: 'default',
    prefix: 'work-wiring',
    concurrency: 1,
    extensions: [],
  };
  const runtime = new JobsRuntimeImpl(jobsRuntimeOptions(config));
  await runtime.startWorker();
  return { runtime, adapter, ran };
}

describe('jsails work wiring', () => {
  test('a chain advances on a worker started by jsails work', async () => {
    const { runtime, adapter, ran } = await workWorker();
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
      await runtime.close();
    }
  });

  test('a batch settles on a worker started by jsails work', async () => {
    const { runtime, adapter, ran } = await workWorker();
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
      await runtime.close();
    }
  });
});
