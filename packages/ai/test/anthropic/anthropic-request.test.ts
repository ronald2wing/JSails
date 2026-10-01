/**
 * Anthropic request building: golden bodies, the parameters never sent,
 * tool choice, the system channels, verbatim native replay versus rebuilding
 * another provider's turn, prompt-cache breakpoints (at most four), document
 * mapping, byte-stable serialization, provider-option validation, and a
 * compile-time check that every built shape is accepted by the installed
 * `@anthropic-ai/sdk` parameter types.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';

import { AiError } from '../../src/errors/ai-error.js';
import type { AiMessage } from '../../src/content/types.js';
import type { AiProviderRequest } from '../../src/provider/contract.js';
import {
  MAX_CACHE_BREAKPOINTS,
  buildAnthropicCountRequest,
  buildAnthropicRequest,
  type AnthropicRequestConfig,
} from '../../src/anthropic/anthropic-request.js';

const config: AnthropicRequestConfig = { cacheTtl: undefined, eagerInputStreaming: true };

const weatherSpec = {
  name: 'weather',
  description: 'Current weather for a city.',
  inputSchema: {
    type: 'object',
    required: ['city'],
    additionalProperties: false,
    properties: { city: { type: 'string' }, units: { type: 'string', enum: ['c', 'f'] } },
  },
  strict: true,
} as const;

function request(overrides: Partial<AiProviderRequest> = {}): AiProviderRequest {
  return {
    model: 'claude-opus-5-5',
    instructions: [{ text: 'Be brief.' }],
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Weather in Paris?' }] }],
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: true,
    maxOutputTokens: 1024,
    cache: 'off',
    ...overrides,
  };
}

function cacheMarks(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + cacheMarks(item), 0);
  if (typeof value !== 'object' || value === null) return 0;
  return Object.entries(value).reduce(
    (sum, [key, field]) => sum + (key === 'cache_control' ? 1 : cacheMarks(field)),
    0,
  );
}

describe('buildAnthropicRequest: golden bodies', () => {
  it('builds a tool request with system array, strict eager tools, and options', () => {
    const built = buildAnthropicRequest(
      request({
        tools: [weatherSpec],
        parallelToolCalls: false,
        effort: 'high',
        reasoning: 'summarized',
        stopSequences: ['END'],
        providerOptions: { anthropic: { inferenceGeo: 'us', speed: 'fast', userId: 'u-hash' } },
      }),
      config,
    );
    assert.deepEqual(built.headers, {});
    assert.equal(
      JSON.stringify(built.body),
      JSON.stringify({
        model: 'claude-opus-5-5',
        system: [{ type: 'text', text: 'Be brief.' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] }],
        tools: [
          {
            name: 'weather',
            description: 'Current weather for a city.',
            input_schema: {
              additionalProperties: false,
              properties: {
                city: { type: 'string' },
                units: { enum: ['c', 'f'], type: 'string' },
              },
              required: ['city'],
              type: 'object',
            },
            strict: true,
            eager_input_streaming: true,
          },
        ],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'high' },
        speed: 'fast',
        max_tokens: 1024,
        stop_sequences: ['END'],
        inference_geo: 'us',
        metadata: { user_id: 'u-hash' },
        stream: true,
      }),
    );
  });

  it('never sends sampling parameters or a forced tool choice', () => {
    for (const toolChoice of ['auto', 'none'] as const) {
      const text = JSON.stringify(
        buildAnthropicRequest(request({ tools: [weatherSpec], toolChoice }), config).body,
      );
      for (const field of ['temperature', 'top_p', 'top_k', '"any"', '"type":"tool"']) {
        assert.equal(text.includes(field), false, field);
      }
    }
  });

  it('sends tool_choice none only with tools, and omits it for parallel auto', () => {
    assert.deepEqual(
      buildAnthropicRequest(request({ tools: [weatherSpec], toolChoice: 'none' }), config).body
        .tool_choice,
      { type: 'none' },
    );
    assert.equal(
      buildAnthropicRequest(request({ tools: [weatherSpec] }), config).body.tool_choice,
      undefined,
    );
    assert.equal(
      buildAnthropicRequest(request({ toolChoice: 'none', parallelToolCalls: false }), config).body
        .tool_choice,
      undefined,
    );
  });

  it('maps a structured output to output_config.format with canonical keywords', () => {
    const body = buildAnthropicRequest(
      request({
        output: {
          name: 'answer',
          schema: { type: 'object', properties: { b: {}, a: {} }, required: [] },
        },
      }),
      config,
    ).body;
    assert.equal(
      JSON.stringify(body.output_config),
      '{"format":{"type":"json_schema","schema":{"properties":{"b":{},"a":{}},"required":[],"type":"object"}}}',
    );
  });

  it('turns eager input streaming off when configured, and strict off for loose tools', () => {
    const tool = buildAnthropicRequest(request({ tools: [{ ...weatherSpec, strict: false }] }), {
      cacheTtl: undefined,
      eagerInputStreaming: false,
    }).body.tools?.[0];
    assert.equal(tool?.strict, undefined);
    assert.equal(tool?.eager_input_streaming, undefined);
  });

  it('refuses a tool whose schema is not an object', () => {
    assert.throws(
      () =>
        buildAnthropicRequest(
          request({ tools: [{ ...weatherSpec, inputSchema: { type: 'string' } }] }),
          config,
        ),
      (error) => error instanceof AiError && error.code === 'invalid_tool',
    );
  });

  it('serializes the same request to byte-identical bodies', () => {
    const make = (): string =>
      JSON.stringify(
        buildAnthropicRequest(request({ tools: [weatherSpec], cache: 'auto' }), config).body,
      );
    assert.equal(make(), make());
    const reordered = {
      ...weatherSpec,
      inputSchema: {
        properties: weatherSpec.inputSchema.properties,
        additionalProperties: false,
        type: 'object',
        required: ['city'],
      },
    };
    assert.equal(
      JSON.stringify(
        buildAnthropicRequest(request({ tools: [reordered], cache: 'auto' }), config).body,
      ),
      make(),
    );
  });
});

describe('buildAnthropicRequest: transcripts', () => {
  const anthropicTurn: AiMessage = {
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: '' },
      { type: 'tool-call', id: 'toolu_01A', name: 'weather', input: { city: 'Paris' } },
    ],
    native: {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      content: [
        { type: 'thinking', thinking: '', signature: 'SIG' },
        {
          type: 'tool_use',
          id: 'toolu_01A',
          name: 'weather',
          input: { city: 'Paris' },
          caller: { type: 'direct' },
        },
      ],
    },
  };

  it('replays Anthropic native content verbatim, whatever model wrote it', () => {
    const native = anthropicTurn.native;
    assert.ok(native !== undefined);
    const body = buildAnthropicRequest(
      request({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Weather?' }] },
          anthropicTurn,
          {
            role: 'user',
            parts: [
              {
                type: 'tool-result',
                id: 'toolu_01A',
                name: 'weather',
                output: 'sunny',
                isError: false,
              },
            ],
          },
        ],
      }),
      config,
    ).body;
    assert.equal(JSON.stringify(body.messages[1]?.content), JSON.stringify(native.content));
    assert.deepEqual(body.messages[2], {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01A', content: 'sunny' }],
    });
  });

  it('rebuilds another provider turn from neutral parts, without reasoning, with fitted ids', () => {
    const foreignId = 'call:with/odd*chars';
    const body = buildAnthropicRequest(
      request({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Weather?' }] },
          {
            role: 'assistant',
            parts: [
              { type: 'reasoning', text: 'thoughts' },
              { type: 'text', text: 'Checking.' },
              { type: 'tool-call', id: foreignId, name: 'weather', input: { city: 'Rome' } },
            ],
            native: { provider: 'openai-compatible', model: 'gpt', content: [{ opaque: true }] },
          },
          {
            role: 'user',
            parts: [
              {
                type: 'tool-result',
                id: foreignId,
                name: 'weather',
                output: [{ type: 'text', text: 'rain' }],
                isError: true,
              },
            ],
          },
        ],
      }),
      config,
    ).body;
    const assistant = body.messages[1];
    assert.equal(assistant?.role, 'assistant');
    const blocks = assistant?.content as { type: string; id?: string }[];
    assert.deepEqual(
      blocks.map((block) => block.type),
      ['text', 'tool_use'],
    );
    const id = blocks[1]?.id ?? '';
    assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.notEqual(id, foreignId);
    assert.deepEqual(body.messages[2]?.content, [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: [{ type: 'text', text: 'rain' }],
        is_error: true,
      },
    ]);
  });

  it('leaves out an assistant turn with nothing replayable', () => {
    const body = buildAnthropicRequest(
      request({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'a' }] },
          { role: 'assistant', parts: [{ type: 'reasoning', text: 'x' }] },
          {
            role: 'assistant',
            parts: [{ type: 'text', text: '' }],
            native: { provider: 'anthropic', model: 'm', content: [] },
          },
          { role: 'user', parts: [{ type: 'text', text: 'b' }] },
        ],
      }),
      config,
    ).body;
    assert.deepEqual(
      body.messages.map((message) => message.role),
      ['user', 'user'],
    );
  });

  it('keeps a mid-conversation system message as the operator channel', () => {
    const body = buildAnthropicRequest(
      request({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
          { role: 'system', parts: [{ type: 'text', text: 'Terse mode.' }] },
        ],
      }),
      config,
    ).body;
    assert.deepEqual(body.messages[1], {
      role: 'system',
      content: [{ type: 'text', text: 'Terse mode.' }],
    });
  });

  it('maps images and documents; a plain-text file is decoded, by URL it is unsupported', () => {
    const body = buildAnthropicRequest(
      request({
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'image', source: { kind: 'url', url: 'https://example.org/a.png' } },
              {
                type: 'file',
                mediaType: 'application/pdf',
                source: { kind: 'base64', mediaType: 'application/pdf', data: 'JVBERi0=' },
                title: 'Spec',
              },
              {
                type: 'file',
                mediaType: 'text/plain',
                source: { kind: 'base64', mediaType: 'text/plain', data: 'aMOpbGxv' },
              },
            ],
          },
        ],
      }),
      config,
    ).body;
    assert.deepEqual(body.messages[0]?.content, [
      { type: 'image', source: { type: 'url', url: 'https://example.org/a.png' } },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
        title: 'Spec',
      },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'héllo' } },
    ]);
    assert.throws(
      () =>
        buildAnthropicRequest(
          request({
            messages: [
              {
                role: 'user',
                parts: [
                  {
                    type: 'file',
                    mediaType: 'text/plain',
                    source: { kind: 'url', url: 'https://example.org/a.txt' },
                  },
                ],
              },
            ],
          }),
          config,
        ),
      (error) => error instanceof AiError && error.code === 'unsupported_capability',
    );
  });
});

describe('buildAnthropicRequest: prompt caching', () => {
  const marked = request({
    instructions: [
      { text: 'Long policy.', cache: true },
      { text: 'Glossary.', cache: true },
    ],
    messages: [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'doc', cache: true },
          { type: 'text', text: 'q1', cache: true },
        ],
      },
      { role: 'assistant', parts: [{ type: 'text', text: 'a1' }] },
      { role: 'user', parts: [{ type: 'text', text: 'q2', cache: true }] },
    ],
  });

  it('caps breakpoints at four: the automatic one plus the earliest marks', () => {
    const body = buildAnthropicRequest({ ...marked, cache: 'auto' }, config).body;
    assert.equal(cacheMarks(body), MAX_CACHE_BREAKPOINTS);
    assert.deepEqual(body.cache_control, { type: 'ephemeral' });
    assert.ok(body.system?.every((block) => block.cache_control !== undefined));
    const first = body.messages[0]?.content as { cache_control?: unknown }[];
    assert.ok(first[0]?.cache_control !== undefined);
    assert.equal(first[1]?.cache_control, undefined);
  });

  it('sends no breakpoint with cache off, and applies the configured TTL', () => {
    assert.equal(cacheMarks(buildAnthropicRequest(marked, config).body), 0);
    const body = buildAnthropicRequest(
      { ...marked, cache: 'auto' },
      { cacheTtl: '1h', eagerInputStreaming: true },
    ).body;
    assert.deepEqual(body.cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.deepEqual(body.system?.[0]?.cache_control, { type: 'ephemeral', ttl: '1h' });
  });
});

describe('buildAnthropicRequest: provider options', () => {
  it('adds the fallback beta and the fallbacks field only when asked', () => {
    const built = buildAnthropicRequest(
      request({
        providerOptions: {
          anthropic: { fallbacks: [{ model: 'claude-opus-4-8' }], betas: ['x-beta'] },
        },
      }),
      config,
    );
    assert.deepEqual(built.body.fallbacks, [{ model: 'claude-opus-4-8' }]);
    assert.deepEqual(built.headers, { 'anthropic-beta': 'x-beta,server-side-fallback-2026-07-01' });
    const plain = buildAnthropicRequest(
      request({ providerOptions: { anthropic: { fallbacks: 'default' } } }),
      config,
    );
    assert.equal(plain.body.fallbacks, 'default');
  });

  it('refuses unknown keys and bad values, naming only the field', () => {
    const cases: [unknown, string][] = [
      [{ temperature: 0.2 }, 'temperature'],
      [{ speed: 'slow' }, 'speed'],
      [{ inferenceGeo: 'us east' }, 'inferenceGeo'],
      [{ fallbacks: [] }, 'fallbacks'],
      [{ fallbacks: [{ model: 'm', extra: 1 }] }, 'fallbacks'],
      [{ betas: ['Bad Flag'] }, 'betas'],
      [{ userId: '' }, 'userId'],
      ['nope', 'anthropic'],
    ];
    for (const [anthropic, field] of cases) {
      assert.throws(
        () =>
          buildAnthropicRequest(
            request({ providerOptions: { anthropic } as AiProviderRequest['providerOptions'] }),
            config,
          ),
        (error) =>
          error instanceof AiError &&
          error.code === 'invalid_options' &&
          error.context.field === field,
      );
    }
  });

  it('builds the count body without the fields count_tokens refuses', () => {
    const built = buildAnthropicCountRequest(
      request({
        tools: [weatherSpec],
        stopSequences: ['x'],
        providerOptions: { anthropic: { inferenceGeo: 'us', speed: 'fast' } },
      }),
      config,
    );
    const keys = Object.keys(built.body);
    for (const field of [
      'max_tokens',
      'stream',
      'stop_sequences',
      'inference_geo',
      'metadata',
      'fallbacks',
    ]) {
      assert.equal(keys.includes(field), false, field);
    }
    assert.equal(built.body.speed, 'fast');
  });
});

describe('buildAnthropicRequest: SDK conformance', () => {
  it('produces shapes the installed SDK parameter types accept', () => {
    const built = buildAnthropicRequest(
      request({
        tools: [weatherSpec],
        reasoning: 'omitted',
        effort: 'low',
        cache: 'auto',
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
          {
            role: 'assistant',
            parts: [{ type: 'tool-call', id: 't1', name: 'weather', input: {} }],
          },
          {
            role: 'user',
            parts: [
              { type: 'tool-result', id: 't1', name: 'weather', output: 'ok', isError: false },
            ],
          },
          { role: 'system', parts: [{ type: 'text', text: 'op' }] },
        ],
      }),
      config,
    );
    // Compile-time: these assignments fail the build if a field or value drifts from the SDK.
    const body: Anthropic.MessageCreateParamsStreaming = built.body;
    const count: Anthropic.MessageCountTokensParams = buildAnthropicCountRequest(
      request(),
      config,
    ).body;
    assert.equal(body.stream, true);
    assert.equal(count.model, 'claude-opus-5-5');
  });
});
