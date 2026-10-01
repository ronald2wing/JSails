/**
 * OpenAI-compatible request building: golden bodies for the instruction role
 * and the output-token field, tool results split into `role: 'tool'`
 * messages, capability flags (images, PDFs, tools, structured output,
 * strict), effort clamping, sampling options, byte-stable serialization, and
 * a compile-time check against the installed `openai` parameter types.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type OpenAI from 'openai';

import { AiError } from '../../src/errors/ai-error.js';
import type { AiProviderRequest } from '../../src/provider/contract.js';
import {
  readOpenAICompatibleConfig,
  type OpenAICompatibleSettings,
} from '../../src/openai-compatible/openai-options.js';
import { buildOpenAIRequest } from '../../src/openai-compatible/openai-request.js';

const weatherSpec = {
  name: 'weather',
  description: 'Current weather for a city.',
  inputSchema: {
    type: 'object',
    required: ['city'],
    additionalProperties: false,
    properties: { city: { type: 'string' } },
  },
  strict: true,
} as const;

function config(settings: Partial<OpenAICompatibleSettings> = {}) {
  return readOpenAICompatibleConfig(settings);
}

function request(overrides: Partial<AiProviderRequest> = {}): AiProviderRequest {
  return {
    model: 'gpt-5.2',
    instructions: [{ text: 'Be brief.' }, { text: 'Use metric.' }],
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Weather?' }] }],
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: true,
    maxOutputTokens: 256,
    cache: 'auto',
    ...overrides,
  };
}

function unsupported(fn: () => unknown, capability: string): void {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, 'unsupported_capability');
    assert.equal(error.context.capability, capability);
    return true;
  });
}

describe('buildOpenAIRequest: golden bodies', () => {
  it('builds the default body: system role, max_completion_tokens, usage chunk', () => {
    assert.equal(
      JSON.stringify(
        buildOpenAIRequest(
          request({ tools: [weatherSpec], parallelToolCalls: false, stopSequences: ['END'] }),
          config(),
        ),
      ),
      JSON.stringify({
        model: 'gpt-5.2',
        messages: [
          { role: 'system', content: 'Be brief.\n\nUse metric.' },
          { role: 'user', content: 'Weather?' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'weather',
              description: 'Current weather for a city.',
              parameters: {
                additionalProperties: false,
                properties: { city: { type: 'string' } },
                required: ['city'],
                type: 'object',
              },
              strict: true,
            },
          },
        ],
        parallel_tool_calls: false,
        max_completion_tokens: 256,
        stop: ['END'],
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
  });

  it('uses the developer role and max_tokens when configured, and no usage chunk without support', () => {
    const body = buildOpenAIRequest(
      request({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
          { role: 'system', parts: [{ type: 'text', text: 'Terse.' }] },
        ],
      }),
      config({
        instructionsRole: 'developer',
        maxTokensField: 'max_tokens',
        supports: { streamUsage: false },
      }),
    );
    assert.deepEqual(body.messages, [
      { role: 'developer', content: 'Be brief.\n\nUse metric.' },
      { role: 'user', content: 'hi' },
      { role: 'developer', content: 'Terse.' },
    ]);
    assert.equal(body.max_tokens, 256);
    assert.equal(body.max_completion_tokens, undefined);
    assert.equal(body.stream_options, undefined);
  });

  it('serializes the same request to byte-identical bodies', () => {
    const make = (): string =>
      JSON.stringify(buildOpenAIRequest(request({ tools: [weatherSpec] }), config()));
    assert.equal(make(), make());
  });
});

describe('buildOpenAIRequest: transcripts', () => {
  it('splits tool results into tool messages and moves tool images to a user message', () => {
    const body = buildOpenAIRequest(
      request({
        instructions: [],
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Weather?' }] },
          {
            role: 'assistant',
            parts: [
              { type: 'reasoning', text: 'not replayable' },
              { type: 'text', text: 'Checking.' },
              {
                type: 'tool-call',
                id: 'toolu_01AnthropicIdThatIsRatherLongForOpenAI',
                name: 'weather',
                input: { city: 'Paris' },
              },
              { type: 'tool-call', id: 'c2', name: 'weather', input: { city: 'Oslo' } },
            ],
            native: { provider: 'anthropic', model: 'claude', content: [{ type: 'thinking' }] },
          },
          {
            role: 'user',
            parts: [
              {
                type: 'tool-result',
                id: 'toolu_01AnthropicIdThatIsRatherLongForOpenAI',
                name: 'weather',
                output: 'sunny',
                isError: false,
              },
              {
                type: 'tool-result',
                id: 'c2',
                name: 'weather',
                output: [
                  { type: 'text', text: 'map:' },
                  {
                    type: 'image',
                    source: { kind: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
                  },
                ],
                isError: true,
              },
              { type: 'text', text: 'Thanks' },
            ],
          },
        ],
      }),
      config(),
    );
    const assistant = body.messages[1];
    assert.equal(assistant?.role, 'assistant');
    if (assistant?.role !== 'assistant') return;
    assert.equal(assistant.content, 'Checking.');
    const fitted = assistant.tool_calls?.[0]?.id ?? '';
    assert.ok(fitted.length <= 40 && /^[A-Za-z0-9_-]+$/.test(fitted));
    assert.deepEqual(assistant.tool_calls?.[1], {
      id: 'c2',
      type: 'function',
      function: { name: 'weather', arguments: '{"city":"Oslo"}' },
    });
    assert.deepEqual(body.messages.slice(2), [
      { role: 'tool', tool_call_id: fitted, content: 'sunny' },
      { role: 'tool', tool_call_id: 'c2', content: 'map:' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          { type: 'text', text: 'Thanks' },
        ],
      },
    ]);
  });

  it('refuses content the server does not support instead of dropping it', () => {
    const image = request({
      messages: [
        {
          role: 'user',
          parts: [{ type: 'image', source: { kind: 'url', url: 'https://example.org/a.png' } }],
        },
      ],
    });
    unsupported(() => buildOpenAIRequest(image, config({ supports: { images: false } })), 'images');
    const pdf = request({
      messages: [
        {
          role: 'user',
          parts: [
            {
              type: 'file',
              mediaType: 'application/pdf',
              source: { kind: 'base64', mediaType: 'application/pdf', data: 'JVBERi0=' },
            },
          ],
        },
      ],
    });
    unsupported(() => buildOpenAIRequest(pdf, config()), 'pdf');
    assert.deepEqual(buildOpenAIRequest(pdf, config({ supports: { pdf: true } })).messages[1], {
      role: 'user',
      content: [
        {
          type: 'file',
          file: { file_data: 'data:application/pdf;base64,JVBERi0=', filename: 'document.pdf' },
        },
      ],
    });
    unsupported(
      () =>
        buildOpenAIRequest(
          request({ tools: [weatherSpec] }),
          config({ supports: { tools: false } }),
        ),
      'tools',
    );
    unsupported(
      () =>
        buildOpenAIRequest(
          request({ output: { name: 'o', schema: { type: 'object' } } }),
          config({ supports: { structuredOutput: 'tool' } }),
        ),
      'structured_output',
    );
  });

  it('decodes a plain-text file into text', () => {
    const body = buildOpenAIRequest(
      request({
        instructions: [],
        messages: [
          {
            role: 'user',
            parts: [
              {
                type: 'file',
                mediaType: 'text/plain',
                source: { kind: 'base64', mediaType: 'text/plain', data: 'aMOpbGxv' },
              },
            ],
          },
        ],
      }),
      config(),
    );
    assert.deepEqual(body.messages[0], { role: 'user', content: 'héllo' });
  });
});

describe('buildOpenAIRequest: capabilities and options', () => {
  it('sends response_format strict only under the strict profile', () => {
    const output = { name: 'answer', schema: { type: 'object', properties: {} } };
    assert.deepEqual(buildOpenAIRequest(request({ output }), config()).response_format, {
      type: 'json_schema',
      json_schema: { name: 'answer', schema: { properties: {}, type: 'object' }, strict: true },
    });
    const loose = config({ supports: { strictTools: false } });
    assert.equal(loose.capabilities.schemaProfile, 'loose');
    assert.equal(
      buildOpenAIRequest(request({ output }), loose).response_format?.json_schema.strict,
      false,
    );
  });

  it('sends reasoning_effort only with reasoning support, clamped to the maximum', () => {
    assert.equal(
      buildOpenAIRequest(request({ effort: 'max' }), config()).reasoning_effort,
      undefined,
    );
    assert.equal(
      buildOpenAIRequest(request({ effort: 'max' }), config({ supports: { reasoning: true } }))
        .reasoning_effort,
      'high',
    );
    assert.equal(
      buildOpenAIRequest(request({ effort: 'low' }), config({ supports: { reasoning: true } }))
        .reasoning_effort,
      'low',
    );
    assert.equal(
      buildOpenAIRequest(
        request({ effort: 'max' }),
        config({ supports: { reasoning: true }, maxReasoningEffort: 'max' }),
      ).reasoning_effort,
      'max',
    );
  });

  it('passes sampling options only from providerOptions.openaiCompatible', () => {
    const body = buildOpenAIRequest(
      request({
        providerOptions: {
          openaiCompatible: {
            temperature: 0.2,
            topP: 0.9,
            seed: 7,
            promptCacheKey: 'k',
            user: 'u',
          },
        },
      }),
      config(),
    );
    assert.deepEqual(
      [body.temperature, body.top_p, body.seed, body.prompt_cache_key, body.user],
      [0.2, 0.9, 7, 'k', 'u'],
    );
    for (const [options, field] of [
      [{ temperature: 3 }, 'temperature'],
      [{ topP: -1 }, 'topP'],
      [{ seed: 1.5 }, 'seed'],
      [{ top_k: 3 }, 'top_k'],
    ] as const) {
      assert.throws(
        () =>
          buildOpenAIRequest(
            request({ providerOptions: { openaiCompatible: options as never } }),
            config(),
          ),
        (error) =>
          error instanceof AiError &&
          error.code === 'invalid_options' &&
          error.context.field === field,
      );
    }
  });

  it('validates settings, naming only the field', () => {
    for (const [settings, field] of [
      [{ name: 'bad name' }, 'name'],
      [{ maxTokensField: 'tokens' }, 'maxTokensField'],
      [{ instructionsRole: 'user' }, 'instructionsRole'],
      [{ maxReasoningEffort: 'huge' }, 'maxReasoningEffort'],
      [{ supports: { vision: true } }, 'supports.vision'],
      [{ supports: { images: 'yes' } }, 'supports.images'],
      [{ supports: { structuredOutput: 'json' } }, 'supports.structuredOutput'],
    ] as const) {
      assert.throws(
        () => readOpenAICompatibleConfig(settings as unknown as OpenAICompatibleSettings),
        (error) =>
          error instanceof AiError &&
          error.code === 'invalid_options' &&
          error.context.field === field,
      );
    }
  });

  it('produces bodies the installed SDK parameter types accept', () => {
    const body: OpenAI.Chat.ChatCompletionCreateParamsStreaming = buildOpenAIRequest(
      request({
        tools: [weatherSpec],
        output: { name: 'o', schema: { type: 'object' } },
        effort: 'low',
      }),
      config({ supports: { reasoning: true } }),
    );
    assert.equal(body.stream, true);
  });
});
