/**
 * The provider stream contract as the run enforces it: part order, unknown
 * parts, tool-input deltas, parts after the end, a missing end, malformed
 * responses, thrown errors (value-free, codes passed through), and closing
 * the provider's iterator when a stream is abandoned.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import type { AiProviderStreamPart } from '../../src/provider/contract.js';
import { generate } from '../../src/run/run.js';
import { BASE_USAGE, scriptedProvider } from './scripted-provider.js';

const CANARY = 'CANARY-stream-7f3a';

const end = {
  type: 'response-end',
  response: {
    id: 'r',
    model: 'm',
    message: { role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
    finishReason: 'stop',
    usage: BASE_USAGE,
    iterations: [{ provider: 'scripted', model: 'm', usage: BASE_USAGE }],
  },
};
const start = { type: 'response-start', id: 'r', model: 'm' };

async function failureOf(parts: readonly unknown[]): Promise<AiError | undefined> {
  const provider = scriptedProvider([{ parts }]);
  const result = await generate({ model: provider.model(), input: `Hi ${CANARY}` });
  assert.equal(result.status, 'failed');
  return result.error;
}

describe('run: the provider stream contract', () => {
  it('accepts a well-formed stream', async () => {
    const provider = scriptedProvider([
      { parts: [start, { type: 'text-delta', delta: 'hi' }, end] },
    ]);
    const result = await generate({ model: provider.model(), input: 'Hi' });
    assert.equal(result.status, 'completed');
  });

  it('turns every contract break into a value-free provider_failed', async () => {
    const cases: readonly [string, readonly unknown[]][] = [
      ['part_order', [{ type: 'text-delta', delta: 'x' }, end]],
      ['response_start', [start, start, end]],
      ['part_type', [start, { type: 'mystery' }, end]],
      ['part', [start, 'text', end]],
      ['delta', [start, { type: 'text-delta', delta: 3 }, end]],
      ['tool_input_delta', [start, { type: 'tool-input-delta', id: 'x', delta: '{' }, end]],
      [
        'tool_input_start',
        [
          start,
          { type: 'tool-input-start', id: 'x', name: 't' },
          { type: 'tool-input-start', id: 'x', name: 't' },
          end,
        ],
      ],
      ['part_after_end', [start, end, { type: 'text-delta', delta: 'late' }]],
      ['no_response_end', [start, { type: 'text-delta', delta: 'x' }]],
      ['iterations', [start, { ...end, response: { ...end.response, iterations: [{}] } }]],
      ['usage', [start, { ...end, response: { ...end.response, usage: { inputTokens: -1 } } }]],
      ['finish_reason', [start, { ...end, response: { ...end.response, finishReason: 'odd' } }]],
      [
        'message',
        [
          start,
          { ...end, response: { ...end.response, message: { role: 'assistant', parts: [] } } },
        ],
      ],
    ];
    for (const [reason, parts] of cases) {
      const error = await failureOf(parts);
      assert.equal(error?.code, 'provider_failed', reason);
      assert.equal(error?.context.reason, reason);
      assert.equal(`${error?.message}${JSON.stringify(error?.context)}`.includes(CANARY), false);
    }
  });

  it('maps thrown errors: unknown ones value-free, AiError codes passed through', async () => {
    const unknown = scriptedProvider([{ error: new Error(CANARY) }]);
    const failed = await generate({ model: unknown.model(), input: 'Hi' });
    assert.equal(failed.error?.code, 'provider_failed');
    assert.equal(failed.error?.message.includes(CANARY), false);

    const limited = scriptedProvider([
      { error: new AiError('rate_limited', 'rate limited', { retryAfterMs: 2000 }) },
    ]);
    const result = await generate({ model: limited.model(), input: 'Hi' });
    assert.equal(result.error?.code, 'rate_limited');
    assert.equal(result.error?.retryAfterMs, 2000);
  });

  it('maps a provider whose stream() throws synchronously', async () => {
    const provider = scriptedProvider([{ text: 'x' }]);
    const broken = {
      ...provider,
      stream(): AsyncIterable<AiProviderStreamPart> {
        throw new Error(CANARY);
      },
    };
    const result = await generate({ model: { provider: broken, id: 'm' }, input: 'Hi' });
    assert.equal(result.error?.code, 'provider_failed');
  });

  it('closes the provider iterator when the stream breaks the contract', async () => {
    let closed = false;
    const provider = scriptedProvider([{ text: 'x' }]);
    const leaky = {
      ...provider,
      stream(): AsyncIterable<AiProviderStreamPart> {
        let sent = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              sent += 1;
              return sent === 1
                ? { done: false, value: { type: 'bogus' } as unknown as AiProviderStreamPart }
                : { done: true, value: undefined };
            },
            return: async () => {
              closed = true;
              return { done: true, value: undefined };
            },
          }),
        };
      },
    };
    const result = await generate({ model: { provider: leaky, id: 'm' }, input: 'Hi' });
    assert.equal(result.error?.code, 'provider_failed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(closed, true);
  });
});
