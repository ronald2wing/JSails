/**
 * Readers for the request fields every model call shares: the model, the
 * instructions, the output-token cap, effort, reasoning display, stop
 * sequences, the prompt-cache mode, timeouts, and propagation headers.
 *
 * `run`, `countTokens`, and `generateObject` validate their options through
 * these, so one field is judged the same way everywhere. Each reader takes
 * the caller's `invalid(reason)` factory, which builds the value-free
 * `AiError` that caller raises; the reason is a static field name.
 */

import type { AiError } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import { AI_EFFORTS, type AiEffort } from '../content/types.js';
import type { AiInstruction, AiModel } from './contract.js';

/** Builds the caller's value-free error for a bad field. */
export type InvalidField = (reason: string) => AiError;

/** The output-token cap of one call when the caller sets none. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/** The longest delay a timer can hold, in milliseconds. */
export const MAX_TIMER_MS = 2_147_483_647;

/** The longest stop sequence accepted, in characters. */
const MAX_STOP_SEQUENCE_LENGTH = 1_000;

/** An HTTP header field name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;

/** A header value with no control characters other than tab. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-￿]{0,8192}$/;

/** The model: a provider and a non-empty model id. */
export function readModel(value: unknown, invalid: InvalidField): AiModel {
  if (typeof value !== 'object' || value === null) throw invalid('model');
  const model = value as { readonly id?: unknown; readonly provider?: unknown };
  if (typeof model.id !== 'string' || model.id.length === 0 || model.id.length > 256) {
    throw invalid('model');
  }
  const provider = model.provider;
  if (typeof provider !== 'object' || provider === null) throw invalid('model');
  const shape = provider as Record<string, unknown>;
  if (
    typeof shape.id !== 'string' ||
    shape.id.length === 0 ||
    typeof shape.capabilities !== 'object' ||
    shape.capabilities === null
  ) {
    throw invalid('model');
  }
  return value as AiModel;
}

/** Instructions as a list of frozen blocks; blank text is dropped. */
export function readInstructions(value: unknown, invalid: InvalidField): readonly AiInstruction[] {
  if (value === undefined) return Object.freeze([]);
  if (typeof value === 'string') {
    return Object.freeze(value.trim().length === 0 ? [] : [Object.freeze({ text: value })]);
  }
  if (!Array.isArray(value)) throw invalid('instructions');
  const blocks: AiInstruction[] = [];
  for (const block of value as readonly unknown[]) {
    if (
      !isPlainObject(block) ||
      typeof block.text !== 'string' ||
      (block.cache !== undefined && block.cache !== true)
    ) {
      throw invalid('instructions');
    }
    blocks.push(
      Object.freeze(
        block.cache === true ? { text: block.text, cache: true } : { text: block.text },
      ),
    );
  }
  return Object.freeze(blocks);
}

/** A positive safe integer, or `fallback` when absent. */
export function readPositiveInteger(
  value: unknown,
  fallback: number,
  reason: string,
  invalid: InvalidField,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(reason);
  }
  return value;
}

/** The output-token cap of one call (default {@link DEFAULT_MAX_OUTPUT_TOKENS}). */
export function readMaxOutputTokens(value: unknown, invalid: InvalidField): number {
  return readPositiveInteger(value, DEFAULT_MAX_OUTPUT_TOKENS, 'max_output_tokens', invalid);
}

/** One of {@link AI_EFFORTS}, or `undefined`. */
export function readEffort(value: unknown, invalid: InvalidField): AiEffort | undefined {
  if (value === undefined) return undefined;
  if (!AI_EFFORTS.includes(value as AiEffort)) throw invalid('effort');
  return value as AiEffort;
}

/** How reasoning is displayed, or `undefined`. */
export function readReasoning(
  value: unknown,
  invalid: InvalidField,
): 'omitted' | 'summarized' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'omitted' && value !== 'summarized') throw invalid('reasoning');
  return value;
}

/** The prompt-cache mode (default `auto`). */
export function readCacheMode(value: unknown, invalid: InvalidField): 'auto' | 'off' {
  if (value === undefined) return 'auto';
  if (value !== 'auto' && value !== 'off') throw invalid('cache');
  return value;
}

/** A timeout in milliseconds: 0 means none; absent means `fallback`. */
export function readTimeout(
  value: unknown,
  fallback: number,
  reason: string,
  invalid: InvalidField,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMER_MS
  ) {
    throw invalid(reason);
  }
  return value;
}

/** Non-empty stop sequences, frozen, or `undefined`. */
export function readStopSequences(
  value: unknown,
  invalid: InvalidField,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid('stop_sequences');
  const sequences: string[] = [];
  for (const sequence of value as readonly unknown[]) {
    if (
      typeof sequence !== 'string' ||
      sequence.length === 0 ||
      sequence.length > MAX_STOP_SEQUENCE_LENGTH
    ) {
      throw invalid('stop_sequences');
    }
    sequences.push(sequence);
  }
  return Object.freeze(sequences);
}

/**
 * Propagation headers (traceparent, tracestate, baggage) as a frozen copy.
 * A name must be an HTTP token and a value must hold no line break, so a
 * header can never split a request.
 */
export function readHeaders(
  value: unknown,
  invalid: InvalidField,
): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) throw invalid('headers');
  const headers: Record<string, string> = {};
  for (const [name, field] of Object.entries(value)) {
    if (!HEADER_NAME.test(name) || typeof field !== 'string' || !HEADER_VALUE.test(field)) {
      throw invalid('headers');
    }
    Object.defineProperty(headers, name, { value: field, enumerable: true });
  }
  return Object.freeze(headers);
}
