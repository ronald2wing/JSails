/**
 * `schedule()`: every rule a declaration is checked against, the frozen
 * public face, and the private declaration `reconcileSchedules` reads.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import { defineJob } from '../../src/definition/define-job.js';
import { DEFAULT_OVERLAP_TTL_MS } from '../../src/envelope/job-options.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import {
  isScheduleDefinition,
  schedule,
  scheduleSpecOf,
  type ScheduleDefinition,
} from '../../src/schedules/define-schedule.js';

const Digest = defineJob({ name: 'digest', schema: z.object({ n: z.number() }), handle: () => {} });

function rule(name: string) {
  return (error: unknown) =>
    JobsErrors.is(error, 'invalid_schedule') && error.context.rule === name;
}

describe('schedule()', () => {
  test('declares an interval schedule', () => {
    const declared = schedule('daily-digest', Digest.with({ n: 1 }), { everyMs: 86_400_000 });
    assert.deepEqual(declared, { id: 'daily-digest', name: 'digest' });
    assert.ok(Object.isFrozen(declared));
    assert.equal(isScheduleDefinition(declared), true);
    const spec = scheduleSpecOf(declared);
    assert.deepEqual(spec.repeat, { everyMs: 86_400_000 });
    assert.equal(spec.overlap, undefined);
    assert.deepEqual(spec.call.payload, { n: 1 });
  });

  test('declares a cron schedule, UTC by default, the zone canonicalized', () => {
    assert.deepEqual(
      scheduleSpecOf(schedule('a', Digest.with({ n: 1 }), { cron: ' 0 9 * * * ' })).repeat,
      {
        cron: '0 9 * * *',
        tz: 'UTC',
      },
    );
    assert.deepEqual(
      scheduleSpecOf(
        schedule('b', Digest.with({ n: 1 }), { cron: '0 9 * * mon', timezone: 'europe/london' }),
      ).repeat,
      { cron: '0 9 * * mon', tz: 'Europe/London' },
    );
  });

  test('takes an overlap option', () => {
    assert.deepEqual(
      scheduleSpecOf(schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000, overlap: true }))
        .overlap,
      { key: undefined, ttlMs: DEFAULT_OVERLAP_TTL_MS },
    );
    assert.deepEqual(
      scheduleSpecOf(
        schedule('a', Digest.with({ n: 1 }), {
          everyMs: 60_000,
          overlap: { key: 'digest', ttlMs: 5_000 },
        }),
      ).overlap,
      { key: 'digest', ttlMs: 5_000 },
    );
  });

  test('a call may carry job options and tags only', () => {
    schedule('a', Digest.with({ n: 1 }, { attempts: 3, tags: ['t'] }), { everyMs: 60_000 });
    for (const options of [{ delayMs: 5 }, { key: 'k' }, { attempts: 0 }, { tags: [''] }]) {
      assert.throws(
        () => schedule('a', Digest.with({ n: 1 }, options), { everyMs: 60_000 }),
        rule('options'),
        JSON.stringify(options),
      );
    }
    assert.throws(
      () => schedule('a', { ...Digest.with({ n: 1 }), options: 'x' as never }, { everyMs: 60_000 }),
      rule('options'),
    );
  });

  test('refuses each broken part by rule', () => {
    const call = Digest.with({ n: 1 });
    assert.throws(() => schedule('Bad Id', call, { everyMs: 60_000 }), rule('id'));
    assert.throws(
      () => schedule('a', { name: 'digest' } as never, { everyMs: 60_000 }),
      rule('call'),
    );
    assert.throws(() => schedule('a', null as never, { everyMs: 60_000 }), rule('call'));
    assert.throws(() => schedule('a', call, null as never), rule('shape'));
    assert.throws(
      () => schedule('a', call, { everyMs: 60_000, every: 5 } as never),
      (error: unknown) => JobsErrors.is(error, 'unknown_option'),
    );
    assert.throws(() => schedule('a', call, {}), rule('repeat'));
    assert.throws(
      () => schedule('a', call, { everyMs: 60_000, cron: '* * * * *' }),
      rule('repeat'),
    );
    assert.throws(() => schedule('a', call, { everyMs: 999 }), rule('interval'));
    assert.throws(
      () => schedule('a', call, { everyMs: 60_000, timezone: 'UTC' }),
      rule('timezone'),
    );
    assert.throws(
      () => schedule('a', call, { cron: '0 0 * * mon', timezone: 'Mars/Olympus' }),
      rule('timezone'),
    );
    assert.throws(() => schedule('a', call, { cron: 'nope' }), rule('cron'));
    assert.throws(() => schedule('a', call, { cron: '0 0 L * *' }), rule('cron_extension'));
    assert.throws(() => schedule('a', call, { cron: '0 0 1 * mon' }), rule('cron_day_conflict'));
    assert.throws(() => schedule('a', call, { cron: '0 0 30 2 *' }), rule('cron_never'));
    for (const overlap of [false, { ttlMs: 5 }, { key: () => 'k' }]) {
      assert.throws(
        () => schedule('a', call, { everyMs: 60_000, overlap } as never),
        rule('overlap'),
        String(overlap),
      );
    }
  });

  test('scheduleSpecOf refuses a value schedule() did not build', () => {
    const forged: ScheduleDefinition = { id: 'a', name: 'digest' };
    assert.equal(isScheduleDefinition(forged), false);
    assert.equal(isScheduleDefinition(null), false);
    assert.throws(() => scheduleSpecOf(forged), rule('shape'));
  });
});
