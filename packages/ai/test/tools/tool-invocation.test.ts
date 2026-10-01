/**
 * Tool invocation tests: profile choice, provider specs, input restore and
 * validation (invalid input never reaches `execute`), approval, authorization,
 * deadlines, aborts, output validation, serialization, and the value-free
 * error results.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import type { AiProviderCapabilities } from '../../src/provider/contract.js';
import { defineTool, type AiToolContext } from '../../src/tools/define-tool.js';
import { AiToolFailure } from '../../src/tools/tool-failure.js';
import {
  TOOL_ERROR_TEXT,
  authorizeToolCall,
  executeTool,
  parseToolInput,
  toolNeedsApproval,
  toolSchemaProfile,
  toolSpec,
} from '../../src/tools/tool-invocation.js';
import { TRUNCATION_MARKER } from '../../src/tools/tool-serialization.js';

const CANARY = 'CANARY-tool-secret';

const capabilities = (overrides: Partial<AiProviderCapabilities>): AiProviderCapabilities => ({
  tools: true,
  parallelTools: true,
  structuredOutput: 'native',
  strictTools: true,
  schemaProfile: 'anthropic-strict',
  images: true,
  pdf: true,
  reasoning: true,
  promptCache: 'explicit',
  countTokens: true,
  ...overrides,
});

function ctx(signal: AbortSignal = new AbortController().signal): AiToolContext {
  return { actor: { kind: 'user', id: 'u1' }, toolCallId: 'call_1', step: 0, signal };
}

const echo = defineTool({
  name: 'echo',
  description: 'Echo.',
  input: z.object({ text: z.string().max(10), note: z.string().optional() }),
  execute: (input) => input,
});

describe('toolSchemaProfile and toolSpec', () => {
  it('uses the provider profile only when both sides are strict', () => {
    assert.equal(toolSchemaProfile(echo, capabilities({})), 'anthropic-strict');
    assert.equal(
      toolSchemaProfile(echo, capabilities({ schemaProfile: 'openai-strict' })),
      'openai-strict',
    );
    assert.equal(toolSchemaProfile(echo, capabilities({ strictTools: false })), 'loose');
    const loose = defineTool({
      name: 'l',
      description: 'd',
      input: z.object({}),
      strict: false,
      execute: () => 1,
    });
    assert.equal(toolSchemaProfile(loose, capabilities({})), 'loose');
  });

  it('builds a deterministic spec with the lowered schema', () => {
    const spec = toolSpec(echo, 'openai-strict');
    assert.deepEqual(spec.inputSchema.required, ['text', 'note']);
    assert.equal(spec.strict, true);
    assert.equal(spec.inputSchema, toolSpec(echo, 'openai-strict').inputSchema);
    assert.equal(toolSpec(echo, 'loose').strict, false);
  });
});

describe('parseToolInput', () => {
  it('restores the OpenAI encoding before validating', () => {
    const parsed = parseToolInput(echo, { text: 'hi', note: null }, 'openai-strict');
    assert.deepEqual(parsed, { ok: true, input: { text: 'hi' } });
  });

  it('turns invalid input into an error outcome naming paths and codes, never values', () => {
    let executed = 0;
    const tool = defineTool({
      name: 'guarded',
      description: 'd',
      input: z.object({ text: z.string().max(3), count: z.int() }),
      execute: () => {
        executed += 1;
        return 'ran';
      },
    });
    const parsed = parseToolInput(tool, { text: CANARY, count: 'many' }, 'anthropic-strict');
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.outcome.isError, true);
    assert.equal(parsed.outcome.code, 'tool_input_invalid');
    assert.equal(
      parsed.outcome.output,
      `${TOOL_ERROR_TEXT.inputInvalid} (text: too_big; count: invalid_type)`,
    );
    assert.equal(String(parsed.outcome.output).includes(CANARY), false);
    assert.equal(executed, 0);
  });

  it('refuses input the adapter could not parse, even for a schema of optional fields', () => {
    const optional = defineTool({
      name: 'search',
      description: 'Search.',
      input: z.object({ q: z.string().optional(), limit: z.number().optional() }),
      execute: () => 'ran',
    });
    for (const profile of ['anthropic-strict', 'openai-strict', 'loose'] as const) {
      const parsed = parseToolInput(optional, { INVALID_JSON: `{"q":"${CANARY}` }, profile);
      assert.equal(parsed.ok, false, profile);
      if (parsed.ok) continue;
      assert.equal(parsed.outcome.code, 'tool_input_invalid');
      assert.equal(parsed.outcome.output, `${TOOL_ERROR_TEXT.inputInvalid} ((root): invalid_json)`);
      assert.equal(String(parsed.outcome.output).includes(CANARY), false);
    }
    assert.deepEqual(parseToolInput(optional, {}, 'loose'), { ok: true, input: {} });
  });
});

describe('toolNeedsApproval', () => {
  it('evaluates booleans and predicates and fails closed on a throw', async () => {
    const make = (needsApproval: boolean | ((input: { amount: number }) => boolean)) =>
      defineTool({
        name: 'pay',
        description: 'Pay.',
        input: z.object({ amount: z.number() }),
        needsApproval,
        execute: () => 'paid',
      });
    assert.equal(await toolNeedsApproval(echo, { text: 'x' }, ctx()), false);
    assert.equal(await toolNeedsApproval(make(true), { amount: 1 }, ctx()), true);
    assert.equal(
      await toolNeedsApproval(
        make((input) => input.amount > 100),
        { amount: 5 },
        ctx(),
      ),
      false,
    );
    assert.equal(
      await toolNeedsApproval(
        make((input) => input.amount > 100),
        { amount: 500 },
        ctx(),
      ),
      true,
    );
    assert.equal(
      await toolNeedsApproval(
        make(() => {
          throw new Error(CANARY);
        }),
        { amount: 1 },
        ctx(),
      ),
      true,
    );
  });

  it('fails closed when the predicate stalls past the deadline or the run stops', async () => {
    let seenSignal: AbortSignal | undefined;
    const stalled = defineTool({
      name: 'stall',
      description: 'Stall.',
      input: z.object({}),
      timeoutMs: 20,
      needsApproval: (_input, context) => {
        seenSignal = context.signal;
        return new Promise<boolean>(() => undefined);
      },
      execute: () => 'ran',
    });
    assert.equal(await toolNeedsApproval(stalled, {}, ctx()), true);
    assert.equal(seenSignal?.aborted, true);

    const slow = defineTool({
      name: 'slow',
      description: 'Slow.',
      input: z.object({}),
      timeoutMs: 60_000,
      needsApproval: () => new Promise<boolean>(() => undefined),
      execute: () => 'ran',
    });
    const controller = new AbortController();
    const asked = toolNeedsApproval(slow, {}, ctx(controller.signal));
    controller.abort();
    assert.equal(await asked, true);
    assert.equal(await toolNeedsApproval(slow, {}, ctx(AbortSignal.abort())), true);
  });
});

describe('executeTool', () => {
  it('serializes a value result and passes the context through', async () => {
    let seen: AiToolContext | undefined;
    const tool = defineTool({
      name: 'lookup',
      description: 'd',
      input: z.object({ id: z.string() }),
      execute: (input, context) => {
        seen = context;
        return { id: input.id, total: 10n, at: new Date(0) };
      },
    });
    const outcome = await executeTool(tool, { id: 'a' }, ctx());
    assert.deepEqual(outcome, {
      output: '{"id":"a","total":"10","at":"1970-01-01T00:00:00.000Z"}',
      isError: false,
    });
    assert.equal(seen?.toolCallId, 'call_1');
    assert.deepEqual(seen?.actor, { kind: 'user', id: 'u1' });
    assert.equal(seen?.signal.aborted, false);
  });

  it('denies when authorize returns false or throws, without executing', async () => {
    let executed = 0;
    const make = (authorize: () => boolean) =>
      defineTool({
        name: 'del',
        description: 'd',
        input: z.object({}),
        authorize,
        execute: () => {
          executed += 1;
          return 'gone';
        },
      });
    assert.deepEqual(
      await executeTool(
        make(() => false),
        {},
        ctx(),
      ),
      {
        output: TOOL_ERROR_TEXT.notPermitted,
        isError: true,
        code: 'tool_denied',
      },
    );
    const thrown = await executeTool(
      make(() => {
        throw new Error(CANARY);
      }),
      {},
      ctx(),
    );
    assert.equal(thrown.code, 'tool_denied');
    assert.equal(executed, 0);
  });

  it('hides a thrown error and shows only an AiToolFailure public message', async () => {
    const hidden = defineTool({
      name: 'h',
      description: 'd',
      input: z.object({}),
      execute: () => {
        throw new Error(CANARY);
      },
    });
    const outcome = await executeTool(hidden, {}, ctx());
    assert.deepEqual(outcome, {
      output: TOOL_ERROR_TEXT.failed,
      isError: true,
      code: 'tool_failed',
    });
    const shown = defineTool({
      name: 's',
      description: 'd',
      input: z.object({}),
      execute: async () => {
        throw new AiToolFailure('the date must be in the future');
      },
    });
    assert.deepEqual(await executeTool(shown, {}, ctx()), {
      output: 'error: the date must be in the future',
      isError: true,
      code: 'tool_failed',
    });
    assert.equal(new AiToolFailure('x'.repeat(3000)).publicMessage.length, 2000);
  });

  it('validates the result against the output schema', async () => {
    const tool = defineTool({
      name: 'o',
      description: 'd',
      input: z.object({ ok: z.boolean() }),
      output: z.object({ status: z.literal('ok') }),
      execute: ({ ok }) =>
        ok ? { status: 'ok' as const } : ({ status: CANARY } as unknown as { status: 'ok' }),
    });
    assert.deepEqual(await executeTool(tool, { ok: true }, ctx()), {
      output: '{"status":"ok"}',
      isError: false,
    });
    assert.deepEqual(await executeTool(tool, { ok: false }, ctx()), {
      output: TOOL_ERROR_TEXT.outputInvalid,
      isError: true,
      code: 'tool_output_invalid',
    });
  });

  it('uses toModelOutput and rejects a malformed mapping or an unserializable value', async () => {
    const mapped = defineTool({
      name: 'm',
      description: 'd',
      input: z.object({}),
      execute: () => 42,
      toModelOutput: (value) => [{ type: 'text', text: `answer ${value}` }],
    });
    assert.deepEqual(await executeTool(mapped, {}, ctx()), {
      output: [{ type: 'text', text: 'answer 42' }],
      isError: false,
    });
    const broken = defineTool({
      name: 'b',
      description: 'd',
      input: z.object({}),
      execute: () => 1,
      toModelOutput: () => [{ type: 'video' }] as never,
    });
    assert.equal((await executeTool(broken, {}, ctx())).code, 'tool_output_invalid');
    const lossy = defineTool({
      name: 'l',
      description: 'd',
      input: z.object({}),
      execute: () => new Map([[CANARY, 1]]),
    });
    assert.equal((await executeTool(lossy, {}, ctx())).code, 'tool_output_invalid');
  });

  it('times out at the tool deadline and aborts the tool signal', async () => {
    let toolSignal: AbortSignal | undefined;
    const slow = defineTool({
      name: 'slow',
      description: 'd',
      input: z.object({}),
      timeoutMs: 20,
      execute: (_input, context) => {
        toolSignal = context.signal;
        return new Promise(() => undefined);
      },
    });
    assert.deepEqual(await executeTool(slow, {}, ctx()), {
      output: TOOL_ERROR_TEXT.timedOut,
      isError: true,
      code: 'tool_timed_out',
    });
    assert.equal(toolSignal?.aborted, true);
  });

  it('stops on run abort, mid-execution or before it starts', async () => {
    const controller = new AbortController();
    let toolSignal: AbortSignal | undefined;
    const waiting = defineTool({
      name: 'wait',
      description: 'd',
      input: z.object({}),
      execute: (_input, context) => {
        toolSignal = context.signal;
        setTimeout(() => controller.abort(), 5);
        return new Promise(() => undefined);
      },
    });
    assert.equal((await executeTool(waiting, {}, ctx(controller.signal))).code, 'aborted');
    assert.equal(toolSignal?.aborted, true);
    let executed = 0;
    const never = defineTool({
      name: 'n',
      description: 'd',
      input: z.object({}),
      execute: () => {
        executed += 1;
        return 1;
      },
    });
    assert.equal((await executeTool(never, {}, ctx(controller.signal))).code, 'aborted');
    assert.equal(executed, 0);
  });

  it('caps the result at the lower of the tool and run limits', async () => {
    const long = defineTool({
      name: 'long',
      description: 'd',
      input: z.object({}),
      maxResultChars: 50,
      execute: () => 'x'.repeat(200),
    });
    const capped = await executeTool(long, {}, ctx(), { maxResultChars: 1000 });
    assert.equal(typeof capped.output === 'string' && capped.output.length, 50);
    assert.ok(typeof capped.output === 'string' && capped.output.endsWith(TRUNCATION_MARKER));
    const byRun = await executeTool(long, {}, ctx(), { maxResultChars: 30 });
    assert.equal(typeof byRun.output === 'string' && byRun.output.length, 30);
  });
});

describe('authorizeToolCall', () => {
  it('allows, denies, fails closed on a throw, and honours the deadline and abort', async () => {
    const make = (authorize: () => boolean | Promise<boolean>, timeoutMs = 1000) =>
      defineTool({
        name: 'guarded',
        description: 'Guarded.',
        input: z.object({}),
        authorize,
        timeoutMs,
        execute: () => 'never',
      });
    assert.equal(
      await authorizeToolCall(
        make(() => true),
        {},
        ctx(),
      ),
      undefined,
    );
    const denied = await authorizeToolCall(
      make(() => false),
      {},
      ctx(),
    );
    assert.equal(denied?.code, 'tool_denied');
    assert.equal(denied?.output, TOOL_ERROR_TEXT.notPermitted);
    const thrown = await authorizeToolCall(
      make(() => {
        throw new Error(CANARY);
      }),
      {},
      ctx(),
    );
    assert.equal(thrown?.code, 'tool_denied');
    const slow = await authorizeToolCall(
      make(() => new Promise<boolean>(() => undefined), 10),
      {},
      ctx(),
    );
    assert.equal(slow?.code, 'tool_timed_out');
    const aborted = await authorizeToolCall(
      make(() => true),
      {},
      ctx(AbortSignal.abort()),
    );
    assert.equal(aborted?.code, 'aborted');
  });
});
