/**
 * The Anthropic provider through the real `@anthropic-ai/sdk`, with a fetch
 * that serves stored server-sent event fixtures: text and parallel tool use,
 * a full tool loop whose second request replays the first response byte for
 * byte (thinking signatures, citations, fallback and server-tool blocks
 * included), refusal, a tool call cut at the token limit, pause_turn, an
 * invalid eager tool input, an overloaded error mid-stream (no retry), HTTP
 * error mapping with SDK retries, token counting, construction rules, and
 * backpressure from a paused consumer down to the response body.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { AiError } from '../../src/errors/ai-error.js';
import type { AiMessage } from '../../src/content/types.js';
import type { AiProviderRequest, AiProviderStreamPart } from '../../src/provider/contract.js';
import { countTokens } from '../../src/run/count-tokens.js';
import { generate, run } from '../../src/run/run.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { createPricingTable } from '../../src/usage/pricing.js';
import { createAnthropic, type AnthropicMessagesClient } from '../../src/anthropic/index.js';
import {
  countingStream,
  fixtureDir,
  fixtureFetch,
  readFixture,
  type FixtureReply,
} from '../provider/fixture-fetch.js';

const actor = { kind: 'user', id: 'u1' } as const;

function sse(name: string, chunkSize?: number): FixtureReply {
  return {
    kind: 'sse',
    text: readFixture('anthropic', name),
    ...(chunkSize === undefined ? {} : { chunkSize }),
  };
}

function sdkProvider(replies: readonly FixtureReply[], maxRetries = 0) {
  const server = fixtureFetch(replies);
  const client = new Anthropic({
    apiKey: 'test-key',
    baseURL: 'https://api.anthropic.test',
    fetch: server.fetch,
    maxRetries,
    logLevel: 'off',
    openTelemetry: false,
  });
  return { provider: createAnthropic({ client }), server };
}

function weatherTool(calls: string[] = []) {
  return defineTool({
    name: 'weather',
    description: 'Current weather for a city.',
    input: z.object({ city: z.string() }),
    execute: ({ city }) => {
      calls.push(city);
      return `${city}: 21C`;
    },
  });
}

function baseRequest(overrides: Partial<AiProviderRequest> = {}): AiProviderRequest {
  return {
    model: 'claude-opus-5-5',
    instructions: [],
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: true,
    maxOutputTokens: 512,
    cache: 'off',
    ...overrides,
  };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<AiError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AiError, 'expected an AiError');
  assert.equal(caught.code, code);
  return caught;
}

describe('createAnthropic: streaming through the SDK', () => {
  it('streams a multi-block text reply with usage and native content', async () => {
    const { provider, server } = sdkProvider([sse('text.sse', 17)]);
    const parts: AiProviderStreamPart[] = [];
    for await (const part of provider.stream(baseRequest(), {
      signal: new AbortController().signal,
      headers: { traceparent: '00-abc-def-01' },
    })) {
      parts.push(part);
    }
    assert.deepEqual(
      parts.filter((part) => part.type === 'text-delta').map((part) => part.delta),
      ['Hello', ' there.', ' Second block.'],
    );
    const end = parts.at(-1);
    assert.equal(end?.type, 'response-end');
    if (end?.type !== 'response-end') return;
    assert.equal(end.response.finishReason, 'stop');
    assert.deepEqual(end.response.usage, {
      inputTokens: 21,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.deepEqual(end.response.message.native?.content, [
      { type: 'text', text: 'Hello there.', citations: null },
      { type: 'text', text: ' Second block.', citations: null },
    ]);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.url, 'https://api.anthropic.test/v1/messages');
    assert.equal(server.requests[0]?.headers.traceparent, '00-abc-def-01');
    assert.equal(server.requests[0]?.headers.authorization, 'Bearer test-key');
    assert.equal(server.requests[0]?.headers['anthropic-version'], '2026-10-21');
  });

  it('normalizes cache usage: input includes cache reads and writes', async () => {
    const { provider } = sdkProvider([sse('tool-use-parallel.sse')]);
    const response = await provider.generate(baseRequest(), {
      signal: new AbortController().signal,
      headers: {},
    });
    assert.deepEqual(response.usage, {
      inputTokens: 120 + 2048 + 4096,
      outputTokens: 88,
      cacheReadTokens: 4096,
      cacheWriteTokens: 2048,
      reasoningTokens: 40,
    });
    assert.deepEqual(response.iterations, [
      { provider: 'anthropic', model: 'claude-opus-5-5', usage: response.usage },
    ]);
  });
});

describe('createAnthropic: the tool loop', () => {
  it('runs parallel tools and replays the first response byte for byte', async () => {
    const calls: string[] = [];
    const { provider, server } = sdkProvider([sse('tool-use-parallel.sse'), sse('text.sse')]);
    const result = await generate({
      model: provider.model('claude-opus-5-5'),
      input: 'Weather in Paris and Tokyo?',
      tools: [weatherTool(calls)],
      context: { actor },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls.sort(), ['Paris', 'Tokyo']);
    const first = server.requests[0]?.body as { tools: unknown[] };
    assert.equal(
      (first.tools[0] as { eager_input_streaming?: boolean }).eager_input_streaming,
      true,
    );
    const second = server.requests[1]?.body as { messages: { role: string; content: unknown }[] };
    const assistant = result.messages[1];
    assert.ok(assistant?.native !== undefined);
    assert.equal(
      JSON.stringify(second.messages[1]?.content),
      JSON.stringify(assistant.native.content),
    );
    assert.ok(server.requests[1]?.bodyText.includes('"signature":"EqQBCkYIBRgCKkDsig=="'));
    assert.deepEqual(second.messages[2], {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01Paris', content: 'Paris: 21C' },
        { type: 'tool_result', tool_use_id: 'toolu_01Tokyo', content: 'Tokyo: 21C' },
      ],
    });
  });

  it('stores a fallback turn in its echo form and replays it unchanged after a JSON round trip', async () => {
    const { provider, server } = sdkProvider([sse('fallback-citations.sse'), sse('text.sse')]);
    const pricing = createPricingTable({
      'claude-fable-5-2': { inputPerMTok: 8, outputPerMTok: 40 },
      'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
    });
    const first = await generate({
      model: provider.model('claude-fable-5-2'),
      input: 'Tides?',
      pricing,
    });
    assert.equal(first.status, 'completed');
    const turn = first.messages[1];
    const content = turn?.native?.content as { type: string; id?: string }[];
    assert.deepEqual(
      content.map((block) => block.type),
      ['server_tool_use', 'web_search_tool_result', 'text', 'fallback', 'thinking', 'text'],
    );
    assert.equal(turn?.meta?.model, 'claude-opus-4-8');
    assert.ok(!turn?.parts.some((part) => part.type === 'tool-call'));
    assert.deepEqual((content[2] as { citations?: unknown[] }).citations?.length, 1);
    // Per-iteration pricing: 300 in / 40 out at Fable, 310 in / 35 out at Opus 4.8.
    assert.equal(first.costMicroUsd, 300 * 8 + 40 * 40 + 310 * 5 + 35 * 25);

    const stored = JSON.parse(JSON.stringify(first.messages)) as AiMessage[];
    await generate({ model: provider.model('claude-fable-5-2'), history: stored, input: 'More?' });
    const replay = server.requests[1]?.body as { messages: { content: unknown }[] };
    assert.equal(
      JSON.stringify(replay.messages[1]?.content),
      JSON.stringify(turn?.native?.content),
    );
  });

  it('turns an unparseable eager input into an error result; the tool never runs', async () => {
    const calls: string[] = [];
    const { provider, server } = sdkProvider([sse('invalid-json-input.sse'), sse('text.sse')]);
    const result = await generate({
      model: provider.model('claude-opus-5-5'),
      input: 'Weather?',
      tools: [weatherTool(calls)],
      context: { actor },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls, []);
    const second = server.requests[1]?.body as {
      messages: { content: Record<string, unknown>[] }[];
    };
    assert.deepEqual(second.messages[1]?.content[0]?.input, { INVALID_JSON: '{"city": Paris}' });
    assert.equal(second.messages[2]?.content[0]?.is_error, true);
  });

  it('fails a tool call cut at the token limit without running it', async () => {
    const calls: string[] = [];
    const { provider } = sdkProvider([sse('max-tokens-tool.sse')]);
    const result = await generate({
      model: provider.model('claude-opus-5-5'),
      input: 'Weather?',
      tools: [weatherTool(calls)],
      context: { actor },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'output_truncated');
    assert.deepEqual(calls, []);
  });

  it('fails a refusal with its category and appends nothing', async () => {
    const { provider } = sdkProvider([sse('refusal.sse')]);
    const response = await provider.generate(baseRequest(), {
      signal: new AbortController().signal,
      headers: {},
    });
    assert.equal(response.finishReason, 'refusal');
    assert.deepEqual(response.refusal, { category: 'cyber' });
    const result = await generate({ model: provider.model('claude-opus-5-5'), input: 'x' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'refused');
    assert.equal(result.appended.length, 1);
  });

  it('continues a paused turn with the paused content last', async () => {
    const { provider, server } = sdkProvider([sse('pause-turn.sse'), sse('text.sse')]);
    const result = await generate({ model: provider.model('claude-opus-5-5'), input: 'News?' });
    assert.equal(result.status, 'completed');
    assert.equal(server.requests.length, 2);
    const second = server.requests[1]?.body as { messages: { role: string; content: unknown }[] };
    assert.equal(second.messages.at(-1)?.role, 'assistant');
    assert.deepEqual(second.messages.at(-1)?.content, [
      {
        type: 'server_tool_use',
        id: 'srvtoolu_01P',
        name: 'web_search',
        input: { query: 'news' },
        caller: { type: 'direct' },
      },
    ]);
  });
});

describe('createAnthropic: errors', () => {
  it('maps an overloaded event mid-stream to provider_unavailable without retrying', async () => {
    const { provider, server } = sdkProvider([sse('overloaded-mid-stream.sse')], 2);
    const handle = run({ model: provider.model('claude-opus-5-5'), input: 'x' });
    const deltas: string[] = [];
    for await (const event of handle) if (event.type === 'text-delta') deltas.push(event.delta);
    const result = await handle.result;
    assert.deepEqual(deltas, ['Partial']);
    assert.equal(result.error?.code, 'provider_unavailable');
    assert.equal(server.requests.length, 1);
  });

  it('lets the SDK retry a 429 and then reports rate_limited with retryAfterMs', async () => {
    const { provider, server } = sdkProvider(
      [
        {
          kind: 'json',
          status: 429,
          body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
          headers: { 'retry-after-ms': '5' },
        },
      ],
      1,
    );
    const error = await rejectsWith(
      provider.generate(baseRequest(), { signal: new AbortController().signal, headers: {} }),
      'rate_limited',
    );
    assert.equal(error.retryAfterMs, 5);
    assert.equal(server.requests.length, 2);
    assert.equal(error.message.includes('slow down'), false);
  });

  it('maps HTTP statuses to value-free codes', async () => {
    const cases: [number, string, string, string][] = [
      [401, 'authentication_error', 'invalid x-api-key sk-ant-secret', 'provider_auth'],
      [403, 'permission_error', 'no', 'provider_auth'],
      [
        400,
        'invalid_request_error',
        'prompt is too long: 250000 tokens > 200000 maximum',
        'context_length_exceeded',
      ],
      [400, 'invalid_request_error', 'messages.0: canary-123 is bad', 'provider_rejected'],
      [404, 'not_found_error', 'model: canary', 'provider_rejected'],
      [529, 'overloaded_error', 'Overloaded', 'provider_unavailable'],
    ];
    for (const [status, type, message, code] of cases) {
      const { provider } = sdkProvider([
        { kind: 'json', status, body: { type: 'error', error: { type, message } } },
      ]);
      const error = await rejectsWith(
        provider.generate(baseRequest(), { signal: new AbortController().signal, headers: {} }),
        code,
      );
      assert.equal(error.context.status, status);
      assert.equal(
        JSON.stringify({ message: error.message, context: error.context }).includes(message),
        false,
      );
    }
  });

  it('maps a network failure to provider_unavailable and an abort to aborted', async () => {
    const { provider } = sdkProvider([{ kind: 'network-error' }]);
    await rejectsWith(
      provider.generate(baseRequest(), { signal: new AbortController().signal, headers: {} }),
      'provider_unavailable',
    );
    const controller = new AbortController();
    controller.abort();
    const aborted = sdkProvider([sse('text.sse')]).provider;
    await rejectsWith(
      aborted.generate(baseRequest(), { signal: controller.signal, headers: {} }),
      'aborted',
    );
  });
});

describe('createAnthropic: token counting and construction', () => {
  it('counts tokens through messages.countTokens', async () => {
    const { provider, server } = sdkProvider([
      { kind: 'json', status: 200, body: { input_tokens: 42 } },
    ]);
    const count = await countTokens({
      model: provider.model('claude-opus-5-5'),
      input: 'How many?',
    });
    assert.equal(count, 42);
    assert.equal(server.requests[0]?.url, 'https://api.anthropic.test/v1/messages/count_tokens');
    assert.equal((server.requests[0]?.body as Record<string, unknown>).max_tokens, undefined);
  });

  it('reports no token counting for a client without countTokens', async () => {
    const client: AnthropicMessagesClient = {
      messages: { create: () => Promise.resolve((async function* () {})()) },
    };
    const provider = createAnthropic({ client });
    assert.equal(provider.capabilities.countTokens, false);
    await rejectsWith(
      countTokens({ model: provider.model('m'), input: 'x' }),
      'unsupported_capability',
    );
  });

  it('refuses to construct without explicit credentials, and refuses mixed settings', () => {
    const invalid = (settings: unknown, field: string): void => {
      assert.throws(
        () => createAnthropic(settings as Parameters<typeof createAnthropic>[0]),
        (error) =>
          error instanceof AiError &&
          error.code === 'invalid_options' &&
          error.context.field === field,
      );
    };
    invalid({}, 'apiKey');
    invalid({ apiKey: '  ' }, 'apiKey');
    invalid({ apiKey: 'k', baseURL: 'http://api.example.com' }, 'baseURL');
    invalid({ apiKey: 'k', baseURL: 'https://user:pw@api.example.com' }, 'baseURL');
    invalid({ apiKey: 'k', maxRetries: -1 }, 'maxRetries');
    invalid({ apiKey: 'k', cacheTtl: '2h' }, 'cacheTtl');
    invalid({ apiKey: 'k', eagerInputStreaming: 'on' }, 'eagerInputStreaming');
    invalid({ client: {} }, 'client');
    invalid({ client: new Anthropic({ apiKey: 'x' }), apiKey: 'k' }, 'apiKey');
    invalid({ client: new Anthropic({ apiKey: 'x' }), baseURL: 'https://a.test' }, 'baseURL');
  });

  it('builds its own SDK client from an apiKey with an explicit base URL', async () => {
    const server = fixtureFetch([sse('text.sse')]);
    const provider = createAnthropic({
      apiKey: 'own-key',
      baseURL: 'http://localhost:9999',
      fetch: server.fetch,
      maxRetries: 0,
    });
    const response = await provider.generate(baseRequest(), {
      signal: new AbortController().signal,
      headers: {},
    });
    assert.equal(response.id, 'msg_01TextReply');
    assert.equal(server.requests[0]?.url, 'http://localhost:9999/v1/messages');
    assert.equal(server.requests[0]?.headers.authorization, 'Bearer own-key');
  });
});

describe('createAnthropic: backpressure', () => {
  it('stops pulling the response body while the consumer is paused', async () => {
    const head =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_bp","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"","citations":null}}\n\n';
    const stream = countingStream((index) =>
      index === 0
        ? head
        : `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"t${index}"}}\n\n`,
    );
    const { provider } = sdkProvider([{ kind: 'stream', body: stream.body }]);
    const controller = new AbortController();
    const iterator = provider
      .stream(baseRequest(), { signal: controller.signal, headers: {} })
      [Symbol.asyncIterator]();
    for (let index = 0; index < 5; index += 1) await iterator.next();
    const pulledWhileReading = stream.pulls();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      stream.pulls() - pulledWhileReading <= 2,
      `pulled ${stream.pulls() - pulledWhileReading} while paused`,
    );
    assert.ok(stream.pulls() < 20);
    controller.abort();
    await iterator.return?.();
  });
});

describe('anthropic fixtures', () => {
  it('hold no credentials', () => {
    for (const name of readdirSync(fixtureDir('anthropic'))) {
      const text = readFileSync(`${fixtureDir('anthropic')}${name}`, 'utf8');
      assert.doesNotMatch(text, /sk-ant-|sk-[A-Za-z0-9]{16,}|x-api-key|authorization/i, name);
    }
  });
});
