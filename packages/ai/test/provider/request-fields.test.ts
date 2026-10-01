/**
 * The shared request-field readers and provider-response checks: defaults,
 * frozen copies, header injection refusal, and value-free reasons.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import {
  checkProviderResponse,
  readResponseMessage,
} from '../../src/provider/provider-response.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  readCacheMode,
  readHeaders,
  readInstructions,
  readMaxOutputTokens,
  readModel,
  readStopSequences,
  readTimeout,
} from '../../src/provider/request-fields.js';

const invalid = (reason: string): AiError =>
  new AiError('invalid_options', 'invalid', { context: { reason } });

function reasonOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error instanceof AiError ? error.context.reason : 'not-ai-error';
  }
  return undefined;
}

describe('request-field readers', () => {
  it('apply defaults and freeze what they return', () => {
    assert.equal(readMaxOutputTokens(undefined, invalid), DEFAULT_MAX_OUTPUT_TOKENS);
    assert.equal(readCacheMode(undefined, invalid), 'auto');
    assert.equal(readTimeout(undefined, 7, 'timeout', invalid), 7);
    const instructions = readInstructions([{ text: 'a', cache: true }, { text: 'b' }], invalid);
    assert.deepEqual(instructions, [{ text: 'a', cache: true }, { text: 'b' }]);
    assert.ok(Object.isFrozen(instructions) && Object.isFrozen(instructions[0]));
    assert.deepEqual(readInstructions('   ', invalid), []);
    const headers = readHeaders({ traceparent: '00-a-b-01' }, invalid);
    assert.ok(Object.isFrozen(headers));
    assert.deepEqual(readStopSequences(['END'], invalid), ['END']);
  });

  it('refuse malformed fields with a static reason', () => {
    assert.equal(
      reasonOf(() => readHeaders({ a: 'x\ny' }, invalid)),
      'headers',
    );
    assert.equal(
      reasonOf(() => readHeaders({ 'a b': 'x' }, invalid)),
      'headers',
    );
    assert.equal(
      reasonOf(() => readHeaders({ a: 1 }, invalid)),
      'headers',
    );
    assert.equal(
      reasonOf(() => readInstructions([{ text: 'a', cache: 'yes' }], invalid)),
      'instructions',
    );
    assert.equal(
      reasonOf(() => readModel({ id: '', provider: {} }, invalid)),
      'model',
    );
    assert.equal(
      reasonOf(() => readModel({ id: 'm', provider: { id: 'p' } }, invalid)),
      'model',
    );
    assert.equal(
      reasonOf(() => readTimeout(2 ** 31, 0, 'timeout', invalid)),
      'timeout',
    );
    assert.equal(
      reasonOf(() => readStopSequences('END', invalid)),
      'stop_sequences',
    );
  });
});

describe('provider response checks', () => {
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const response = {
    id: 'r',
    model: 'm',
    message: { role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
    finishReason: 'stop',
    usage,
    iterations: [{ provider: 'p', model: 'm', speed: 'fast', usage }],
    refusal: { category: null },
  };

  it('accepts a well-formed response and stamps meta on its message', () => {
    const checked = checkProviderResponse(response);
    const message = readResponseMessage(checked, 'p', 3);
    assert.deepEqual(message.meta, {
      provider: 'p',
      model: 'm',
      responseId: 'r',
      finishReason: 'stop',
      usage,
    });
  });

  it('names the failing field without echoing it', () => {
    assert.equal(
      reasonOf(() => checkProviderResponse({ ...response, refusal: { category: 3 } })),
      'refusal',
    );
    assert.equal(
      reasonOf(() => checkProviderResponse({ ...response, id: '' })),
      'response_id',
    );
    assert.equal(
      reasonOf(() => checkProviderResponse({ ...response, message: { role: 'user', parts: [] } })),
      'message',
    );
    assert.equal(
      reasonOf(() => checkProviderResponse([])),
      'response',
    );
  });
});
