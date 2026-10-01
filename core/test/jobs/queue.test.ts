/** Tests for the shared job-option policy: retention defaults and option validation. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defaultJobOptions,
  JobOptionsError,
  validateJobOptions,
  validateJobRetention,
} from '../../src/jobs/queue.js';

describe('defaultJobOptions', () => {
  it('bounds completed and failed job retention by default', () => {
    assert.deepEqual(defaultJobOptions(), {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 604_800, count: 5000 },
    });
  });

  it('takes per-queue retention overrides', () => {
    const options = defaultJobOptions({ removeOnComplete: true, removeOnFail: { count: 50 } });
    assert.equal(options.removeOnComplete, true);
    assert.deepEqual(options.removeOnFail, { count: 50 });
  });
});

describe('validateJobRetention', () => {
  it('accepts booleans, counts, and age/count objects', () => {
    assert.equal(validateJobRetention(false, 'r'), false);
    assert.equal(validateJobRetention(10, 'r'), 10);
    assert.deepEqual(validateJobRetention({ count: 5 }, 'r'), { count: 5 });
    assert.deepEqual(validateJobRetention({ age: 60, limit: 100 }, 'r'), { age: 60, limit: 100 });
  });

  it('rejects malformed retention', () => {
    for (const value of [-1, 1.5, 'forever', null, {}, { age: -1 }, { limit: 3 }, { ttl: 5 }]) {
      assert.throws(() => validateJobRetention(value, 'r'), JobOptionsError, String(value));
    }
  });
});

describe('validateJobOptions retention and log bounds', () => {
  it('validates instead of forwarding verbatim', () => {
    assert.deepEqual(validateJobOptions({ removeOnFail: { count: 3 }, keepLogs: 10 }), {
      removeOnFail: { count: 3 },
      keepLogs: 10,
    });
    for (const opts of [
      { removeOnComplete: 'yes' },
      { keepLogs: -1 },
      { stackTraceLimit: 1000 },
      { sizeLimit: 0 },
    ]) {
      assert.throws(() => validateJobOptions(opts), JobOptionsError, JSON.stringify(opts));
    }
  });
});
