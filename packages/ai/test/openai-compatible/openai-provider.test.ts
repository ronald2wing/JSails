/**
 * The OpenAI-compatible provider through the real `openai` SDK, with a fetch
 * serving stored chunk-stream fixtures: text with cached-usage
 * normalization, parallel tool calls in a full run, compatible-server
 * streams with missing, repeated, and reused tool-call ids and
 * `reasoning_content`, refusal, a tool call cut at the length limit, replies
 * cut off before any `finish_reason`, a mid-stream error, HTTP error mapping with SDK retries, construction rules,
 * and backpressure from a paused consumer down to the response body.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import OpenAI from 'openai';
import { z } from 'zod';

import { AiError } from '../../src/errors/ai-error.js';
import type { AiProviderRequest, AiProviderStreamPart } from '../../src/provider/contract.js';
import { generate } from '../../src/run/run.js';
import { defineTool } from '../../src/tools/define-tool.js';
import {
  createOpenAICompatible,
  type OpenAICompatibleSettings,
} from '../../src/openai-compatible/index.js';
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
    text: readFixture('openai-compatible', name),
    ...(chunkSize === undefined ? {} : { chunkSize }),
  };
}

function sdkProvider(
  replies: readonly FixtureReply[],
  settings: Omit<OpenAICompatibleSettings, 'client' | 'apiKey'> = {},
  maxRetries = 0,
) {
  const server = fixtureFetch(replies);
  const client = new OpenAI({
    apiKey: 'test-key',
    baseURL: 'https://llm.example.test/v1',
    fetch: server.fetch,
    maxRetries,
    organization: null,
    project: null,
    logLevel: 'off',
  });
  return { provider: createOpenAICompatible({ ...settings, client }), server };
}

function baseRequest(overrides: Partial<AiProviderRequest> = {}): AiProviderRequest {
  return {
    model: 'gpt-5.2',
    instructions: [],
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: true,
    maxOutputTokens: 256,
    cache: 'auto',
    ...overrides,
  };
}

const init = () => ({ signal: new AbortController().signal, headers: {} });

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

describe('createOpenAICompatible: streaming through the SDK', () => {
  it('streams text and normalizes usage with the cache inside prompt tokens', async () => {
    const { provider, server } = sdkProvider([sse('text.sse', 13)]);
    const parts: AiProviderStreamPart[] = [];
    for await (const part of provider.stream(baseRequest(), init())) parts.push(part);
    assert.deepEqual(
      parts.filter((part) => part.type === 'text-delta').map((part) => part.delta),
      ['Hello', ' there.'],
    );
    const end = parts.at(-1);
    assert.equal(end?.type, 'response-end');
    if (end?.type !== 'response-end') return;
    assert.equal(end.response.id, 'chatcmpl-text1');
    assert.equal(end.response.finishReason, 'stop');
    assert.deepEqual(end.response.usage, {
      inputTokens: 1200,
      outputTokens: 30,
      cacheReadTokens: 1024,
      cacheWriteTokens: 0,
      reasoningTokens: 12,
    });
    assert.equal(end.response.message.native, undefined);
    assert.equal(server.requests[0]?.url, 'https://llm.example.test/v1/chat/completions');
    assert.equal(server.requests[0]?.headers.authorization, 'Bearer test-key');
  });

  it('runs parallel tool calls and sends the results as tool messages', async () => {
    const calls: string[] = [];
    const { provider, server } = sdkProvider([sse('tool-calls-parallel.sse'), sse('text.sse')]);
    const result = await generate({
      model: provider.model('gpt-5.2'),
      input: 'Paris and Tokyo?',
      tools: [weatherTool(calls)],
      context: { actor },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls.sort(), ['Paris', 'Tokyo']);
    const second = server.requests[1]?.body as { messages: Record<string, unknown>[] };
    assert.deepEqual(second.messages.slice(1), [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_paris',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Paris"}' },
          },
          {
            id: 'call_tokyo',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_paris', content: 'Paris: 21C' },
      { role: 'tool', tool_call_id: 'call_tokyo', content: 'Tokyo: 21C' },
    ]);
  });

  it('synthesizes unique ids for a compatible server with missing and reused ids', async () => {
    const { provider } = sdkProvider([sse('compat-tool-calls.sse')], {
      name: 'local',
      supports: { streamUsage: false, reasoning: true },
    });
    const response = await provider.generate(
      baseRequest({
        model: 'qwen3',
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Earlier' }] },
          {
            role: 'assistant',
            parts: [{ type: 'tool-call', id: 'call_0', name: 'weather', input: { city: 'X' } }],
          },
          {
            role: 'user',
            parts: [
              { type: 'tool-result', id: 'call_0', name: 'weather', output: 'ok', isError: false },
            ],
          },
        ],
      }),
      init(),
    );
    assert.equal(provider.id, 'local');
    assert.equal(response.finishReason, 'tool-calls');
    assert.ok(response.id.startsWith('chatcmpl-'));
    assert.deepEqual(response.usage, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.deepEqual(response.message.parts[0], { type: 'reasoning', text: 'Need the weather.' });
    const toolCalls = response.message.parts.filter((part) => part.type === 'tool-call');
    assert.deepEqual(
      toolCalls.map((part) => part.input),
      [{ city: 'Oslo' }, { city: 'Bergen' }, { city: 'Rome' }],
    );
    const ids = toolCalls.map((part) => part.id);
    assert.equal(new Set([...ids, 'call_0']).size, 4);
    assert.ok(!ids.includes('call_0'));
    assert.ok(ids.includes('call_1'));
    assert.ok(ids.every((id) => id.length <= 40 && /^[A-Za-z0-9_-]+$/.test(id)));
    assert.deepEqual(response.iterations, [
      { provider: 'local', model: 'qwen3', usage: response.usage },
    ]);
  });

  it('reports a refusal and fails the run with refused', async () => {
    const { provider } = sdkProvider([sse('refusal.sse')]);
    const response = await provider.generate(baseRequest(), init());
    assert.equal(response.finishReason, 'refusal');
    assert.deepEqual(response.refusal, { category: null });
    const result = await generate({ model: provider.model('gpt-5.2'), input: 'x' });
    assert.equal(result.error?.code, 'refused');
  });

  it('fails a tool call cut at the length limit without running it', async () => {
    const calls: string[] = [];
    const { provider } = sdkProvider([sse('length-tool-call.sse')]);
    const result = await generate({
      model: provider.model('gpt-5.2'),
      input: 'Weather?',
      tools: [weatherTool(calls)],
      context: { actor },
    });
    assert.equal(result.error?.code, 'output_truncated');
    assert.deepEqual(calls, []);
  });

  it('fails a reply cut off mid-text before any finish_reason', async () => {
    const { provider } = sdkProvider([sse('truncated-text.sse')]);
    const error = await rejectsWith(provider.generate(baseRequest(), init()), 'provider_failed');
    assert.equal(error.context.reason, 'incomplete_stream');
    const result = await generate({
      model: sdkProvider([sse('truncated-text.sse')]).provider.model('gpt-5.2'),
      input: 'x',
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'provider_failed');
    assert.equal(result.text, '');
  });

  it('fails a reply cut off mid tool call without running the tool', async () => {
    const calls: string[] = [];
    const { provider } = sdkProvider([sse('truncated-tool-call.sse')]);
    const result = await generate({
      model: provider.model('gpt-5.2'),
      input: 'Weather?',
      tools: [weatherTool(calls)],
      context: { actor },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'provider_failed');
    assert.equal(result.error?.context.reason, 'incomplete_stream');
    assert.deepEqual(calls, []);
  });

  it('requires the usage chunk when streamUsage is on', async () => {
    const { provider } = sdkProvider([sse('compat-tool-calls.sse')]);
    const error = await rejectsWith(provider.generate(baseRequest(), init()), 'provider_failed');
    assert.equal(error.context.reason, 'usage');
  });
});

describe('createOpenAICompatible: errors', () => {
  it('maps an error chunk mid-stream to provider_unavailable without retrying', async () => {
    const { provider, server } = sdkProvider([sse('server-error-mid-stream.sse')], {}, 2);
    await rejectsWith(provider.generate(baseRequest(), init()), 'provider_unavailable');
    assert.equal(server.requests.length, 1);
  });

  it('lets the SDK retry a 429 and then reports rate_limited with retryAfterMs', async () => {
    const { provider, server } = sdkProvider(
      [
        {
          kind: 'json',
          status: 429,
          body: { error: { message: 'slow', type: 'requests', code: 'rate_limit_exceeded' } },
          headers: { 'retry-after-ms': '7' },
        },
      ],
      {},
      1,
    );
    const error = await rejectsWith(provider.generate(baseRequest(), init()), 'rate_limited');
    assert.equal(error.retryAfterMs, 7);
    assert.equal(server.requests.length, 2);
  });

  it('maps HTTP statuses to value-free codes, context length included', async () => {
    const cases: [number, unknown, string][] = [
      [
        401,
        {
          error: {
            message: 'Incorrect API key sk-proj-canary',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        'provider_auth',
      ],
      [
        400,
        {
          error: {
            message: 'too long',
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
          },
        },
        'context_length_exceeded',
      ],
      [
        400,
        {
          error: {
            message: "This model's maximum context length is 8192 tokens",
            type: 'invalid_request_error',
          },
        },
        'context_length_exceeded',
      ],
      [
        400,
        { error: { message: 'messages[0] canary bad', type: 'invalid_request_error' } },
        'provider_rejected',
      ],
      [404, { error: { message: 'model canary not found' } }, 'provider_rejected'],
      [503, { error: { message: 'busy' } }, 'provider_unavailable'],
    ];
    for (const [status, body, code] of cases) {
      const { provider } = sdkProvider([{ kind: 'json', status, body }]);
      const error = await rejectsWith(provider.generate(baseRequest(), init()), code);
      assert.equal(error.context.status, status);
      assert.equal(
        JSON.stringify({ m: error.message, c: error.context }).includes('canary'),
        false,
      );
    }
  });

  it('maps a network failure to provider_unavailable and an abort to aborted', async () => {
    await rejectsWith(
      sdkProvider([{ kind: 'network-error' }]).provider.generate(baseRequest(), init()),
      'provider_unavailable',
    );
    const controller = new AbortController();
    controller.abort();
    await rejectsWith(
      sdkProvider([sse('text.sse')]).provider.generate(baseRequest(), {
        signal: controller.signal,
        headers: {},
      }),
      'aborted',
    );
  });
});

describe('createOpenAICompatible: construction', () => {
  it('refuses to construct without explicit credentials, and refuses mixed settings', () => {
    const invalid = (settings: unknown, field: string): void => {
      assert.throws(
        () => createOpenAICompatible(settings as OpenAICompatibleSettings),
        (error) =>
          error instanceof AiError &&
          error.code === 'invalid_options' &&
          error.context.field === field,
      );
    };
    invalid({}, 'apiKey');
    invalid({ apiKey: 'k', baseURL: 'ftp://x.test' }, 'baseURL');
    invalid({ apiKey: 'k', baseURL: 'http://10.0.0.5/v1' }, 'baseURL');
    invalid({ client: { chat: {} } }, 'client');
    invalid({ client: new OpenAI({ apiKey: 'x' }), apiKey: 'k' }, 'apiKey');
    invalid({ client: new OpenAI({ apiKey: 'x' }), timeoutMs: 5 }, 'timeoutMs');
  });

  it('builds its own SDK client from an apiKey and a loopback base URL', async () => {
    const server = fixtureFetch([sse('text.sse')]);
    const provider = createOpenAICompatible({
      apiKey: 'own-key',
      baseURL: 'http://127.0.0.1:11434/v1',
      fetch: server.fetch,
      maxRetries: 0,
    });
    assert.equal(provider.id, 'openai-compatible');
    assert.equal(provider.capabilities.countTokens, false);
    const response = await provider.generate(baseRequest(), init());
    assert.equal(response.id, 'chatcmpl-text1');
    assert.equal(server.requests[0]?.url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(server.requests[0]?.headers.authorization, 'Bearer own-key');
    assert.throws(
      () => provider.model(''),
      (error) => error instanceof AiError && error.code === 'invalid_options',
    );
  });
});

describe('createOpenAICompatible: backpressure', () => {
  it('stops pulling the response body while the consumer is paused', async () => {
    const stream = countingStream(
      (index) =>
        `data: {"id":"chatcmpl-bp","object":"chat.completion.chunk","created":1,"model":"gpt-5.2","choices":[{"index":0,"delta":{"content":"t${index}"},"finish_reason":null}]}\n\n`,
    );
    const { provider } = sdkProvider([{ kind: 'stream', body: stream.body }]);
    const controller = new AbortController();
    const iterator = provider
      .stream(baseRequest(), { signal: controller.signal, headers: {} })
      [Symbol.asyncIterator]();
    for (let index = 0; index < 5; index += 1) await iterator.next();
    const before = stream.pulls();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(stream.pulls() - before <= 2, `pulled ${stream.pulls() - before} while paused`);
    assert.ok(stream.pulls() < 20);
    controller.abort();
    await iterator.return?.();
  });
});

describe('openai-compatible fixtures', () => {
  it('hold no credentials', () => {
    for (const name of readdirSync(fixtureDir('openai-compatible'))) {
      const text = readFileSync(`${fixtureDir('openai-compatible')}${name}`, 'utf8');
      assert.doesNotMatch(text, /sk-[A-Za-z0-9-]{8,}|authorization|bearer/i, name);
    }
  });
});
