/**
 * Pricing tests: cost vectors with cache reads and writes, tiers, speeds,
 * fallback iterations at their own rates, and refusal of unpriced models.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import { costMicroUsd, createPricingTable } from '../../src/usage/pricing.js';
import type { AiUsage } from '../../src/usage/usage.js';

const pricing = createPricingTable({
  'claude-opus-5-5': {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 5,
    speeds: {
      fast: { inputPerMTok: 8, outputPerMTok: 40, cacheReadPerMTok: 0.4, cacheWritePerMTok: 10 },
    },
  },
  'claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    tiers: [{ aboveInputTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 }],
  },
  'gpt-x': { inputPerMTok: 1, outputPerMTok: 2 },
  'azure/gpt-x': { inputPerMTok: 3, outputPerMTok: 6 },
});

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0): AiUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

describe('costMicroUsd', () => {
  it('prices uncached input, cache reads, cache writes, and output separately', () => {
    // 1M uncached at $4 + 1M read at $0.20 + 1M write at $5 + 1M output at $20 = $29.20
    const cost = costMicroUsd(
      [
        {
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          usage: usage(3_000_000, 1_000_000, 1_000_000, 1_000_000),
        },
      ],
      pricing,
    );
    assert.equal(cost, 29_200_000);
  });

  it('computes small fractional costs exactly in integers', () => {
    // 3 tokens at $0.10/MTok = 0.3 micro-USD, rounded to 0; 7 at $0.50 = 3.5 -> 4 (total 3.8 -> 4)
    assert.equal(
      costMicroUsd([{ provider: 'a', model: 'claude-haiku-5-5', usage: usage(3, 7) }], pricing),
      4,
    );
    assert.equal(
      costMicroUsd(
        [{ provider: 'a', model: 'claude-haiku-5-5', usage: usage(1_000_000, 0) }],
        pricing,
      ),
      500_000,
    );
  });

  it('applies the prompt-size tier to the whole request', () => {
    assert.equal(
      costMicroUsd(
        [{ provider: 'a', model: 'claude-haiku-5-5', usage: usage(100_000, 0) }],
        pricing,
      ),
      10_000,
    );
    assert.equal(
      costMicroUsd(
        [{ provider: 'a', model: 'claude-haiku-5-5', usage: usage(200_000, 0) }],
        pricing,
      ),
      100_000,
    );
  });

  it('applies speed prices and refuses an unpriced speed', () => {
    assert.equal(
      costMicroUsd(
        [{ provider: 'a', model: 'claude-opus-5-5', speed: 'fast', usage: usage(1_000_000, 0) }],
        pricing,
      ),
      8_000_000,
    );
    assert.equal(
      costMicroUsd(
        [
          {
            provider: 'a',
            model: 'claude-opus-5-5',
            speed: 'standard',
            usage: usage(1_000_000, 0),
          },
        ],
        pricing,
      ),
      4_000_000,
    );
    assert.throws(
      () =>
        costMicroUsd(
          [{ provider: 'a', model: 'gpt-x', speed: 'fast', usage: usage(1, 1) }],
          pricing,
        ),
      (error: unknown) => error instanceof AiError && error.context.reason === 'unpriced_speed',
    );
  });

  it('prices each fallback iteration at its own model and sums them', () => {
    const cost = costMicroUsd(
      [
        { provider: 'anthropic', model: 'claude-opus-5-5', usage: usage(1_000_000, 0) },
        { provider: 'anthropic', model: 'claude-haiku-5-5', usage: usage(50_000, 0) },
      ],
      pricing,
    );
    assert.equal(cost, 4_005_000);
  });

  it('prefers a provider-qualified key and defaults cache prices to the input price', () => {
    assert.equal(
      costMicroUsd([{ provider: 'azure', model: 'gpt-x', usage: usage(1_000_000, 0) }], pricing),
      3_000_000,
    );
    assert.equal(
      costMicroUsd(
        [{ provider: 'openai', model: 'gpt-x', usage: usage(2_000_000, 0, 1_000_000) }],
        pricing,
      ),
      2_000_000,
    );
  });

  it('refuses an unpriced model so a budget cannot be bypassed', () => {
    assert.throws(
      () => costMicroUsd([{ provider: 'a', model: 'mystery', usage: usage(1, 1) }], pricing),
      (error: unknown) => error instanceof AiError && error.context.reason === 'unpriced_model',
    );
  });

  it('refuses a pricing function that returns a non-integer and malformed usage', () => {
    assert.throws(
      () => costMicroUsd([{ provider: 'a', model: 'm', usage: usage(1, 1) }], () => 1.5),
      AiError,
    );
    assert.throws(
      () => costMicroUsd([{ provider: 'a', model: 'm', usage: usage(1, 1) }], () => -1),
      AiError,
    );
    assert.throws(
      () => costMicroUsd([{ provider: 'a', model: 'm', usage: usage(1, 1, 5) }], () => 0),
      AiError,
    );
    assert.equal(
      costMicroUsd([], () => 0),
      0,
    );
  });
});

describe('createPricingTable', () => {
  it('rejects invalid prices and unordered tiers', () => {
    for (const table of [
      { m: { inputPerMTok: -1, outputPerMTok: 1 } },
      { m: { inputPerMTok: Number.NaN, outputPerMTok: 1 } },
      {
        m: {
          inputPerMTok: 1,
          outputPerMTok: 1,
          tiers: [
            { aboveInputTokens: 10, inputPerMTok: 1, outputPerMTok: 1 },
            { aboveInputTokens: 5, inputPerMTok: 1, outputPerMTok: 1 },
          ],
        },
      },
    ]) {
      assert.throws(
        () => createPricingTable(table),
        (error: unknown) => error instanceof AiError && error.code === 'invalid_options',
      );
    }
  });
});
