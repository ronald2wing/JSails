/**
 * The stored schedule spec a transport accepts: exact keys, an id, a
 * declared queue, an envelope without key, flow, run time or context, and a
 * repeat that is an interval of 1 s to one year or a parseable cron pattern
 * in a canonical zone.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildEnvelope } from '../../src/envelope/codec.js';
import { MAX_JOB_DELAY_MS } from '../../src/envelope/job-options.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import {
  checkedScheduleSpec,
  isScheduleInterval,
  MIN_SCHEDULE_INTERVAL_MS,
} from '../../src/schedules/schedule-spec.js';

const envelope = buildEnvelope({ name: 'digest', payload: null, options: {}, dispatchedAt: 0 });
const hasQueue = (queue: string) => queue === 'default';

function spec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'daily', queue: 'default', envelope, repeat: { everyMs: 60_000 }, ...overrides };
}

function rule(name: string) {
  return (error: unknown) =>
    JobsErrors.is(error, 'invalid_schedule') && error.context.rule === name;
}

describe('schedule spec', () => {
  test('accepts an interval or a cron spec, frozen', () => {
    const checked = checkedScheduleSpec(spec(), hasQueue);
    assert.deepEqual(checked, spec());
    assert.ok(Object.isFrozen(checked) && Object.isFrozen(checked.repeat));
    assert.deepEqual(
      checkedScheduleSpec(spec({ repeat: { cron: '0 9 * * *', tz: 'Europe/London' } }), hasQueue)
        .repeat,
      { cron: '0 9 * * *', tz: 'Europe/London' },
    );
  });

  test('interval bounds', () => {
    assert.equal(isScheduleInterval(MIN_SCHEDULE_INTERVAL_MS), true);
    assert.equal(isScheduleInterval(MAX_JOB_DELAY_MS), true);
    for (const value of [MIN_SCHEDULE_INTERVAL_MS - 1, MAX_JOB_DELAY_MS + 1, 1_500.5, '60000']) {
      assert.equal(isScheduleInterval(value), false);
    }
  });

  test('refuses each broken part by rule', () => {
    assert.throws(() => checkedScheduleSpec(null, hasQueue), rule('shape'));
    assert.throws(() => checkedScheduleSpec(spec({ extra: 1 }), hasQueue), rule('shape'));
    assert.throws(() => checkedScheduleSpec(spec({ id: 'Bad Id' }), hasQueue), rule('id'));
    assert.throws(
      () => checkedScheduleSpec(spec({ queue: 'mail' }), hasQueue),
      (error: unknown) => JobsErrors.is(error, 'unknown_queue'),
    );
    assert.throws(
      () => checkedScheduleSpec(spec({ queue: 7 }), hasQueue),
      (error: unknown) => JobsErrors.is(error, 'unknown_queue'),
    );
    assert.throws(() => checkedScheduleSpec(spec({ envelope: { v: 0 } }), hasQueue), rule('shape'));
    for (const part of [
      { key: { value: 'k', windowMs: 1 } },
      { flow: { kind: 'batch', id: 'b', index: 0 } },
      { runAt: 5 },
      { context: { trace: 'x' } },
    ]) {
      const withPart = buildEnvelope({
        name: 'digest',
        payload: null,
        options: {},
        dispatchedAt: 0,
        ...part,
      } as Parameters<typeof buildEnvelope>[0]);
      assert.throws(
        () => checkedScheduleSpec(spec({ envelope: withPart }), hasQueue),
        rule('shape'),
        JSON.stringify(part),
      );
    }
    for (const repeat of [null, {}, { everyMs: 1, cron: '* * * * *' }, { cron: 5, tz: 'UTC' }]) {
      assert.throws(() => checkedScheduleSpec(spec({ repeat }), hasQueue), rule('repeat'));
    }
    assert.throws(
      () => checkedScheduleSpec(spec({ repeat: { everyMs: 999 } }), hasQueue),
      rule('interval'),
    );
    assert.throws(
      () => checkedScheduleSpec(spec({ repeat: { cron: '0 0 L * *', tz: 'UTC' } }), hasQueue),
      rule('cron_extension'),
    );
    for (const tz of ['america/new_york', 'Mars/Olympus', 7]) {
      assert.throws(
        () => checkedScheduleSpec(spec({ repeat: { cron: '* * * * *', tz } }), hasQueue),
        rule('timezone'),
      );
    }
  });
});
