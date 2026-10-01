/**
 * Checks on what a provider returns: {@link checkProviderResponse} for the
 * response envelope and {@link readResponseMessage} for its assistant
 * message.
 *
 * A provider is code the app chose, but its output is still checked at the
 * boundary: a malformed response is `AiError('provider_failed')` with a
 * static reason, never a crash further down the loop and never an echo of
 * what the provider sent.
 */

import { AiError } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import { AI_FINISH_REASONS, type AiFinishReason, type AiMessage } from '../content/types.js';
import { readMessage } from '../content/validate-messages.js';
import { isAiUsage } from '../usage/usage.js';
import type { AiProviderResponse } from './contract.js';

/** The value-free error for a provider that broke the contract. */
export function providerFailed(reason: string): AiError {
  return new AiError('provider_failed', 'the provider returned a malformed response', {
    context: { reason },
  });
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isIteration(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isLabel(value.provider) &&
    isLabel(value.model) &&
    (value.speed === undefined || isLabel(value.speed)) &&
    isAiUsage(value.usage)
  );
}

/**
 * Check a response envelope: ids, finish reason, usage, iterations, the
 * refusal detail, and an assistant message object. The message content is
 * checked separately, once the finish reason says it should be usable.
 */
export function checkProviderResponse(value: unknown): AiProviderResponse {
  if (!isPlainObject(value)) throw providerFailed('response');
  if (!isLabel(value.id) || !isLabel(value.model)) throw providerFailed('response_id');
  if (!AI_FINISH_REASONS.includes(value.finishReason as AiFinishReason)) {
    throw providerFailed('finish_reason');
  }
  if (!isAiUsage(value.usage)) throw providerFailed('usage');
  if (!Array.isArray(value.iterations) || !(value.iterations as unknown[]).every(isIteration)) {
    throw providerFailed('iterations');
  }
  if (value.refusal !== undefined) {
    const refusal = value.refusal;
    if (!isPlainObject(refusal) || (refusal.category !== null && !isLabel(refusal.category))) {
      throw providerFailed('refusal');
    }
  }
  if (!isPlainObject(value.message) || value.message.role !== 'assistant') {
    throw providerFailed('message');
  }
  return value as unknown as AiProviderResponse;
}

/**
 * The response's assistant message, normalized and frozen, with `meta`
 * describing how it was produced (provider, model, response id, finish
 * reason, usage). A malformed message is a provider failure.
 */
export function readResponseMessage(
  response: AiProviderResponse,
  providerId: string,
  index: number,
): AiMessage {
  try {
    return readMessage(
      {
        role: 'assistant',
        parts: response.message.parts,
        ...(response.message.native === undefined ? {} : { native: response.message.native }),
        meta: {
          provider: providerId,
          model: response.model,
          responseId: response.id,
          finishReason: response.finishReason,
          usage: response.usage,
        },
      },
      index,
    );
  } catch {
    throw providerFailed('message');
  }
}
