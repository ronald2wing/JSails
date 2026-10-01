/**
 * AI runtime: chat/stream/run over an injectable transport, including the
 * agent (tool-calling) loop, bounds, and value-free errors.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAiRuntime,
  AiError,
  type AiMessage,
  type AiTool,
  type AiTransport,
} from '../src/index.js';

/** A scripted transport: replies for the first `replies` snapshots, then free. */
function scriptedTransport(replies: readonly AiTransport['complete'][]): AiTransport {
  let index = 0;
  return {
    async complete(request) {
      const reply = replies[Math.min(index, replies.length - 1)] as AiTransport['complete'];
      if (index < replies.length) index += 1;
      return reply(request);
    },
  };
}

const user: AiMessage = { role: 'user', content: 'hi' };

describe('createAiRuntime chat', () => {
  it('returns the transport reply as the assistant message', async () => {
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({ message: { role: 'assistant', content: 'hello' }, toolCalls: [] }),
      ]),
    );
    const reply = await runtime.chat([user]);
    assert.deepEqual(reply, { role: 'assistant', content: 'hello' });
  });

  it('rejects an empty message list with invalid_messages', () => {
    const runtime = createAiRuntime(scriptedTransport([]));
    assert.throws(
      () => runtime.chat([]),
      (error: unknown) => error instanceof AiError && error.code === 'invalid_messages',
    );
  });

  it('rejects tool calls in a bare chat without echoing the tool name', async () => {
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: 't1', name: 'lookup_secret', arguments: {} }],
        }),
      ]),
    );
    await assert.rejects(
      runtime.chat([user]),
      (error: unknown) =>
        error instanceof AiError &&
        error.code === 'unexpected_tool_calls' &&
        !error.message.includes('lookup_secret'),
    );
  });
});

describe('createAiRuntime run (agent loop)', () => {
  it('resolves tool calls locally and returns the final message', async () => {
    const calls: string[][] = [];
    const weather: AiTool = {
      name: 'weather',
      description: 'get weather',
      call: async (args) => {
        calls.push(Object.keys(args));
        return { temp: 70 };
      },
    };
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({
          message: { role: 'assistant', content: 'checking' },
          toolCalls: [{ id: 't1', name: 'weather', arguments: { city: 'Paris' } }],
        }),
        async () => ({ message: { role: 'assistant', content: 'it is 70' }, toolCalls: [] }),
      ]),
    );
    const final = await runtime.run([user], { tools: [weather], maxSteps: 4 });
    assert.equal(final.content, 'it is 70');
    assert.deepEqual(calls, [['city']]);
  });

  it('throws unknown_tool for a tool the caller did not provide', async () => {
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: 't1', name: 'ghost', arguments: {} }],
        }),
      ]),
    );
    await assert.rejects(
      runtime.run([user], { tools: [], maxSteps: 2 }),
      (error: unknown) =>
        error instanceof AiError &&
        error.code === 'unknown_tool' &&
        !error.message.includes('ghost'),
    );
  });

  it('preserves a value-free AiError raised by a tool', async () => {
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: 't1', name: 'bad', arguments: { secret: 'value' } }],
        }),
      ]),
    );
    const bad: AiTool = {
      name: 'bad',
      description: 'fails',
      call: () => {
        throw new AiError('invalid_tool_arguments', 'AI tool arguments do not match');
      },
    };
    await assert.rejects(runtime.run([user], { tools: [bad], maxSteps: 2 }), (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, 'invalid_tool_arguments');
      assert.equal(error.message.includes('value'), false);
      return true;
    });
  });

  it('throws loop_exceeded when the step bound is exhausted', async () => {
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({
          message: { role: 'assistant', content: 'still going' },
          toolCalls: [{ id: 't1', name: 'noop', arguments: {} }],
        }),
      ]),
    );
    const noop: AiTool = { name: 'noop', description: 'nothing', call: async () => 'ok' };
    await assert.rejects(
      runtime.run([user], { tools: [noop], maxSteps: 1 }),
      (error: unknown) => error instanceof AiError && error.code === 'loop_exceeded',
    );
  });
});

describe('createAiRuntime stream fallback', () => {
  it('yields message + done when the transport has no stream', async () => {
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({ message: { role: 'assistant', content: 'ok' }, toolCalls: [] }),
      ]),
    );
    const events = [];
    for await (const event of runtime.stream([user])) {
      events.push(event);
    }
    assert.deepEqual(
      events.map((e) => e.type),
      ['message', 'done'],
    );
  });
});

describe('createAiRuntime run bounds and tool errors', () => {
  const toolCallReply = (names: readonly string[]): AiTransport['complete'] => {
    return async () => ({
      message: { role: 'assistant', content: '' },
      toolCalls: names.map((name, index) => ({ id: `t${String(index)}`, name, arguments: {} })),
    });
  };
  const finalReply: AiTransport['complete'] = async () => ({
    message: { role: 'assistant', content: 'done' },
    toolCalls: [],
  });

  it('reports a failing tool back to the model in report mode, value-free', async () => {
    const seen: AiMessage[][] = [];
    const transport: AiTransport = {
      async complete(request) {
        seen.push([...request.messages]);
        return seen.length === 1 ? toolCallReply(['boom', 'ghost'])(request) : finalReply(request);
      },
    };
    const boom: AiTool = {
      name: 'boom',
      description: 'throws',
      call: () => {
        throw new Error('db password=hunter2');
      },
    };
    const final = await createAiRuntime(transport).run([user], {
      tools: [boom],
      onToolError: 'report',
    });

    assert.equal(final.content, 'done');
    const toolMessages = seen[1]!.filter((message) => message.role === 'tool');
    assert.deepEqual(
      toolMessages.map((message) => message.content),
      ['error: the tool failed', 'error: no tool with this name is available'],
    );
    assert.equal(JSON.stringify(seen).includes('hunter2'), false);
  });

  it('reports invalid arguments distinctly in report mode', async () => {
    let second: readonly AiMessage[] = [];
    const transport = scriptedTransport([
      toolCallReply(['strict']),
      async (request) => {
        second = request.messages;
        return finalReply(request);
      },
    ]);
    const strict: AiTool = {
      name: 'strict',
      description: 'validates',
      call: () => {
        throw new AiError('invalid_tool_arguments', 'bad args');
      },
    };
    await createAiRuntime(transport).run([user], { tools: [strict], onToolError: 'report' });
    assert.equal(second.at(-1)?.content, 'error: the arguments do not match the tool parameters');
  });

  it('labels a throwing tool tool_failed in the default throw mode', async () => {
    const boom: AiTool = {
      name: 'boom',
      description: 'throws',
      call: () => {
        throw new Error('internal detail');
      },
    };
    await assert.rejects(
      createAiRuntime(scriptedTransport([toolCallReply(['boom'])])).run([user], { tools: [boom] }),
      (error: unknown) =>
        error instanceof AiError &&
        error.code === 'tool_failed' &&
        !error.message.includes('internal'),
    );
  });

  it('refuses a reply with more tool calls than maxToolCallsPerStep before running any', async () => {
    let calls = 0;
    const noop: AiTool = {
      name: 'noop',
      description: 'counts',
      call: () => {
        calls += 1;
        return 'ok';
      },
    };
    const runtime = createAiRuntime(scriptedTransport([toolCallReply(['noop', 'noop', 'noop'])]));
    await assert.rejects(
      runtime.run([user], { tools: [noop], maxToolCallsPerStep: 2 }),
      (error: unknown) => error instanceof AiError && error.code === 'too_many_tool_calls',
    );
    assert.equal(calls, 0);
  });

  it('truncates a tool result to maxToolResultChars', async () => {
    let second: readonly AiMessage[] = [];
    const transport = scriptedTransport([
      toolCallReply(['big']),
      async (request) => {
        second = request.messages;
        return finalReply(request);
      },
    ]);
    const big: AiTool = { name: 'big', description: 'large', call: () => 'x'.repeat(10_000) };
    await createAiRuntime(transport).run([user], { tools: [big], maxToolResultChars: 100 });
    const content = second.at(-1)?.content ?? '';
    assert.equal(content.length, 100);
    assert.ok(content.endsWith('[truncated]'));
  });

  it('rejects invalid bounds and options with invalid_options', () => {
    const runtime = createAiRuntime(scriptedTransport([finalReply]));
    for (const options of [
      { maxSteps: Number.NaN },
      { maxSteps: -1 },
      { maxSteps: 1.5 },
      { maxToolCallsPerStep: 0 },
      { maxToolResultChars: Number.POSITIVE_INFINITY },
      { temperature: Number.NaN },
      { onToolError: 'ignore' as never },
    ]) {
      assert.throws(
        () => runtime.run([user], options),
        (error: unknown) => error instanceof AiError && error.code === 'invalid_options',
      );
    }
  });

  it('forwards temperature and the abort signal to the transport', async () => {
    let request: Parameters<AiTransport['complete']>[0] | undefined;
    const transport: AiTransport = {
      async complete(received) {
        request = received;
        return finalReply(received);
      },
    };
    const controller = new AbortController();
    await createAiRuntime(transport).chat([user], {
      temperature: 0.2,
      signal: controller.signal,
    });
    assert.equal(request?.temperature, 0.2);
    assert.equal(request?.signal, controller.signal);
  });

  it('stops the loop with aborted once the signal fires', async () => {
    const controller = new AbortController();
    const noop: AiTool = {
      name: 'noop',
      description: 'aborts',
      call: () => {
        controller.abort();
        return 'ok';
      },
    };
    const transport = scriptedTransport([toolCallReply(['noop']), finalReply]);
    await assert.rejects(
      createAiRuntime(transport).run([user], { tools: [noop], signal: controller.signal }),
      (error: unknown) => error instanceof AiError && error.code === 'aborted',
    );
  });

  it('rejects a null message with invalid_messages instead of a TypeError', () => {
    const runtime = createAiRuntime(scriptedTransport([finalReply]));
    assert.throws(
      () => runtime.chat([null as never]),
      (error: unknown) => error instanceof AiError && error.code === 'invalid_messages',
    );
  });
});
