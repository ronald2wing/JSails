/**
 * `createFakeProvider`: scripted text, reasoning, and tool calls through the
 * real run loop; chunking; refusals with their category; `length`; usage
 * iterations summed and priced; custom native blocks; conversation-unique
 * default call ids across providers; scripted errors before and during a
 * stream; abort while hanging and between delayed parts; an exhausted
 * script; `generate` and `countTokens`; recorded requests and pull counts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { AiError } from '../../src/errors/ai-error.js';
import { generate, run } from '../../src/run/run.js';
import { countTokens } from '../../src/run/count-tokens.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { createPricingTable } from '../../src/usage/pricing.js';
import { createFakeProvider } from '../../src/testing/fake-provider.js';

const actor = { kind: 'user', id: 'u1' } as const;
const echo = defineTool({
  name: 'echo',
  description: 'Echoes its input.',
  input: z.object({ text: z.string() }),
  execute: ({ text }) => text,
});

const request = {
  model: 'm',
  instructions: [],
  messages: [],
  tools: [],
  toolChoice: 'auto',
  parallelToolCalls: true,
  maxOutputTokens: 100,
  cache: 'off',
} as const;

describe('createFakeProvider', () => {
  it('plays text, reasoning, and tool calls through the run loop and records requests', async () => {
    const provider = createFakeProvider([
      { reasoning: 'plan', toolCalls: [{ name: 'echo', input: { text: 'x' } }] },
      { text: 'done' },
    ]);
    const result = await generate({
      model: provider.model(),
      input: 'go',
      tools: [echo],
      context: { actor },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'done');
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[0]?.model, 'fake-model');
    assert.equal(provider.inits.length, 2);
    const call = result.appended[1];
    assert.deepEqual(call?.parts, [
      { type: 'reasoning', text: 'plan' },
      { type: 'tool-call', id: 'fake_call_1_0', name: 'echo', input: { text: 'x' } },
    ]);
    assert.deepEqual(call?.native, {
      provider: 'fake',
      model: 'fake-model',
      content: [
        { type: 'reasoning', text: 'plan' },
        { type: 'tool_call', id: 'fake_call_1_0', name: 'echo', input: { text: 'x' } },
      ],
    });
  });

  it('chunks deltas by code point', async () => {
    const provider = createFakeProvider([{ text: 'a😀bc', chunkSize: 2 }]);
    const deltas: string[] = [];
    for await (const event of run({ model: provider.model(), input: 'hi' })) {
      if (event.type === 'text-delta') deltas.push(event.delta);
    }
    assert.deepEqual(deltas, ['a😀', 'bc']);
  });

  it('refuses with a category, and stops at length', async () => {
    const refused = await generate({
      model: createFakeProvider([{ text: 'no', refusal: { category: 'cyber' } }]).model(),
      input: 'x',
    });
    assert.equal(refused.status, 'failed');
    assert.equal(refused.error?.code, 'refused');
    assert.equal(refused.steps[0]?.response.refusal?.category, 'cyber');
    const cut = await generate({
      model: createFakeProvider([{ text: 'trunc', finishReason: 'length' }]).model(),
      input: 'x',
    });
    assert.equal(cut.status, 'completed');
    assert.equal(cut.finishReason, 'length');
  });

  it('sums usage iterations and prices each by its model', async () => {
    const provider = createFakeProvider([
      {
        text: 'hi',
        model: 'big',
        iterations: [
          { model: 'big', usage: { inputTokens: 1_000_000, outputTokens: 0 } },
          { model: 'small', usage: { inputTokens: 1_000_000, outputTokens: 0 } },
        ],
      },
    ]);
    const pricing = createPricingTable({
      big: { inputPerMTok: 10, outputPerMTok: 0 },
      small: { inputPerMTok: 1, outputPerMTok: 0 },
    });
    const result = await generate({ model: provider.model('big'), input: 'x', pricing });
    assert.equal(result.usage.inputTokens, 2_000_000);
    assert.equal(result.costMicroUsd, 11_000_000);
  });

  it('keeps custom native blocks', async () => {
    const native = [
      { type: 'thinking', signature: 'sig' },
      { type: 'text', text: 'hi' },
    ];
    const result = await generate({
      model: createFakeProvider([{ text: 'hi', native }]).model(),
      input: 'x',
    });
    assert.deepEqual(result.appended[1]?.native?.content, native);
  });

  it('default call ids stay unique across runs with fresh providers', async () => {
    const first = await generate({
      model: createFakeProvider([
        { toolCalls: [{ name: 'echo', input: { text: 'a' } }] },
        { text: 'one' },
      ]).model(),
      input: 'a',
      tools: [echo],
      context: { actor },
    });
    const second = await generate({
      model: createFakeProvider([
        { toolCalls: [{ name: 'echo', input: { text: 'b' } }] },
        { text: 'two' },
      ]).model(),
      history: first.messages,
      input: 'b',
      tools: [echo],
      context: { actor },
    });
    assert.equal(second.status, 'completed');
  });

  it('fails with the scripted code before or part way through a stream', async () => {
    const before = await generate({
      model: createFakeProvider([{ error: 'rate_limited' }]).model(),
      input: 'x',
    });
    assert.equal(before.error?.code, 'rate_limited');
    const provider = createFakeProvider([
      { text: 'abcdef', chunkSize: 1, error: 'provider_unavailable', errorAfterParts: 3 },
    ]);
    const deltas: string[] = [];
    const handle = run({ model: provider.model(), input: 'x' });
    for await (const event of handle) if (event.type === 'text-delta') deltas.push(event.delta);
    assert.deepEqual(deltas, ['a', 'b']);
    assert.equal((await handle.result).error?.code, 'provider_unavailable');
    assert.equal(provider.pulls, 3);
  });

  it('honours the abort signal while hanging and between delayed parts', async () => {
    const hanging = createFakeProvider([{ text: 'never', hang: true }]);
    const handle = run({ model: hanging.model(), input: 'x' });
    setTimeout(() => handle.abort(), 10);
    assert.equal((await handle.result).status, 'aborted');
    assert.equal(hanging.pulls, 0);

    const slow = createFakeProvider([{ text: 'abcdefgh', chunkSize: 1, delayMs: 20 }]);
    const controller = new AbortController();
    const timed = run({ model: slow.model(), input: 'x', signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await timed.result;
    assert.equal(result.status, 'aborted');
    assert.ok(slow.pulls < 9);
  });

  it('an exhausted script is a value-free invalid_options failure', async () => {
    const provider = createFakeProvider([{ text: 'one' }]);
    await generate({ model: provider.model(), input: 'a' });
    const again = await generate({ model: provider.model(), input: 'b' });
    assert.equal(again.status, 'failed');
    assert.equal(again.error?.code, 'invalid_options');
  });

  it('picks turns with a function, and implements generate and countTokens', async () => {
    const provider = createFakeProvider((req, index) => ({ text: `${req.model}#${index}` }), {
      id: 'mock',
      countTokens: (req) => req.messages.length * 7,
      capabilities: { images: false },
    });
    assert.equal(provider.id, 'mock');
    assert.equal(provider.capabilities.countTokens, true);
    assert.equal(provider.capabilities.images, false);
    const response = await provider.generate(request, {
      signal: new AbortController().signal,
      headers: {},
    });
    assert.equal(response.message.parts[0]?.type, 'text');
    assert.deepEqual(response.message.parts[0], { type: 'text', text: 'm#0' });
    assert.equal(await countTokens({ model: provider.model(), input: 'hello' }), 7);
    assert.equal(createFakeProvider([]).capabilities.countTokens, false);
  });

  it('rejects a bad chunk size', async () => {
    const provider = createFakeProvider([{ text: 'x', chunkSize: 0 }]);
    await assert.rejects(
      provider.generate(request, { signal: new AbortController().signal, headers: {} }),
      (error) => error instanceof AiError && error.code === 'invalid_options',
    );
  });
});
