/**
 * Fire times: interval slots aligned to the anchor, cron fires on the
 * evaluator (patterns parsed once and cached), the fired envelope keyed by
 * its slot, and repeat equality.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildEnvelope } from '../../src/envelope/codec.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import { FLOW_KEY_WINDOW_MS } from '../../src/flows/flow-limits.js';
import {
  cronSpecOf,
  firedEnvelope,
  nextFireAfter,
  repeatEquals,
} from '../../src/schedules/fire-times.js';

describe('fire times', () => {
  test('interval slots are aligned to the anchor and strictly after', () => {
    const repeat = { everyMs: 60_000 };
    assert.equal(nextFireAfter(repeat, 1_000, 0), 61_000);
    assert.equal(nextFireAfter(repeat, 1_000, 1_000), 61_000);
    assert.equal(nextFireAfter(repeat, 1_000, 60_999), 61_000);
    assert.equal(nextFireAfter(repeat, 1_000, 61_000), 121_000);
    assert.equal(nextFireAfter(repeat, 1_000, 250_000), 301_000);
  });

  test('cron fires come from the evaluator, never before the anchor', () => {
    const repeat = { cron: '0 * * * *', tz: 'UTC' };
    const anchor = Date.parse('2024-01-01T05:30:00Z');
    assert.equal(nextFireAfter(repeat, anchor, 0), Date.parse('2024-01-01T06:00:00Z'));
    assert.equal(
      nextFireAfter(repeat, anchor, Date.parse('2024-01-01T06:00:00Z')),
      Date.parse('2024-01-01T07:00:00Z'),
    );
  });

  test('a pattern is parsed once; a bad one is refused with its problem', () => {
    assert.equal(cronSpecOf('*/5 * * * *'), cronSpecOf('*/5 * * * *'));
    assert.throws(
      () => cronSpecOf('0 0 L * *'),
      (error: unknown) =>
        JobsErrors.is(error, 'invalid_schedule') && error.context.rule === 'cron_extension',
    );
  });

  test('the parse cache is bounded', () => {
    const first = cronSpecOf('0 0 * * *');
    for (let minute = 0; minute < 1_000; minute += 1) {
      cronSpecOf(`${minute % 60} ${Math.floor(minute / 60) % 24} * * *`);
      cronSpecOf(`${minute % 60} ${Math.floor(minute / 60) % 24} * * * `);
    }
    assert.deepEqual(cronSpecOf('0 0 * * *'), first);
  });

  test('a fire is the stored job keyed by its slot, without context or run time', () => {
    const stored = buildEnvelope({
      name: 'digest',
      payload: { n: 1 },
      options: { attempts: 2 },
      tags: ['t'],
      overlap: { key: 'o', ttlMs: 1_000 },
      dispatchedAt: 0,
    });
    const fired = firedEnvelope(stored, 'daily', 60_000, 61_000);
    assert.deepEqual(fired.meta, {
      key: 'jsails:schedule:daily:60000',
      keyWindowMs: FLOW_KEY_WINDOW_MS,
      tags: ['t'],
      overlap: { key: 'o', ttlMs: 1_000 },
      dispatchedAt: 61_000,
    });
    assert.deepEqual(
      [fired.name, fired.payload, fired.options],
      ['digest', { n: 1 }, { attempts: 2 }],
    );
    const bare = firedEnvelope(
      buildEnvelope({ name: 'digest', payload: null, options: {}, dispatchedAt: 0 }),
      'daily',
      1,
      2,
    );
    assert.deepEqual(Object.keys(bare.meta).sort(), ['dispatchedAt', 'key', 'keyWindowMs']);
  });

  test('repeat equality compares kind and every field', () => {
    assert.equal(repeatEquals({ everyMs: 1_000 }, { everyMs: 1_000 }), true);
    assert.equal(repeatEquals({ everyMs: 1_000 }, { everyMs: 2_000 }), false);
    assert.equal(repeatEquals({ everyMs: 1_000 }, { cron: '* * * * *', tz: 'UTC' }), false);
    assert.equal(
      repeatEquals({ cron: '* * * * *', tz: 'UTC' }, { cron: '* * * * *', tz: 'UTC' }),
      true,
    );
    assert.equal(
      repeatEquals({ cron: '* * * * *', tz: 'UTC' }, { cron: '* * * * *', tz: 'Asia/Tokyo' }),
      false,
    );
    assert.equal(repeatEquals({ cron: '* * * * *', tz: 'UTC' }, { everyMs: 1_000 }), false);
  });
});
