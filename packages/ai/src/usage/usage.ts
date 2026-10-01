/**
 * Normalized token usage.
 *
 * `inputTokens` counts every input token, cache reads and writes included (the
 * OpenTelemetry GenAI convention), with the cache share broken out in
 * `cacheReadTokens` and `cacheWriteTokens`. Providers disagree on whether their
 * input count includes the cache; {@link normalizeUsage} takes that as an
 * explicit flag so each adapter states its provider's convention once.
 */

import { AiError } from '../errors/ai-error.js';

/** Token usage of one response, one step, or a whole run. */
export interface AiUsage {
  /** Every input token, including cache reads and cache writes. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens served from the prompt cache. */
  readonly cacheReadTokens: number;
  /** Input tokens written to the prompt cache. */
  readonly cacheWriteTokens: number;
  /** Output tokens spent on reasoning, when the provider reports them. */
  readonly reasoningTokens?: number;
}

/** Usage as a provider reports it, before normalization. */
export interface AiRawUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  /**
   * Whether `inputTokens` already includes the cache reads and writes
   * (OpenAI-style) or counts only uncached input (Anthropic-style).
   */
  readonly inputIncludesCache: boolean;
}

/** Usage of nothing. */
export const ZERO_USAGE: AiUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** Whether `value` is a token count: a non-negative safe integer. */
export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalidUsage(field: string): AiError {
  return new AiError('invalid_options', 'a usage count must be a non-negative safe integer', {
    context: { field },
  });
}

function count(value: unknown, field: string): number {
  if (!isTokenCount(value)) throw invalidUsage(field);
  return value;
}

function sum(a: number, b: number, field: string): number {
  const total = a + b;
  if (!Number.isSafeInteger(total)) throw invalidUsage(field);
  return total;
}

/**
 * Normalize provider-reported usage to {@link AiUsage}. Throws
 * `AiError('invalid_options')` for a count that is not a non-negative safe
 * integer, or when an input count that claims to include the cache is smaller
 * than the cache share.
 */
export function normalizeUsage(raw: AiRawUsage): AiUsage {
  const input = count(raw.inputTokens, 'inputTokens');
  const output = count(raw.outputTokens, 'outputTokens');
  const cacheRead = count(raw.cacheReadTokens ?? 0, 'cacheReadTokens');
  const cacheWrite = count(raw.cacheWriteTokens ?? 0, 'cacheWriteTokens');
  const cache = sum(cacheRead, cacheWrite, 'cacheTokens');
  let inputTokens: number;
  if (raw.inputIncludesCache) {
    if (input < cache) throw invalidUsage('inputTokens');
    inputTokens = input;
  } else {
    inputTokens = sum(input, cache, 'inputTokens');
  }
  const usage: AiUsage = {
    inputTokens,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(raw.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: count(raw.reasoningTokens, 'reasoningTokens') }),
  };
  return Object.freeze(usage);
}

/**
 * Add two usages. `reasoningTokens` is kept when either side reports it (a
 * side without it counts as zero).
 */
export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  const reasoning =
    a.reasoningTokens === undefined && b.reasoningTokens === undefined
      ? undefined
      : sum(a.reasoningTokens ?? 0, b.reasoningTokens ?? 0, 'reasoningTokens');
  return Object.freeze({
    inputTokens: sum(a.inputTokens, b.inputTokens, 'inputTokens'),
    outputTokens: sum(a.outputTokens, b.outputTokens, 'outputTokens'),
    cacheReadTokens: sum(a.cacheReadTokens, b.cacheReadTokens, 'cacheReadTokens'),
    cacheWriteTokens: sum(a.cacheWriteTokens, b.cacheWriteTokens, 'cacheWriteTokens'),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  });
}

/** Whether `value` is a well-formed {@link AiUsage} (cache share within the input count). */
export function isAiUsage(value: unknown): value is AiUsage {
  if (typeof value !== 'object' || value === null) return false;
  const usage = value as Record<string, unknown>;
  if (
    !isTokenCount(usage.inputTokens) ||
    !isTokenCount(usage.outputTokens) ||
    !isTokenCount(usage.cacheReadTokens) ||
    !isTokenCount(usage.cacheWriteTokens)
  ) {
    return false;
  }
  if (usage.reasoningTokens !== undefined && !isTokenCount(usage.reasoningTokens)) return false;
  return usage.cacheReadTokens + usage.cacheWriteTokens <= usage.inputTokens;
}
