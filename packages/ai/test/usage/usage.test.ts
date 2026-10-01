/**
 * Usage tests: the normalization table for both provider conventions,
 * addition, and well-formedness.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import { ZERO_USAGE, addUsage, isAiUsage, normalizeUsage } from '../../src/usage/usage.js';

describe('normalizeUsage', () => {
  it('adds the cache to an input count that excludes it (Anthropic convention)', () => {
    assert.deepEqual(
      normalizeUsage({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
        inputIncludesCache: false,
      }),
      { inputTokens: 130, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 },
    );
  });

  it('keeps an input count that already includes the cache (OpenAI convention)', () => {
    assert.deepEqual(
      normalizeUsage({
        inputTokens: 130,
        outputTokens: 5,
        cacheReadTokens: 100,
        reasoningTokens: 3,
        inputIncludesCache: true,
      }),
      {
        inputTokens: 130,
        outputTokens: 5,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        reasoningTokens: 3,
      },
    );
  });

  it('rejects malformed counts and an input smaller than its cache share', () => {
    for (const raw of [
      { inputTokens: -1, outputTokens: 0, inputIncludesCache: true },
      { inputTokens: 1.5, outputTokens: 0, inputIncludesCache: true },
      { inputTokens: 1, outputTokens: Number.NaN, inputIncludesCache: true },
      { inputTokens: 5, outputTokens: 0, cacheReadTokens: 10, inputIncludesCache: true },
      {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 0,
        cacheReadTokens: 1,
        inputIncludesCache: false,
      },
    ]) {
      assert.throws(
        () => normalizeUsage(raw),
        (error: unknown) => error instanceof AiError && error.code === 'invalid_options',
      );
    }
  });
});

describe('addUsage', () => {
  it('sums every field and keeps reasoning when either side has it', () => {
    const a = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 };
    const b = {
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 4,
      reasoningTokens: 7,
    };
    assert.deepEqual(addUsage(a, b), {
      inputTokens: 15,
      outputTokens: 3,
      cacheReadTokens: 3,
      cacheWriteTokens: 5,
      reasoningTokens: 7,
    });
    assert.deepEqual(addUsage(ZERO_USAGE, a), a);
    assert.equal('reasoningTokens' in addUsage(a, a), false);
  });
});

describe('isAiUsage', () => {
  it('accepts well-formed usage only', () => {
    assert.equal(isAiUsage(ZERO_USAGE), true);
    assert.equal(
      isAiUsage({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 1 }),
      false,
    );
    assert.equal(isAiUsage({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 0 }), false);
    assert.equal(isAiUsage(null), false);
  });
});
