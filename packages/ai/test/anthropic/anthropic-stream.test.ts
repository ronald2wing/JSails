/**
 * Raw Messages API event accumulation: event order, deltas applied to the
 * wrong block, open blocks, truncated and stopped streams, unknown events
 * and block types, model_context_window_exceeded, and the fallback echo form.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import type { AiProviderStreamPart } from '../../src/provider/contract.js';
import { readAnthropicStream } from '../../src/anthropic/anthropic-stream.js';

const start = {
  type: 'message_start',
  message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 1 } },
};
const stop = { type: 'message_stop' };

function delta(stopReason: string): unknown {
  return { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } };
}

async function read(events: readonly unknown[], signal = new AbortController().signal) {
  const parts: AiProviderStreamPart[] = [];
  for await (const part of readAnthropicStream(
    (async function* () {
      yield* events;
    })(),
    signal,
  )) {
    parts.push(part);
  }
  return parts;
}

async function failsWith(events: readonly unknown[], reason: string): Promise<void> {
  await assert.rejects(read(events), (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, 'provider_failed');
    assert.equal(error.context.reason, reason);
    return true;
  });
}

function endOf(parts: readonly AiProviderStreamPart[]) {
  const end = parts.at(-1);
  assert.equal(end?.type, 'response-end');
  if (end?.type !== 'response-end') throw new Error('no end');
  return end.response;
}

describe('readAnthropicStream', () => {
  it('rejects events before message_start and a second message_start', async () => {
    await failsWith(
      [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      'event_order',
    );
    await failsWith([start, start], 'message_start');
    await failsWith([{ type: 'message_start', message: { id: 'm', model: 'x' } }], 'usage');
  });

  it('rejects deltas for the wrong block, unknown deltas, and reused indexes', async () => {
    const text = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    };
    await failsWith(
      [
        start,
        text,
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x' } },
      ],
      'content_block_delta',
    );
    await failsWith(
      [start, text, { type: 'content_block_delta', index: 0, delta: { type: 'future_delta' } }],
      'content_block_delta',
    );
    await failsWith(
      [
        start,
        text,
        { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'x' } },
      ],
      'content_block_delta',
    );
    await failsWith([start, text, text], 'content_block_start');
    await failsWith([start, text, delta('end_turn'), stop], 'block_open');
  });

  it('fails a stream that ends early, unless the call was stopped', async () => {
    await failsWith([start], 'incomplete_stream');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      read([start], controller.signal),
      (error) => error instanceof AiError && error.code === 'aborted',
    );
  });

  it('skips unknown events, keeps unknown blocks in native content only', async () => {
    const parts = await read([
      { type: 'future_event' },
      start,
      { type: 'future_event' },
      { type: 'content_block_start', index: 0, content_block: { type: 'mystery', payload: [1] } },
      { type: 'content_block_stop', index: 0 },
      delta('model_context_window_exceeded'),
      stop,
    ]);
    const response = endOf(parts);
    assert.equal(response.finishReason, 'length');
    assert.deepEqual(response.message.native?.content, [{ type: 'mystery', payload: [1] }]);
    assert.deepEqual(response.message.parts, [{ type: 'text', text: '' }]);
  });

  it('emits tool-input parts and parses the input when the block stops', async () => {
    const parts = await read([
      start,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'f', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"a":' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '[1]}' },
      },
      { type: 'content_block_stop', index: 0 },
      delta('tool_use'),
      stop,
    ]);
    assert.deepEqual(
      parts.map((part) => part.type),
      [
        'response-start',
        'tool-input-start',
        'tool-input-delta',
        'tool-input-delta',
        'response-end',
      ],
    );
    const response = endOf(parts);
    assert.deepEqual(response.message.parts, [
      { type: 'tool-call', id: 'toolu_1', name: 'f', input: { a: [1] } },
    ]);
    assert.equal(response.finishReason, 'tool-calls');
  });

  it('wraps a non-object tool input as INVALID_JSON', async () => {
    const response = endOf(
      await read([
        start,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'f', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '[1,2]' },
        },
        { type: 'content_block_stop', index: 0 },
        delta('tool_use'),
        stop,
      ]),
    );
    assert.deepEqual(response.message.parts[0], {
      type: 'tool-call',
      id: 'toolu_1',
      name: 'f',
      input: { INVALID_JSON: '[1,2]' },
    });
  });

  it('drops model-internal blocks before the last fallback block', async () => {
    const block = (index: number, content: Record<string, unknown>) => [
      { type: 'content_block_start', index, content_block: content },
      { type: 'content_block_stop', index },
    ];
    const response = endOf(
      await read([
        start,
        ...block(0, { type: 'redacted_thinking', data: 'x' }),
        ...block(1, { type: 'server_tool_use', id: 'srv_unpaired', name: 'web_search', input: {} }),
        ...block(2, { type: 'text', text: 'kept', citations: null }),
        ...block(3, { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } }),
        ...block(4, { type: 'fallback', from: { model: 'b' }, to: { model: 'c' } }),
        ...block(5, { type: 'redacted_thinking', data: 'y' }),
        delta('end_turn'),
        stop,
      ]),
    );
    assert.deepEqual(
      (response.message.native?.content as { type: string }[]).map((entry) => entry.type),
      ['text', 'fallback', 'fallback', 'redacted_thinking'],
    );
    assert.equal(response.model, 'c');
  });
});
