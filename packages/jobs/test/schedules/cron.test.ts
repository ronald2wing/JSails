/**
 * The cron evaluator: every case of the shared `CRON_FIRE_CASES` table, the
 * accepted grammar (five or six fields, names, ranges, steps, lists, `?`,
 * weekday 7, aliases), the refused extensions, the day-field conflict, and
 * patterns that never fire.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { JobsErrors } from '../../src/errors/jobs-errors.js';
import {
  CRON_HORIZON_YEARS,
  MAX_CRON_LENGTH,
  nextCronFire,
  nextLocalMatch,
  parseCron,
  type CronSpec,
} from '../../src/schedules/cron.js';
import { CRON_FIRE_CASES } from '../../src/testing/index.js';

function spec(pattern: string): CronSpec {
  const parsed = parseCron(pattern);
  assert.ok(parsed.ok, `${pattern} was refused`);
  return parsed.spec;
}

function fires(pattern: string, tz: string, after: string, count: number): string[] {
  const parsed = spec(pattern);
  const out: string[] = [];
  let from = Date.parse(after);
  for (let index = 0; index < count; index += 1) {
    from = nextCronFire(parsed, from, tz);
    out.push(new Date(from).toISOString().replace('.000Z', 'Z'));
  }
  return out;
}

describe('cron', () => {
  for (const entry of CRON_FIRE_CASES) {
    test(`${entry.pattern} in ${entry.tz} after ${entry.after}`, () => {
      assert.deepEqual(
        fires(entry.pattern, entry.tz, entry.after, entry.fires.length),
        entry.fires,
      );
    });
  }

  test('parses fields into sorted values', () => {
    assert.deepEqual(spec('*/20 1-3,5 * jan-mar,12 *'), {
      seconds: [0],
      minutes: [0, 20, 40],
      hours: [1, 2, 3, 5],
      days: Array.from({ length: 31 }, (_, index) => index + 1),
      months: [1, 2, 3, 12],
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      dayRestricted: 'none',
    });
    assert.deepEqual(spec('0 0 * * SUN,7').weekdays, [0]);
    assert.deepEqual(spec('0 0 * * 5/1').weekdays, [0, 5, 6]);
    assert.deepEqual(spec('0 0 10-20/5 * ?').days, [10, 15, 20]);
    assert.equal(spec('0 0 10 * ?').dayRestricted, 'month');
    assert.equal(spec('0 0 ? * mon').dayRestricted, 'week');
    assert.deepEqual(spec('  0 0 * * *  ').hours, [0]);
    for (const alias of [
      '@yearly',
      '@annually',
      '@monthly',
      '@weekly',
      '@daily',
      '@hourly',
      '@minutely',
      '@secondly',
      '@weekdays',
      '@weekends',
    ]) {
      assert.ok(parseCron(alias).ok, alias);
    }
  });

  test('refuses malformed patterns as cron', () => {
    for (const pattern of [
      7,
      undefined,
      '',
      `${'0 '.repeat(MAX_CRON_LENGTH)}`,
      '@often',
      '* * * *',
      '* * * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      '5-1 * * * *',
      '*/0 * * * *',
      '*/x * * * *',
      '1/2/3 * * * *',
      '1-2-3 * * * *',
      '? * * * *',
      '* * * foo *',
      '12345 * * * *',
    ]) {
      const parsed = parseCron(pattern);
      assert.deepEqual(parsed, { ok: false, problem: 'cron' }, String(pattern));
    }
  });

  test('refuses the L, W, H and # extensions, and both day fields', () => {
    for (const pattern of ['0 0 L * *', '0 0 15W * *', '0 0 LW * *', 'H * * * *', '0 0 * * 5#3']) {
      assert.deepEqual(parseCron(pattern), { ok: false, problem: 'cron_extension' }, pattern);
    }
    assert.deepEqual(parseCron('0 0 1 * mon'), { ok: false, problem: 'cron_day_conflict' });
  });

  test('refuses a pattern with no fire within the horizon', () => {
    assert.deepEqual(parseCron('0 0 30 2 *'), { ok: false, problem: 'cron_never' });
    assert.deepEqual(parseCron('0 0 31 4,6,9,11 *'), { ok: false, problem: 'cron_never' });
  });

  test('nextLocalMatch carries over hours, days, months and years, and stops at the last year', () => {
    const start = { year: 2023, month: 12, day: 31, hour: 23, minute: 59, second: 59 };
    assert.deepEqual(nextLocalMatch(spec('* * * * * *'), start, 2024), start);
    assert.deepEqual(nextLocalMatch(spec('0 * * * * *'), start, 2024), {
      year: 2024,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
    assert.deepEqual(nextLocalMatch(spec('30 59 22 * * *'), start, 2024), {
      year: 2024,
      month: 1,
      day: 1,
      hour: 22,
      minute: 59,
      second: 30,
    });
    assert.deepEqual(nextLocalMatch(spec('0 0 0 1 3 *'), { ...start, month: 3, day: 31 }, 2024), {
      year: 2024,
      month: 3,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
    assert.equal(nextLocalMatch(spec('0 0 0 29 2 *'), start, 2023), undefined);
    assert.ok(CRON_HORIZON_YEARS >= 8, 'a leap day is always within the horizon');
  });

  test('a fire that cannot be found is refused as cron_never', () => {
    const impossible: CronSpec = { ...spec('0 0 0 1 1 *'), months: [] };
    assert.throws(
      () => nextCronFire(impossible, 0, 'UTC'),
      (error: unknown) =>
        JobsErrors.is(error, 'invalid_schedule') && error.context.rule === 'cron_never',
    );
  });

  test('a fixed time asked for during the second pass of a repeated hour waits a day', () => {
    // 06:30Z is 01:30 EST, the second 01:30 of 2024-11-03 in New York; 01:45
    // fired on its first pass (05:45Z), so the next fire is the next day's.
    assert.deepEqual(fires('0 45 1 * * *', 'America/New_York', '2024-11-03T06:30:00Z', 1), [
      '2024-11-04T06:45:00Z',
    ]);
  });

  test('fires strictly after a fractional instant, on whole seconds', () => {
    assert.deepEqual(fires('* * * * * *', 'UTC', '2024-01-01T00:00:00.500Z', 2), [
      '2024-01-01T00:00:01Z',
      '2024-01-01T00:00:02Z',
    ]);
  });
});
