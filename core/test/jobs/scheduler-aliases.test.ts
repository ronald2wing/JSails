import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import { prepareSchedules, ScheduleError } from '../../src/jobs/scheduler.js';

function registry() {
  return createJobRegistry({
    job: defineJob(z.object({}), async () => undefined),
  });
}

function repeatOf(interval: string) {
  const prepared = prepareSchedules(registry(), [{ id: 's', job: 'job', interval }]);
  return prepared[0]?.repeat;
}

describe('@every text frequency aliases', () => {
  it('always resolves text aliases to elapsed intervals', () => {
    assert.deepEqual(repeatOf('@every_5_seconds'), { intervalMs: 5_000 });
    assert.deepEqual(repeatOf('@every_3_minutes'), { intervalMs: 180_000 });
    assert.deepEqual(repeatOf('@every_7_minutes'), { intervalMs: 420_000 });
    assert.deepEqual(repeatOf('@every_2_hours'), { intervalMs: 7_200_000 });
    assert.deepEqual(repeatOf('@every_5_hours'), { intervalMs: 18_000_000 });
    assert.deepEqual(repeatOf('@every_2_days'), { intervalMs: 172_800_000 });
    assert.deepEqual(repeatOf('@every_2_weeks'), { intervalMs: 1_209_600_000 });
  });

  it('does not collapse 60 minutes or 24 hours into calendar aliases', () => {
    assert.deepEqual(repeatOf('@every_1_minute'), { intervalMs: 60_000 });
    assert.deepEqual(repeatOf('@every_60_minutes'), { intervalMs: 3_600_000 });
    assert.deepEqual(repeatOf('@every_24_hours'), { intervalMs: 86_400_000 });
  });

  it('keeps standard calendar aliases in cron', () => {
    const prepared = prepareSchedules(registry(), [{ id: 's', job: 'job', cron: '@minutely' }]);
    assert.deepEqual(prepared[0]?.repeat, { cron: '@minutely', timezone: 'UTC' });
  });

  it('rejects timezone with an interval alias', () => {
    assert.throws(
      () =>
        prepareSchedules(registry(), [
          { id: 's', job: 'job', interval: '@every_2_hours', timezone: 'Europe/London' },
        ]),
      /timezone is only valid with cron/,
    );
  });

  it('rejects @every aliases in the cron field', () => {
    assert.throws(
      () => prepareSchedules(registry(), [{ id: 's', job: 'job', cron: '@every_3_minutes' }]),
      /must use "interval"/,
    );
  });

  it('rejects unsupported units, non-positive counts, and mixed fields', () => {
    assert.throws(() => repeatOf('@every_2_months'), ScheduleError);
    assert.throws(() => repeatOf('@every_0_minutes'), ScheduleError);
    assert.throws(() => repeatOf('@every_minute'), ScheduleError);
    assert.throws(
      () =>
        prepareSchedules(registry(), [
          { id: 's', job: 'job', interval: '@every_3_minutes', intervalMs: 60_000 },
        ]),
      ScheduleError,
    );
  });
});
