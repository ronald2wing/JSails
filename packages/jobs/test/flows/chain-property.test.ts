/**
 * A seeded property test of chains end to end: random length, a random step
 * that fails once (or none), an optional catch, random redeliveries of
 * completed steps, and a retry of the failed step without force, with it,
 * or not at all. Whatever happens, a step never forks (one job per step),
 * no step runs past an unretried failure, the catch fires at most once and
 * exactly when a step failed, and a retried chain runs to its end.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import { defineJob, type JobCall } from '../../src/definition/define-job.js';
import { integer, propertySeeds, seeded, startTrial } from './property-harness.js';

async function trial(seed: number): Promise<void> {
  const random = seeded(seed);
  const say = (what: string) => `seed ${seed}: ${what}`;
  const length = integer(random, 1, 6);
  const failing = random() < 0.6 ? integer(random, 0, length - 1) : undefined;
  const withCatch = random() < 0.6;
  const jobIds = Array.from({ length }, () => new Set<string>());
  const runs = Array.from({ length }, () => 0);
  let caught = 0;
  const Step = defineJob({
    name: 'step',
    schema: z.object({ index: z.number() }),
    attempts: 1,
    handle: (payload, context) => {
      jobIds[payload.index]!.add(context.jobId);
      runs[payload.index]! += 1;
      if (payload.index === failing && runs[payload.index] === 1) throw new Error('step failed');
    },
  });
  const OnCatch = defineJob({
    name: 'on-catch',
    schema: z.unknown(),
    handle: () => {
      caught += 1;
    },
  });
  const run = await startTrial([Step, OnCatch]);
  try {
    const steps = Array.from({ length }, (_, index) => Step.with({ index })) as [
      JobCall,
      ...JobCall[],
    ];
    await run.producer.chain(steps, withCatch ? { catch: OnCatch.with(null) } : {});
    await run.settle();

    let redelivered = 0;
    for (const [index, ids] of jobIds.entries()) {
      const [id] = ids;
      if (id === undefined || index === failing || random() < 0.5) continue;
      if (run.adapter.redeliver(id)) redelivered += 1;
      await run.settle();
    }

    let recovered = failing === undefined;
    if (failing !== undefined) {
      const choice = integer(random, 0, 2);
      const [failed] = await run.adapter.capabilities.failedJobs!.list();
      assert.ok(failed !== undefined, say('the failing step is not in the failed set'));
      if (choice > 0) {
        const result = await run.adapter.capabilities.failedJobs!.retry(failed.id, {
          force: choice === 2,
        });
        const expected = withCatch && choice === 1 ? 'not_retryable' : 'retried';
        assert.equal(result, expected, say(`retry with force ${choice === 2}`));
        recovered = result === 'retried';
        await run.settle();
      }
    }

    for (const [index, ids] of jobIds.entries()) {
      assert.ok(ids.size <= 1, say(`step ${index} forked into ${ids.size} jobs`));
    }
    const lastRun = runs.findLastIndex((count) => count > 0);
    if (recovered) {
      assert.equal(lastRun, length - 1, say(`the chain stopped at step ${lastRun}`));
    } else {
      assert.equal(lastRun, failing, say(`a step after the failed step ${failing} ran`));
    }
    assert.equal(
      caught,
      withCatch && failing !== undefined ? 1 : 0,
      say(`the catch ran ${caught} times`),
    );
    assert.ok(redelivered <= length, say('redeliveries'));
  } finally {
    await run.close();
  }
}

describe('chain property', () => {
  test('no fork, no step past an unretried failure, the catch at most once', async () => {
    for (const seed of propertySeeds()) await trial(seed);
  });
});
