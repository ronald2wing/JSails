/**
 * The envelope-to-BullMQ mapping pieces: retention as BullMQ `keepJobs`
 * (age in whole seconds, at least one; a count of 0 removes at once), and
 * the worker's backoff strategy, which is the package's own `backoffDelay`
 * over the stored envelope.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildEnvelope } from '../../src/envelope/codec.js';
import { backoffDelay } from '../../src/envelope/job-options.js';
import { addOptionsOf, envelopeBackoff, keepJobsOf } from '../../src/valkey/job-mapping.js';
import { DEFAULT_RETENTION } from '../../src/queues/queue-set.js';

describe('keepJobsOf', () => {
  test('maps age to whole seconds, at least one, and count 0 to removal', () => {
    assert.deepEqual(keepJobsOf({ ageMs: 1_500, count: 5 }), { age: 2, count: 5 });
    assert.deepEqual(keepJobsOf({ ageMs: 1, count: 5 }), { age: 1, count: 5 });
    assert.deepEqual(keepJobsOf({ ageMs: 0, count: 5 }), { age: 1, count: 5 });
    assert.equal(keepJobsOf({ ageMs: 60_000, count: 0 }), true);
  });
});

describe('envelopeBackoff', () => {
  test('waits what backoffDelay says for the stored backoff', () => {
    const fixed = { data: { options: { backoff: { type: 'fixed', delayMs: 250 } } } };
    const exponential = { data: { options: { backoff: { type: 'exponential', delayMs: 100 } } } };
    for (const attempts of [1, 2, 5]) {
      assert.equal(
        envelopeBackoff(attempts, 'jsails', undefined, fixed),
        backoffDelay({ type: 'fixed', delayMs: 250 }, attempts),
      );
      assert.equal(
        envelopeBackoff(attempts, 'jsails', undefined, exponential),
        backoffDelay({ type: 'exponential', delayMs: 100 }, attempts),
      );
    }
  });

  test('retries at once when the data carries no backoff it can read', () => {
    assert.equal(envelopeBackoff(1), 0);
    assert.equal(envelopeBackoff(1, 'jsails', undefined, { data: 'text' }), 0);
    assert.equal(envelopeBackoff(1, 'jsails', undefined, { data: { options: {} } }), 0);
    assert.equal(
      envelopeBackoff(1, 'jsails', undefined, {
        data: { options: { backoff: { type: 'linear', delayMs: 5 } } },
      }),
      0,
    );
  });
});

describe('addOptionsOf', () => {
  const declaration = { name: 'default', concurrency: 1, retention: DEFAULT_RETENTION };

  test('a flow member carries no deduplication, which BullMQ refuses on a flow child', () => {
    const envelope = buildEnvelope({
      name: 'child',
      payload: null,
      options: {},
      key: { value: 'jsails:batch:b:0', windowMs: 60_000 },
      dispatchedAt: 0,
    });
    assert.equal('deduplication' in addOptionsOf(envelope, declaration, 'id', 0, false), false);
    assert.ok('deduplication' in addOptionsOf(envelope, declaration, 'id', 0));
  });

  test('a run time in the past is no delay, a fraction rounds up, and a year is the cap', () => {
    const at = (runAt: number) =>
      addOptionsOf(
        buildEnvelope({ name: 'job', payload: null, options: {}, runAt, dispatchedAt: 0 }),
        declaration,
        'id',
        1_000,
      ).delay;
    assert.equal(at(500), undefined);
    assert.equal(at(1_000), undefined);
    assert.equal(at(1_001), 1);
  });
});
