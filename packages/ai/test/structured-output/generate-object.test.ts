/**
 * `generateObject` tests over a scripted provider: native output and the tool
 * fallback, OpenAI restore, wrapped non-object roots, and the valid, invalid,
 * truncated, refused, aborted, and timed-out outcomes (a provider that ignores
 * its signal included), unparseable tool-fallback input, and the reserved
 * `INVALID_JSON` property.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { AiError, type AiErrorCode } from '../../src/errors/ai-error.js';
import type { AiFinishReason, AiMessage, AiPart } from '../../src/content/types.js';
import type {
  AiCallInit,
  AiProvider,
  AiProviderCapabilities,
  AiProviderRequest,
  AiProviderResponse,
} from '../../src/provider/contract.js';
import { generateObject } from '../../src/structured-output/generate-object.js';
import { createPricingTable } from '../../src/usage/pricing.js';

const CANARY = 'CANARY-object';
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
const messages: readonly AiMessage[] = [
  { role: 'user', parts: [{ type: 'text', text: 'Extract the person.' }] },
];

interface Scripted {
  readonly parts: readonly AiPart[];
  readonly finishReason?: AiFinishReason;
}

function provider(
  reply: Scripted | ((request: AiProviderRequest, init: AiCallInit) => Promise<Scripted>),
  overrides: Partial<AiProviderCapabilities> = {},
): AiProvider & { readonly requests: AiProviderRequest[] } {
  const requests: AiProviderRequest[] = [];
  return {
    id: 'fake',
    requests,
    capabilities: {
      tools: true,
      parallelTools: true,
      structuredOutput: 'native',
      strictTools: true,
      schemaProfile: 'anthropic-strict',
      images: true,
      pdf: true,
      reasoning: true,
      promptCache: 'explicit',
      countTokens: false,
      ...overrides,
    },
    async *stream() {
      yield* [];
      throw new Error('not used');
    },
    async generate(request, init): Promise<AiProviderResponse> {
      requests.push(request);
      const scripted = typeof reply === 'function' ? await reply(request, init) : reply;
      return {
        id: 'resp_1',
        model: request.model,
        message: { role: 'assistant', parts: scripted.parts },
        finishReason: scripted.finishReason ?? 'stop',
        usage,
        iterations: [{ provider: 'fake', model: request.model, usage }],
      };
    },
  };
}

const Person = z.object({ name: z.string().min(1), age: z.int().min(0).optional() });
const text = (value: string): Scripted => ({ parts: [{ type: 'text', text: value }] });

async function rejectsWith(promise: Promise<unknown>, code: AiErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, code);
    assert.equal(`${error.message}${JSON.stringify(error.context)}`.includes(CANARY), false);
    return true;
  });
}

describe('generateObject', () => {
  it('sends a native output schema and returns the validated object with cost', async () => {
    const fake = provider(text('{"name":"Ada","age":36}'));
    const result = await generateObject({
      model: { provider: fake, id: 'm1' },
      instructions: 'Be exact.',
      messages,
      schema: Person,
      name: 'person',
      pricing: createPricingTable({ m1: { inputPerMTok: 1, outputPerMTok: 10 } }),
    });
    assert.deepEqual(result.object, { name: 'Ada', age: 36 });
    assert.equal(result.costMicroUsd, 300);
    assert.deepEqual(result.usage, usage);
    const request = fake.requests[0];
    assert.equal(request?.output?.name, 'person');
    assert.equal(request?.output?.schema.additionalProperties, false);
    assert.deepEqual(request?.tools, []);
    assert.equal(request?.toolChoice, 'none');
    assert.deepEqual(request?.instructions, [{ text: 'Be exact.' }]);
    assert.equal(request?.maxOutputTokens, 16_000);
  });

  it('restores the OpenAI encoding before validation', async () => {
    const fake = provider(text('{"name":"Ada","age":null}'), { schemaProfile: 'openai-strict' });
    const result = await generateObject({
      model: { provider: fake, id: 'm' },
      messages,
      schema: Person,
    });
    assert.deepEqual(result.object, { name: 'Ada' });
    assert.deepEqual(fake.requests[0]?.output?.schema.required, ['name', 'age']);
  });

  it('falls back to a single tool call steered by instructions', async () => {
    const fake = provider(
      {
        parts: [{ type: 'tool-call', id: 't', name: 'output', input: { name: 'Lin' } }],
        finishReason: 'tool-calls',
      },
      { structuredOutput: 'tool' },
    );
    const result = await generateObject({
      model: { provider: fake, id: 'm' },
      messages,
      schema: Person,
    });
    assert.deepEqual(result.object, { name: 'Lin' });
    const request = fake.requests[0];
    assert.equal(request?.toolChoice, 'auto');
    assert.equal(request?.tools[0]?.name, 'output');
    assert.equal(request?.tools[0]?.strict, true);
    assert.match(String(request?.instructions.at(-1)?.text), /output tool/);
    assert.equal(request?.output, undefined);
  });

  it('wraps a non-object root on the wire and unwraps it', async () => {
    const fake = provider(text('{"value":["a","b"]}'));
    const result = await generateObject({
      model: { provider: fake, id: 'm' },
      messages,
      schema: z.array(z.string()),
    });
    assert.deepEqual(result.object, ['a', 'b']);
    assert.deepEqual(fake.requests[0]?.output?.schema.required, ['value']);
  });

  it('uses a data contract name as the output name', async () => {
    const fake = provider(text('{"name":"Ada"}'));
    await generateObject({
      model: { provider: fake, id: 'm' },
      messages,
      schema: { name: 'Person', schema: Person },
    });
    assert.equal(fake.requests[0]?.output?.name, 'Person');
  });

  it('maps invalid, truncated, refused, and unsupported outcomes to value-free errors', async () => {
    const model = (reply: Scripted, overrides: Partial<AiProviderCapabilities> = {}) => ({
      provider: provider(reply, overrides),
      id: 'm',
    });
    await rejectsWith(
      generateObject({ model: model(text(`not json ${CANARY}`)), messages, schema: Person }),
      'output_invalid',
    );
    await rejectsWith(
      generateObject({
        model: model(text(`{"name":"","secret":"${CANARY}"}`)),
        messages,
        schema: Person,
      }),
      'output_invalid',
    );
    await rejectsWith(
      generateObject({ model: model(text('')), messages, schema: Person }),
      'output_invalid',
    );
    await rejectsWith(
      generateObject({
        model: model({ ...text('{"na'), finishReason: 'length' }),
        messages,
        schema: Person,
      }),
      'output_truncated',
    );
    await rejectsWith(
      generateObject({
        model: model({ parts: [], finishReason: 'refusal' }),
        messages,
        schema: Person,
      }),
      'refused',
    );
    await rejectsWith(
      generateObject({ model: model({ parts: [] }), messages, schema: Person }),
      'provider_failed',
    );
    await rejectsWith(
      generateObject({
        model: model({ ...text('I cannot help.'), finishReason: 'refusal' }),
        messages,
        schema: Person,
      }),
      'refused',
    );
    await rejectsWith(
      generateObject({
        model: model({ ...text('x'), finishReason: 'content-filter' }),
        messages,
        schema: Person,
      }),
      'refused',
    );
    await rejectsWith(
      generateObject({
        model: model(text('{}'), { structuredOutput: 'tool' }),
        messages,
        schema: Person,
      }),
      'output_invalid',
    );
    await rejectsWith(
      generateObject({
        model: model(text('{}'), { structuredOutput: 'none' }),
        messages,
        schema: Person,
      }),
      'unsupported_capability',
    );
  });

  it('validates options and messages before calling the provider', async () => {
    const fake = provider(text('{}'));
    await rejectsWith(
      generateObject({ model: { provider: fake, id: 'm' }, messages: [], schema: Person }),
      'invalid_messages',
    );
    await rejectsWith(
      generateObject({
        model: { provider: fake, id: 'm' },
        messages,
        schema: Person,
        name: 'bad name',
      }),
      'invalid_options',
    );
    await rejectsWith(
      generateObject({
        model: { provider: fake, id: 'm' },
        messages,
        schema: Person,
        maxOutputTokens: 0,
      }),
      'invalid_options',
    );
    await rejectsWith(
      generateObject({ model: { provider: fake, id: 'm' }, messages, schema: {} as typeof Person }),
      'invalid_options',
    );
    await rejectsWith(
      generateObject({
        model: { provider: fake, id: 'm' },
        messages,
        schema: z.object({ m: z.record(z.string(), z.string()) }),
      }),
      'invalid_options',
    );
    assert.equal(fake.requests.length, 0);
  });

  it('honours the caller signal, the deadline, and maps unknown provider errors', async () => {
    const hanging = provider(
      (_request, init) =>
        new Promise<Scripted>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error(CANARY)), { once: true });
        }),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await rejectsWith(
      generateObject({
        model: { provider: hanging, id: 'm' },
        messages,
        schema: Person,
        signal: controller.signal,
      }),
      'aborted',
    );
    await rejectsWith(
      generateObject({
        model: { provider: hanging, id: 'm' },
        messages,
        schema: Person,
        timeoutMs: 10,
      }),
      'timed_out',
    );
    await rejectsWith(
      generateObject({
        model: { provider: hanging, id: 'm' },
        messages,
        schema: Person,
        signal: AbortSignal.abort(),
      }),
      'aborted',
    );
    const failing = provider(() => Promise.reject(new Error(CANARY)));
    await rejectsWith(
      generateObject({ model: { provider: failing, id: 'm' }, messages, schema: Person }),
      'provider_failed',
    );
    const limited = provider(() =>
      Promise.reject(new AiError('rate_limited', 'rate limited', { retryAfterMs: 1000 })),
    );
    await rejectsWith(
      generateObject({ model: { provider: limited, id: 'm' }, messages, schema: Person }),
      'rate_limited',
    );
  });

  it('forwards headers and provider options', async () => {
    let headers: Readonly<Record<string, string>> | undefined;
    const fake = provider(async (_request, init) => {
      headers = init.headers;
      return text('{"name":"Ada"}');
    });
    await generateObject({
      model: { provider: fake, id: 'm' },
      messages,
      schema: Person,
      headers: { traceparent: '00-abc-def-01' },
      providerOptions: { fake: { speed: 'fast' } },
      effort: 'low',
    });
    assert.deepEqual(headers, { traceparent: '00-abc-def-01' });
    assert.deepEqual(fake.requests[0]?.providerOptions, { fake: { speed: 'fast' } });
    assert.equal(fake.requests[0]?.effort, 'low');
  });

  it('settles a deadline or abort even when the provider ignores its signal', async () => {
    const deaf = provider(() => new Promise<Scripted>(() => undefined));
    const started = Date.now();
    await rejectsWith(
      generateObject({
        model: { provider: deaf, id: 'm' },
        messages,
        schema: Person,
        timeoutMs: 30,
      }),
      'timed_out',
    );
    assert.ok(Date.now() - started < 2_000);
    const controller = new AbortController();
    const pending = generateObject({
      model: { provider: deaf, id: 'm' },
      messages,
      schema: Person,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await rejectsWith(pending, 'aborted');
  });

  it('refuses an unparseable tool-fallback answer even for a schema of optional fields', async () => {
    const fake = provider(
      {
        parts: [
          {
            type: 'tool-call',
            id: 't',
            name: 'output',
            input: { INVALID_JSON: `{"note":"${CANARY}` },
          },
        ],
        finishReason: 'tool-calls',
      },
      { structuredOutput: 'tool' },
    );
    await assert.rejects(
      generateObject({
        model: { provider: fake, id: 'm' },
        messages,
        schema: z.object({ note: z.string().optional() }),
      }),
      (error: unknown) =>
        error instanceof AiError &&
        error.code === 'output_invalid' &&
        error.context.reason === 'json' &&
        !JSON.stringify(error.context).includes(CANARY),
    );
  });

  it('refuses a schema that declares the reserved INVALID_JSON property', async () => {
    await assert.rejects(
      generateObject({
        model: { provider: provider(text('{}')), id: 'm' },
        messages,
        schema: z.object({ INVALID_JSON: z.string() }),
      }),
      (error: unknown) =>
        error instanceof AiError &&
        error.code === 'invalid_options' &&
        error.context.reason === 'reserved_property',
    );
  });
});
