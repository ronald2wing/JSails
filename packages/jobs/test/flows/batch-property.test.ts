/**
 * A seeded property test of batches end to end: random children (succeed,
 * fail for good, fail then succeed, skipped on a held overlap key), random
 * callbacks, then random redeliveries and retries. Whatever happens, then
 * and catch never both fire, the decided one and finally fire exactly once,
 * catch fires exactly when a child failed, the counts add up, and every
 * retry after settlement is counted.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import { defineJob, type JobCall } from '../../src/definition/define-job.js';
import { OVERLAP_LEASE_PREFIX } from '../../src/overlap/overlap-option.js';
import { integer, propertySeeds, seeded, startTrial } from './property-harness.js';

type Mode = 'ok' | 'fail' | 'flaky' | 'skip';
const MODES: readonly Mode[] = ['ok', 'fail', 'flaky', 'skip'];

async function trial(seed: number): Promise<void> {
  const random = seeded(seed);
  const say = (what: string) => `seed ${seed}: ${what}`;
  const runs = new Map<number, number>();
  const ids = new Map<number, string>();
  const fired = { then: 0, catch: 0, finally: 0 };
  const Child = defineJob({
    name: 'child',
    schema: z.object({ index: z.number(), mode: z.enum(['ok', 'fail', 'flaky', 'skip']) }),
    attempts: 2,
    backoff: { type: 'fixed', delayMs: 0 },
    overlap: { key: (payload) => (payload.mode === 'skip' ? 'held' : `child:${payload.index}`) },
    handle: (payload, context) => {
      ids.set(payload.index, context.jobId);
      const count = (runs.get(payload.index) ?? 0) + 1;
      runs.set(payload.index, count);
      if (payload.mode === 'fail') throw new Error('child failed');
      if (payload.mode === 'flaky' && count === 1) throw new Error('child failed once');
    },
  });
  const callback = (name: keyof typeof fired) =>
    defineJob({
      name: `on-${name}`,
      schema: z.unknown(),
      handle: () => {
        fired[name] += 1;
      },
    });
  const OnThen = callback('then');
  const OnCatch = callback('catch');
  const OnFinally = callback('finally');
  const run = await startTrial([Child, OnThen, OnCatch, OnFinally]);
  try {
    const leases = run.adapter.capabilities.leases!;
    assert.ok(await leases.acquire(`${OVERLAP_LEASE_PREFIX}held`, 3_600_000));
    const total = integer(random, 1, 12);
    const modes = Array.from({ length: total }, () => MODES[integer(random, 0, 3)]!);
    const items = modes.map((mode, index) =>
      Child.with({ index, mode }, mode === 'fail' ? { attempts: 1 } : {}),
    );
    const declared = {
      then: random() < 0.7,
      catch: random() < 0.7,
      finally: random() < 0.7,
    };
    const callbacks: { then?: JobCall; catch?: JobCall; finally?: JobCall } = {};
    if (declared.then) callbacks.then = OnThen.with(null);
    if (declared.catch) callbacks.catch = OnCatch.with(null);
    if (declared.finally) callbacks.finally = OnFinally.with(null);
    const batch = await run.producer.batch(items, callbacks);
    await run.settle();

    for (const [index, id] of ids) {
      if (random() < 0.3 && run.adapter.redeliver(id)) await run.settle();
      assert.ok(index < total);
    }
    let retried = 0;
    for (const failed of await run.adapter.capabilities.failedJobs!.list({ limit: 1_000 })) {
      if (random() < 0.5) continue;
      if ((await run.adapter.capabilities.failedJobs!.retry(failed.id)) === 'retried') retried += 1;
      await run.settle();
    }

    const status = await run.producer.batchStatus(batch.id);
    assert.ok(status !== undefined, say('no batch status'));
    const expectedFailed = modes.filter((mode) => mode === 'fail').length;
    const expectedSkipped = modes.filter((mode) => mode === 'skip').length;
    assert.deepEqual(
      [status.completed, status.failed, status.skipped, status.pending, status.settled],
      [total - expectedFailed - expectedSkipped, expectedFailed, expectedSkipped, 0, true],
      say(`counts of ${JSON.stringify(modes)}`),
    );
    assert.equal(status.completed + status.failed + status.skipped, total, say('counts'));
    assert.equal(status.retriedAfterSettlement, retried, say('retries after settlement'));
    assert.ok(
      fired.then + fired.catch <= 1,
      say(`then and catch both fired: ${JSON.stringify(fired)}`),
    );
    assert.equal(fired.then, declared.then && status.failed === 0 ? 1 : 0, say('then'));
    assert.equal(fired.catch, declared.catch && status.failed > 0 ? 1 : 0, say('catch'));
    assert.equal(fired.finally, declared.finally ? 1 : 0, say('finally'));
  } finally {
    await run.close();
  }
}

describe('batch property', () => {
  test('then XOR catch, finally once, counts add up, under redelivery and retry', async () => {
    for (const seed of propertySeeds()) await trial(seed);
  });
});
