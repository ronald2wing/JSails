/**
 * Run-loop tests over a scripted provider: a text run, a tool loop, events
 * and their order, finish-reason handling (length, refusal, pause), the
 * request shape, header passthrough, checkpoints, and the driver modes
 * (iteration with backpressure, early exit, result-first, single iteration).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { AiError } from '../../src/errors/ai-error.js';
import { userMessage } from '../../src/content/messages.js';
import { appendToConversation, createConversation } from '../../src/conversation/conversation.js';
import type { AiMessage } from '../../src/content/types.js';
import { generate, run } from '../../src/run/run.js';
import type { AiRunEvent } from '../../src/run/run-contract.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { createPricingTable } from '../../src/usage/pricing.js';
import { scriptedProvider } from './scripted-provider.js';

const actor = { kind: 'user', id: 'u1' } as const;

function weatherTool(calls: string[] = []) {
  return defineTool({
    name: 'weather',
    description: 'Current weather for a city.',
    input: z.object({ city: z.string() }),
    execute: ({ city }, ctx) => {
      calls.push(`${ctx.actor.id}:${ctx.toolCallId}:${ctx.step}:${city}`);
      return { city, celsius: 21 };
    },
  });
}

async function collect(events: AsyncIterable<AiRunEvent>): Promise<AiRunEvent[]> {
  const seen: AiRunEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe('run: a text run', () => {
  it('streams deltas, appends the input and the reply, and completes', async () => {
    const provider = scriptedProvider([{ text: 'Hello there.', reasoning: 'brief' }]);
    const handle = run({ model: provider.model(), instructions: 'Be kind.', input: 'Hi' });
    const events = await collect(handle);
    const result = await handle.result;
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'step-start',
        'reasoning-delta',
        'text-delta',
        'text-delta',
        'text-delta',
        'step-finish',
        'finish',
      ],
    );
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Hello there.');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.appended.length, 2);
    assert.equal(result.appended[0]?.role, 'user');
    const reply = result.appended[1];
    assert.equal(reply?.role, 'assistant');
    assert.deepEqual(reply?.meta, {
      provider: 'scripted',
      model: 'model-1',
      responseId: 'resp_0',
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    assert.deepEqual(reply?.native?.content, [{ type: 'raw', index: 0 }]);
    assert.deepEqual(result.messages, result.appended);
    assert.equal(result.steps.length, 1);
    assert.equal(result.usage.inputTokens, 100);
    assert.deepEqual(result.pendingApprovals, []);
    assert.equal(result.error, undefined);
    assert.ok(Object.isFrozen(result));
    const finish = events.at(-1);
    assert.equal(finish?.type === 'finish' ? finish.result : undefined, result);
    const request = provider.requests[0];
    assert.deepEqual(request?.instructions, [{ text: 'Be kind.' }]);
    assert.equal(request?.maxOutputTokens, 16_000);
    assert.equal(request?.toolChoice, 'auto');
  });

  it('continues after history and returns the full transcript', async () => {
    const provider = scriptedProvider([{ text: 'Second answer.' }]);
    const history: AiMessage[] = [
      userMessage('First question'),
      { role: 'assistant', parts: [{ type: 'text', text: 'First answer.' }] },
    ];
    const result = await generate({ model: provider.model(), history, input: 'Again' });
    assert.equal(result.messages.length, 4);
    assert.equal(result.appended.length, 2);
    assert.equal(provider.requests[0]?.messages.length, 3);
  });

  it('runs on history alone when it ends with a user message', async () => {
    const provider = scriptedProvider([{ text: 'Answer.' }]);
    const result = await generate({ model: provider.model(), history: [userMessage('Q')] });
    assert.equal(result.status, 'completed');
    assert.equal(result.appended.length, 1);
  });

  it('appends to a conversation across turns, input included', async () => {
    const provider = scriptedProvider([{ text: 'One.' }, { text: 'Two.' }]);
    let conversation = createConversation({ owner: actor });
    for (const input of ['First', 'Second']) {
      const result = await generate({
        model: provider.model(),
        history: conversation.messages,
        input,
      });
      conversation = appendToConversation(conversation, result);
    }
    assert.equal(conversation.revision, 2);
    assert.deepEqual(
      conversation.messages.map((message) => message.role),
      ['user', 'assistant', 'user', 'assistant'],
    );
    assert.equal(conversation.usage.inputTokens, 200);
  });

  it('prices each step when pricing is given', async () => {
    const provider = scriptedProvider([{ text: 'ok' }]);
    const result = await generate({
      model: provider.model(),
      input: 'Hi',
      pricing: createPricingTable({ 'model-1': { inputPerMTok: 1, outputPerMTok: 10 } }),
    });
    assert.equal(result.costMicroUsd, 200);
    assert.equal(result.steps[0]?.costMicroUsd, 200);
  });
});

describe('run: the tool loop', () => {
  it('executes calls under the caller context and feeds results back', async () => {
    const calls: string[] = [];
    const provider = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'weather', input: { city: 'Oslo' } }] },
      { text: 'It is 21 degrees.' },
    ]);
    const handle = run({
      model: provider.model(),
      input: 'Weather in Oslo?',
      tools: [weatherTool(calls)],
      context: { actor },
    });
    const events = await collect(handle);
    const result = await handle.result;
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'It is 21 degrees.');
    assert.deepEqual(calls, ['u1:c1:0:Oslo']);
    assert.deepEqual(
      result.appended.map((message) => message.role),
      ['user', 'assistant', 'user', 'assistant'],
    );
    const resultsMessage = result.appended[2];
    assert.deepEqual(resultsMessage?.parts, [
      {
        type: 'tool-result',
        id: 'c1',
        name: 'weather',
        output: '{"city":"Oslo","celsius":21}',
        isError: false,
      },
    ]);
    assert.equal(result.steps[0]?.toolResults.length, 1);
    assert.equal(result.usage.inputTokens, 200);
    assert.equal(provider.requests[1]?.messages.length, 3);
    assert.equal(provider.requests[0]?.tools[0]?.name, 'weather');
    assert.equal(provider.requests[0]?.tools[0]?.strict, true);
    const types = events.map((event) => event.type);
    assert.deepEqual(types, [
      'step-start',
      'tool-call-start',
      'tool-call',
      'step-finish',
      'tool-result',
      'tool-results',
      'step-start',
      'text-delta',
      'text-delta',
      'text-delta',
      'text-delta',
      'text-delta',
      'step-finish',
      'finish',
    ]);
    const call = events.find((event) => event.type === 'tool-call');
    assert.equal(call?.type === 'tool-call' && call.exposeToBrowser, false);
  });

  it('reports unknown tools and invalid input to the model without executing', async () => {
    const calls: string[] = [];
    const provider = scriptedProvider([
      {
        toolCalls: [
          { id: 'a', name: 'missing', input: {} },
          { id: 'b', name: 'weather', input: { city: 7 } },
        ],
      },
      { text: 'Sorry.' },
    ]);
    const result = await generate({
      model: provider.model(),
      input: 'Go',
      tools: [weatherTool(calls)],
      context: { actor },
    });
    assert.deepEqual(calls, []);
    const parts = result.appended[2]?.parts ?? [];
    assert.equal(parts.length, 2);
    assert.ok(parts.every((part) => part.type === 'tool-result' && part.isError));
    assert.equal(result.status, 'completed');
  });

  it('never runs tools when the call was cut off at the token limit', async () => {
    const calls: string[] = [];
    const provider = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'weather', input: { city: 'Os' } }], finishReason: 'length' },
    ]);
    const result = await generate({
      model: provider.model(),
      input: 'Go',
      tools: [weatherTool(calls)],
      context: { actor },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'output_truncated');
    assert.deepEqual(calls, []);
    assert.equal(result.appended.length, 1);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]?.message, undefined);
    assert.equal(result.usage.outputTokens, 10);
    assert.equal(result.finishReason, 'length');
  });

  it('completes a text reply that hit the token limit', async () => {
    const provider = scriptedProvider([{ text: 'Partial', finishReason: 'length' }]);
    const result = await generate({ model: provider.model(), input: 'Go' });
    assert.equal(result.status, 'completed');
    assert.equal(result.finishReason, 'length');
    assert.equal(result.text, 'Partial');
  });

  it('fails a refusal without appending it or running its tools', async () => {
    for (const finishReason of ['refusal', 'content-filter'] as const) {
      const calls: string[] = [];
      const provider = scriptedProvider([
        { toolCalls: [{ id: 'c1', name: 'weather', input: { city: 'X' } }], finishReason },
      ]);
      const result = await generate({
        model: provider.model(),
        input: 'Go',
        tools: [weatherTool(calls)],
        context: { actor },
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'refused');
      assert.deepEqual(calls, []);
      assert.equal(result.appended.length, 1);
    }
  });

  it('continues a paused turn with the paused message last', async () => {
    const provider = scriptedProvider([
      { text: 'Working', finishReason: 'pause' },
      { text: 'Done' },
    ]);
    const result = await generate({ model: provider.model(), input: 'Go' });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Done');
    assert.equal(provider.requests[1]?.messages.at(-1)?.role, 'assistant');
    assert.equal(result.appended.length, 3);
  });

  it('treats tool calls under toolChoice none as a provider failure', async () => {
    const provider = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'weather', input: { city: 'X' } }] },
    ]);
    const result = await generate({
      model: provider.model(),
      input: 'Go',
      tools: [weatherTool()],
      context: { actor },
      toolChoice: 'none',
    });
    assert.equal(result.error?.code, 'provider_failed');
    assert.equal(provider.requests[0]?.toolChoice, 'none');
    assert.equal(provider.requests[0]?.tools.length, 1);
  });

  it('fails a response with more calls than the per-step bound', async () => {
    const provider = scriptedProvider([
      {
        toolCalls: [
          { id: 'a', name: 'weather', input: { city: 'A' } },
          { id: 'b', name: 'weather', input: { city: 'B' } },
        ],
      },
    ]);
    const result = await generate({
      model: provider.model(),
      input: 'Go',
      tools: [weatherTool()],
      context: { actor },
      limits: { maxToolCallsPerStep: 1 },
    });
    assert.equal(result.error?.code, 'tool_call_limit');
    assert.equal(result.appended.length, 1);
  });

  it('stops at the step limit with every tool result kept', async () => {
    let n = 0;
    const provider = scriptedProvider(() => {
      n += 1;
      return { toolCalls: [{ id: `c${n}`, name: 'weather', input: { city: 'A' } }] };
    });
    const result = await generate({
      model: provider.model(),
      input: 'Go',
      tools: [weatherTool()],
      context: { actor },
      limits: { maxSteps: 3 },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'step_limit');
    assert.equal(provider.requests.length, 3);
    assert.equal(result.appended.at(-1)?.parts[0]?.type, 'tool-result');
  });

  it('fails when the provider repeats a tool-call id from the history', async () => {
    const provider = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'weather', input: { city: 'A' } }] },
      { toolCalls: [{ id: 'c1', name: 'weather', input: { city: 'B' } }] },
    ]);
    const result = await generate({
      model: provider.model(),
      input: 'Go',
      tools: [weatherTool()],
      context: { actor },
    });
    assert.equal(result.error?.code, 'provider_failed');
    assert.equal(result.error?.context.reason, 'duplicate_tool_call_id');
    assert.equal(result.steps.length, 2);
    assert.equal(result.appended.length, 3);
  });
});

describe('run: request shape and checkpoints', () => {
  it('forwards headers, effort, reasoning, stop sequences, cache, and provider options', async () => {
    const provider = scriptedProvider([{ text: 'ok' }], { parallelTools: false });
    await generate({
      model: provider.model('m2'),
      input: 'Hi',
      headers: { traceparent: '00-abc-def-01', baggage: 'user.id=u1' },
      effort: 'low',
      reasoning: 'summarized',
      stopSequences: ['END'],
      cache: 'off',
      maxOutputTokens: 500,
      providerOptions: { scripted: { speed: 'fast' } },
      tools: [weatherTool()],
      context: { actor },
    });
    const request = provider.requests[0];
    assert.deepEqual(provider.inits[0]?.headers, {
      traceparent: '00-abc-def-01',
      baggage: 'user.id=u1',
    });
    assert.equal(request?.model, 'm2');
    assert.equal(request?.effort, 'low');
    assert.equal(request?.reasoning, 'summarized');
    assert.deepEqual(request?.stopSequences, ['END']);
    assert.equal(request?.cache, 'off');
    assert.equal(request?.maxOutputTokens, 500);
    assert.equal(request?.parallelToolCalls, false);
    assert.deepEqual(request?.providerOptions, { scripted: { speed: 'fast' } });
    assert.ok(Object.isFrozen(request));
  });

  it('awaits onStepFinish before any tool runs and onToolResults after', async () => {
    const order: string[] = [];
    const tool = defineTool({
      name: 'act',
      description: 'Do it.',
      input: z.object({}),
      execute: () => {
        order.push('execute');
        return 'done';
      },
    });
    const provider = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'act', input: {} }] },
      { text: 'ok' },
    ]);
    await generate({
      model: provider.model(),
      input: 'Go',
      tools: [tool],
      context: { actor },
      onStepFinish: async (checkpoint) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`step:${checkpoint.step}:${checkpoint.appended.length}`);
      },
      onToolResults: (checkpoint) => {
        order.push(`results:${checkpoint.appended.length}`);
      },
    });
    assert.deepEqual(order, ['step:0:2', 'execute', 'results:3', 'step:1:4']);
  });

  it('fails with checkpoint_failed and runs no tool when onStepFinish throws', async () => {
    const calls: string[] = [];
    const provider = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'weather', input: { city: 'A' } }] },
    ]);
    const cause = new Error('disk full');
    const result = await generate({
      model: provider.model(),
      input: 'Go',
      tools: [weatherTool(calls)],
      context: { actor },
      onStepFinish: () => {
        throw cause;
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'checkpoint_failed');
    assert.equal(result.error?.cause, cause);
    assert.deepEqual(calls, []);
    assert.equal(result.appended.length, 2);
  });

  it('fails with checkpoint_failed when onToolResults throws, keeping the results', async () => {
    const provider = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'weather', input: { city: 'A' } }] },
    ]);
    const result = await generate({
      model: provider.model(),
      input: 'Go',
      tools: [weatherTool()],
      context: { actor },
      onToolResults: () => Promise.reject(new Error('down')),
    });
    assert.equal(result.error?.code, 'checkpoint_failed');
    assert.equal(result.appended.length, 3);
  });
});

describe('run: driving', () => {
  it('pulls from the provider only as fast as the consumer reads', async () => {
    const provider = scriptedProvider([{ text: 'x'.repeat(400), chunk: 1 }]);
    const handle = run({ model: provider.model(), input: 'Go' });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(provider.pulls <= 3, `pulled ${provider.pulls} parts while paused`);
    let rest = 0;
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      rest += 1;
    }
    assert.ok(rest > 400);
    assert.equal((await handle.result).status, 'completed');
  });

  it('aborts on early exit and still settles the result', async () => {
    const provider = scriptedProvider([{ text: 'x'.repeat(100), chunk: 1, delayMs: 1 }]);
    const handle = run({ model: provider.model(), input: 'Go' });
    for await (const event of handle) {
      if (event.type === 'text-delta') break;
    }
    const result = await handle.result;
    assert.equal(result.status, 'aborted');
    assert.equal(result.error?.code, 'aborted');
    assert.equal(result.appended.length, 1);
    assert.equal(provider.inits[0]?.signal.aborted, true);
  });

  it('drives itself when the result is read first and keeps the events', async () => {
    const provider = scriptedProvider([{ text: 'Hello' }]);
    const handle = run({ model: provider.model(), input: 'Go' });
    const result = await handle.result;
    assert.equal(result.status, 'completed');
    const events = await collect(handle);
    assert.equal(events.at(-1)?.type, 'finish');
    assert.equal(events[0]?.type, 'step-start');
    assert.throws(
      () => handle[Symbol.asyncIterator](),
      (error: unknown) => error instanceof AiError && error.code === 'invalid_options',
    );
  });

  it('does nothing until it is iterated or its result is read', async () => {
    const provider = scriptedProvider([{ text: 'Hello' }]);
    run({ model: provider.model(), input: 'Go' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(provider.requests.length, 0);
  });

  it('settles result once a consumer has seen finish, without pulling the end', async () => {
    const provider = scriptedProvider([{ text: 'done' }]);
    const handle = run({ model: provider.model(), input: 'Go' });
    const iterator = handle[Symbol.asyncIterator]();
    for (;;) {
      const step = await iterator.next();
      assert.equal(step.done, false);
      if (step.value.type === 'finish') break;
    }
    const result = await handle.result;
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'done');
  });

  it('a result-first run replays every event, finish included, to a later iteration', async () => {
    const provider = scriptedProvider([{ text: 'ab', chunk: 1 }]);
    const handle = run({ model: provider.model(), input: 'Go' });
    const result = await handle.result;
    const events = await collect(handle);
    assert.equal(events.at(-1)?.type, 'finish');
    assert.equal(events.filter((event) => event.type === 'text-delta').length, 2);
    assert.equal(result.status, 'completed');
  });

  it('hands the drive to a consumer that arrives after result was read, with backpressure', async () => {
    const provider = scriptedProvider([{ text: 'x'.repeat(400), chunk: 1 }]);
    const handle = run({ model: provider.model(), input: 'Go' });
    const settled = handle.result;
    const iterator = handle[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done === true ? undefined : first.value.type, 'step-start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(provider.pulls <= 3, `pulled ${provider.pulls} parts while paused`);
    const types: string[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      types.push(next.value.type);
    }
    assert.equal(types.filter((type) => type === 'text-delta').length, 400);
    assert.equal(types.at(-1), 'finish');
    assert.equal((await settled).status, 'completed');
  });

  it('a consumer that takes over and leaves early aborts the run, which still settles', async () => {
    const provider = scriptedProvider([{ text: 'x'.repeat(100), chunk: 1, delayMs: 1 }]);
    const handle = run({ model: provider.model(), input: 'Go' });
    const settled = handle.result;
    for await (const event of handle) {
      if (event.type === 'text-delta') break;
    }
    const result = await settled;
    assert.equal(result.status, 'aborted');
    assert.equal(provider.inits[0]?.signal.aborted, true);
  });
});
