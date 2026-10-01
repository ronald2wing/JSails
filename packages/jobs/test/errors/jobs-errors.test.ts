/**
 * The `jobs.*` registry: the kinds that decide whether a failed attempt is
 * retried, and messages rendered from declared slots only.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isRetryableKind } from 'jsails/errors';

import { JobsErrors, type JobsErrorCode } from '../../src/errors/jobs-errors.js';

describe('JobsErrors', () => {
  test('the kinds that decide retries', () => {
    const expected: readonly [JobsErrorCode, string, boolean][] = [
      ['invalid_payload', 'invalid', false],
      ['invalid_option', 'invalid', false],
      ['unknown_job', 'not_found', false],
      ['invalid_envelope', 'invalid', false],
      ['attempt_timeout', 'timeout', true],
      ['worker_aborted', 'aborted', true],
      ['producer_closed', 'unavailable', true],
      ['adapter_closed', 'unavailable', true],
      ['command_threw', 'internal', true],
    ];
    for (const [code, kind, retryable] of expected) {
      assert.equal(JobsErrors.codes[code].kind, kind, code);
      assert.equal(isRetryableKind(JobsErrors.codes[code].kind), retryable, code);
    }
    assert.equal(new JobsErrors.Error('unknown_job').name, 'JobsError');
  });

  test('messages render from declared slots only', () => {
    const option = new JobsErrors.Error('invalid_option', { option: 'timeoutMs' });
    assert.equal(option.code, 'jobs.invalid_option');
    assert.equal(option.message, 'job option timeoutMs is invalid');
    const queue = new JobsErrors.Error('undeclared_queue', { job: 'report', queue: 'mail' });
    assert.equal(queue.message, 'job report names queue mail, which is not declared');
    assert.throws(() => new JobsErrors.Error('invalid_option', { option: 'has spaces MARKER' }));
    assert.throws(() => new JobsErrors.Error('invalid_definition', { rule: 'MARKER' as 'shape' }));
  });

  test('is() recognizes a code of the registry', () => {
    const error = new JobsErrors.Error('unknown_job');
    assert.equal(JobsErrors.is(error), true);
    assert.equal(JobsErrors.is(error, 'unknown_job'), true);
    assert.equal(JobsErrors.is(error, 'invalid_payload'), false);
    assert.equal(JobsErrors.is(new Error('x')), false);
  });
});
