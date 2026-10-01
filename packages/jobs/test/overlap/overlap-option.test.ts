/**
 * The overlap option: `true` takes the default TTL and the fallback key, a
 * record takes a fixed key or a function of the parsed payload and a TTL of
 * 1 s to 1 h, and every refusal is `invalid_option` naming `overlap`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_OVERLAP_TTL_MS,
  MAX_OVERLAP_TTL_MS,
  MIN_OVERLAP_TTL_MS,
} from '../../src/envelope/job-options.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import { overlapFor, resolveOverlapOption } from '../../src/overlap/overlap-option.js';

const refused = (error: unknown) =>
  JobsErrors.is(error, 'invalid_option') && error.context.option === 'overlap';

describe('overlap option', () => {
  test('absent is none; true is the default TTL with the fallback key', () => {
    assert.equal(resolveOverlapOption(undefined), undefined);
    assert.deepEqual(resolveOverlapOption(true), {
      key: undefined,
      ttlMs: DEFAULT_OVERLAP_TTL_MS,
    });
  });

  test('a record keeps its key and TTL', () => {
    assert.deepEqual(resolveOverlapOption({}), { key: undefined, ttlMs: DEFAULT_OVERLAP_TTL_MS });
    assert.deepEqual(resolveOverlapOption({ key: 'k', ttlMs: MIN_OVERLAP_TTL_MS }), {
      key: 'k',
      ttlMs: MIN_OVERLAP_TTL_MS,
    });
    const key = (payload: unknown) => `p:${String(payload)}`;
    assert.equal(resolveOverlapOption({ key, ttlMs: MAX_OVERLAP_TTL_MS })?.key, key);
  });

  test('refuses anything else', () => {
    for (const value of [
      false,
      null,
      [],
      'k',
      { key: 'k', extra: 1 },
      { ttlMs: MIN_OVERLAP_TTL_MS - 1 },
      { ttlMs: MAX_OVERLAP_TTL_MS + 1 },
      { key: '' },
      { key: 7 },
    ]) {
      assert.throws(() => resolveOverlapOption(value), refused, JSON.stringify(value));
    }
  });

  test('overlapFor resolves the fixed, fallback or computed key', () => {
    assert.deepEqual(overlapFor({ key: 'fixed', ttlMs: 2_000 }, 'job', null), {
      key: 'fixed',
      ttlMs: 2_000,
    });
    assert.deepEqual(overlapFor({ key: undefined, ttlMs: 2_000 }, 'job', null), {
      key: 'job',
      ttlMs: 2_000,
    });
    const computed = overlapFor(
      { key: (payload) => `tenant:${(payload as { id: number }).id}`, ttlMs: 2_000 },
      'job',
      { id: 4 },
    );
    assert.deepEqual(computed, { key: 'tenant:4', ttlMs: 2_000 });
    assert.ok(Object.isFrozen(computed));
  });

  test('a key function that throws or returns no key is refused, its error as the cause', () => {
    const failure = new Error('boom');
    assert.throws(
      () =>
        overlapFor(
          {
            key: () => {
              throw failure;
            },
            ttlMs: 2_000,
          },
          'job',
          null,
        ),
      (error: unknown) => refused(error) && (error as Error).cause === failure,
    );
    assert.throws(() => overlapFor({ key: () => '', ttlMs: 2_000 }, 'job', null), refused);
  });
});
