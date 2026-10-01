/**
 * `AiError` tests: code, value-free context, retryAfterMs sanitizing, and the
 * code list.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JsailsError } from 'jsails/errors';

import { AI_ERROR_CODES, AiError, isAiError } from '../../src/errors/ai-error.js';

describe('AiError', () => {
  it('carries its code, context, suggestion, and a valid retryAfterMs', () => {
    const error = new AiError('rate_limited', 'rate limited', {
      retryAfterMs: 1500,
      context: { attempt: 2 },
      suggestion: 'Wait and retry.',
    });
    assert.ok(error instanceof JsailsError);
    assert.equal(error.name, 'AiError');
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.retryAfterMs, 1500);
    assert.deepEqual(error.context, { attempt: 2 });
    assert.equal(error.suggestion, 'Wait and retry.');
  });

  it('drops a retryAfterMs that is not a non-negative safe integer', () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        new AiError('rate_limited', 'x', { retryAfterMs: value }).retryAfterMs,
        undefined,
      );
    }
    assert.equal(new AiError('aborted', 'x').retryAfterMs, undefined);
  });

  it('narrows by code with isAiError', () => {
    const error = new AiError('refused', 'refused');
    assert.equal(isAiError(error), true);
    assert.equal(isAiError(error, 'refused', 'aborted'), true);
    assert.equal(isAiError(error, 'aborted'), false);
    assert.equal(isAiError(new Error('x')), false);
  });

  it('lists every code once, including context_length_exceeded', () => {
    assert.equal(new Set(AI_ERROR_CODES).size, AI_ERROR_CODES.length);
    assert.ok(AI_ERROR_CODES.includes('context_length_exceeded'));
    assert.ok(Object.isFrozen(AI_ERROR_CODES));
  });
});
