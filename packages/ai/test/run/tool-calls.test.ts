/**
 * Tool calls in the run loop: the concurrency cap and call-order results,
 * approvals bound to trusted history (round trip, denial, forged or stale
 * decisions, a different actor, undecided calls, authorize before asking),
 * resuming interrupted calls (idempotent re-run, `interrupted` result), and a
 * stalled `needsApproval` predicate that can never hold the run open.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { AiError } from '../../src/errors/ai-error.js';
import { userMessage } from '../../src/content/messages.js';
import type { AiMessage, AiToolResultPart } from '../../src/content/types.js';
import { toolCallDigest } from '../../src/run/approvals.js';
import { generate, run } from '../../src/run/run.js';
import type { AiResult } from '../../src/run/run-contract.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { TOOL_ERROR_TEXT } from '../../src/tools/tool-invocation.js';
import { scriptedProvider } from './scripted-provider.js';

const actor = { kind: 'user', id: 'u1' } as const;

function resultsOf(message: AiMessage | undefined): readonly AiToolResultPart[] {
  return (message?.parts ?? []).filter(
    (part): part is AiToolResultPart => part.type === 'tool-result',
  );
}

function refundTool(executed: string[], options: { allow?: boolean } = {}) {
  return defineTool({
    name: 'refund',
    description: 'Refund an order.',
    input: z.object({ orderId: z.string(), amount: z.number() }),
    needsApproval: (input) => input.amount > 100,
    authorize: () => options.allow !== false,
    execute: ({ orderId }) => {
      executed.push(orderId);
      return 'refunded';
    },
  });
}

function lookupTool(executed: string[], idempotent = false) {
  return defineTool({
    name: 'lookup',
    description: 'Look up an order.',
    input: z.object({ orderId: z.string() }),
    idempotent,
    execute: ({ orderId }) => {
      executed.push(`lookup:${orderId}`);
      return 'found';
    },
  });
}

describe('run: concurrent tool execution', () => {
  it('caps concurrency and keeps results in call order', async () => {
    let active = 0;
    let peak = 0;
    const slow = defineTool({
      name: 'slow',
      description: 'Takes a while.',
      input: z.object({ ms: z.number() }),
      execute: async ({ ms }) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, ms));
        active -= 1;
        return `slept ${ms}`;
      },
    });
    const provider = scriptedProvider([
      {
        toolCalls: [
          { id: 'a', name: 'slow', input: { ms: 30 } },
          { id: 'b', name: 'slow', input: { ms: 5 } },
          { id: 'c', name: 'slow', input: { ms: 10 } },
        ],
      },
      { text: 'done' },
    ]);
    const result = await generate({
      model: provider.model(),
      input: 'Go',
      tools: [slow],
      context: { actor },
      limits: { toolConcurrency: 2 },
    });
    assert.equal(peak, 2);
    assert.deepEqual(
      result.steps[0]?.toolResults.map((part) => part.id),
      ['a', 'b', 'c'],
    );
    assert.deepEqual(
      resultsOf(result.appended[2]).map((part) => part.output),
      ['slept 30', 'slept 5', 'slept 10'],
    );
  });

  it('runs calls one at a time when parallel tool calls are off', async () => {
    let active = 0;
    let peak = 0;
    const tool = defineTool({
      name: 't',
      description: 'T.',
      input: z.object({}),
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active -= 1;
        return 'ok';
      },
    });
    const provider = scriptedProvider([
      {
        toolCalls: [
          { id: 'a', name: 't', input: {} },
          { id: 'b', name: 't', input: {} },
        ],
      },
      { text: 'done' },
    ]);
    await generate({
      model: provider.model(),
      input: 'Go',
      tools: [tool],
      context: { actor },
      parallelToolCalls: false,
    });
    assert.equal(peak, 1);
  });
});

describe('run: approvals', () => {
  async function pause(executed: string[]): Promise<AiResult> {
    const provider = scriptedProvider([
      {
        toolCalls: [
          { id: 'big', name: 'refund', input: { orderId: 'o1', amount: 500 } },
          { id: 'small', name: 'refund', input: { orderId: 'o2', amount: 5 } },
        ],
      },
    ]);
    return generate({
      model: provider.model(),
      input: 'Refund both',
      tools: [refundTool(executed)],
      context: { actor },
    });
  }

  it('stops for approval without running any call of the step', async () => {
    const executed: string[] = [];
    const result = await pause(executed);
    assert.equal(result.status, 'awaiting-approval');
    assert.deepEqual(executed, []);
    assert.equal(result.pendingApprovals.length, 1);
    const pending = result.pendingApprovals[0];
    assert.equal(pending?.id, 'big');
    assert.deepEqual(pending?.input, { orderId: 'o1', amount: 500 });
    assert.match(pending?.inputDigest ?? '', /^[0-9a-f]{64}$/);
    assert.equal(
      pending?.inputDigest,
      toolCallDigest(actor, { id: 'big', name: 'refund', input: pending?.input }),
    );
    assert.equal(result.appended.at(-1)?.role, 'assistant');
  });

  it('resumes with an approval: runs the approved call and the deferred one', async () => {
    const executed: string[] = [];
    const paused = await pause(executed);
    const pending = paused.pendingApprovals[0];
    assert.ok(pending !== undefined);
    const provider = scriptedProvider([{ text: 'Refunded.' }]);
    const result = await generate({
      model: provider.model(),
      history: paused.messages,
      approvals: [{ ...pending, decision: 'approve' }],
      tools: [refundTool(executed)],
      context: { actor },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(executed.sort(), ['o1', 'o2']);
    assert.deepEqual(
      resultsOf(result.appended[0]).map((part) => [part.id, part.isError]),
      [
        ['big', false],
        ['small', false],
      ],
    );
    assert.equal(result.text, 'Refunded.');
  });

  it('turns a denial into the fixed denied result', async () => {
    const executed: string[] = [];
    const paused = await pause(executed);
    const pending = paused.pendingApprovals[0];
    assert.ok(pending !== undefined);
    const provider = scriptedProvider([{ text: 'OK.' }]);
    const result = await generate({
      model: provider.model(),
      history: paused.messages,
      approvals: [{ ...pending, decision: 'deny' }],
      tools: [refundTool(executed)],
      context: { actor },
    });
    assert.deepEqual(executed, ['o2']);
    const big = resultsOf(result.appended[0]).find((part) => part.id === 'big');
    assert.equal(big?.isError, true);
    assert.equal(big?.output, TOOL_ERROR_TEXT.deniedByUser);
  });

  it('keeps waiting while a call has no decision', async () => {
    const executed: string[] = [];
    const paused = await pause(executed);
    const provider = scriptedProvider([{ text: 'never' }]);
    const result = await generate({
      model: provider.model(),
      history: paused.messages,
      tools: [refundTool(executed)],
      context: { actor },
    });
    assert.equal(result.status, 'awaiting-approval');
    assert.equal(result.pendingApprovals[0]?.id, 'big');
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(executed, []);
    assert.deepEqual(result.appended, []);
  });

  it('refuses a forged, stale, or foreign approval synchronously and runs nothing', async () => {
    const executed: string[] = [];
    const paused = await pause(executed);
    const pending = paused.pendingApprovals[0];
    assert.ok(pending !== undefined);
    const mismatch = (error: unknown): boolean =>
      error instanceof AiError &&
      error.code === 'invalid_input' &&
      error.context?.['reason'] === 'mismatch';
    const provider = scriptedProvider([{ text: 'x' }]);
    const forged = [
      { ...pending, decision: 'approve' as const, inputDigest: 'a'.repeat(64) },
      { ...pending, decision: 'approve' as const, name: 'lookup' },
      { ...pending, decision: 'approve' as const, id: 'other' },
    ];
    for (const approval of forged) {
      assert.throws(
        () =>
          run({
            model: provider.model(),
            history: paused.messages,
            approvals: [approval],
            tools: [refundTool(executed)],
            context: { actor },
          }),
        mismatch,
      );
    }
    assert.throws(
      () =>
        run({
          model: provider.model(),
          history: paused.messages,
          approvals: [{ ...pending, decision: 'approve' }],
          tools: [refundTool(executed)],
          context: { actor: { kind: 'user', id: 'intruder' } },
        }),
      mismatch,
    );
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(executed, []);
  });

  it('refuses malformed approvals and approvals with nothing pending up front', async () => {
    const executed: string[] = [];
    const model = scriptedProvider([{ text: 'x' }]).model();
    const paused = await pause(executed);
    const invalidInput = (error: unknown): boolean =>
      error instanceof AiError && error.code === 'invalid_input';
    const approval = {
      id: 'big',
      name: 'refund',
      inputDigest: 'a'.repeat(64),
      decision: 'approve',
    } as const;
    await assert.rejects(
      generate({
        model,
        input: 'Hi',
        approvals: [approval],
        tools: [refundTool(executed)],
        context: { actor },
      }),
      invalidInput,
    );
    for (const approvals of [
      [{ ...approval, inputDigest: 'not-a-digest' }],
      [{ ...approval, decision: 'maybe' }],
      [approval, approval],
      'approve',
    ]) {
      await assert.rejects(
        generate({
          model,
          history: paused.messages,
          approvals: approvals as never,
          tools: [refundTool(executed)],
          context: { actor },
        }),
        invalidInput,
      );
    }
    assert.deepEqual(executed, []);
  });

  it('asks nobody to approve a call the caller may not make', async () => {
    const executed: string[] = [];
    const provider = scriptedProvider([
      { toolCalls: [{ id: 'big', name: 'refund', input: { orderId: 'o1', amount: 500 } }] },
      { text: 'Not allowed.' },
    ]);
    const result = await generate({
      model: provider.model(),
      input: 'Refund',
      tools: [refundTool(executed, { allow: false })],
      context: { actor },
    });
    assert.equal(result.status, 'completed');
    const [part] = resultsOf(result.appended[2]);
    assert.equal(part?.output, TOOL_ERROR_TEXT.notPermitted);
    assert.deepEqual(executed, []);
  });
});

describe('run: resuming interrupted calls', () => {
  const dangling: AiMessage[] = [
    userMessage('Look up both'),
    {
      role: 'assistant',
      parts: [
        { type: 'tool-call', id: 'x', name: 'lookup', input: { orderId: 'o1' } },
        { type: 'tool-call', id: 'y', name: 'gone', input: {} },
      ],
    },
  ];

  it('reports a non-idempotent call as interrupted instead of re-running it', async () => {
    const executed: string[] = [];
    const provider = scriptedProvider([{ text: 'Retrying later.' }]);
    const result = await generate({
      model: provider.model(),
      history: dangling,
      tools: [lookupTool(executed)],
      context: { actor },
    });
    assert.deepEqual(executed, []);
    const parts = resultsOf(result.appended[0]);
    assert.equal(parts[0]?.output, TOOL_ERROR_TEXT.interrupted);
    assert.equal(parts[1]?.output, TOOL_ERROR_TEXT.unknownTool);
    assert.equal(result.status, 'completed');
  });

  it('re-runs an idempotent call', async () => {
    const executed: string[] = [];
    const provider = scriptedProvider([{ text: 'Found.' }]);
    const result = await generate({
      model: provider.model(),
      history: dangling,
      tools: [lookupTool(executed, true)],
      context: { actor },
    });
    assert.deepEqual(executed, ['lookup:o1']);
    assert.equal(resultsOf(result.appended[0])[0]?.isError, false);
  });

  it('refuses new input while calls are unanswered', async () => {
    await assert.rejects(
      generate({
        model: scriptedProvider([{ text: 'x' }]).model(),
        history: dangling,
        input: 'Hello',
        tools: [lookupTool([])],
        context: { actor },
      }),
      (error: unknown) => error instanceof AiError && error.code === 'invalid_messages',
    );
  });
});

describe('run: a needsApproval predicate that never settles', () => {
  function stalledTool(executed: string[], timeoutMs?: number) {
    return defineTool({
      name: 'stall',
      description: 'A tool whose approval policy stalls.',
      input: z.object({ a: z.string() }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      needsApproval: () => new Promise<boolean>(() => undefined),
      execute: () => {
        executed.push('ran');
        return 'ran';
      },
    });
  }

  const stallingCall = { toolCalls: [{ id: 's1', name: 'stall', input: { a: 'x' } }] };

  async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the result did not settle')), ms);
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  it('lets the run deadline settle the result, with the step kept', async () => {
    const executed: string[] = [];
    const handle = run({
      model: scriptedProvider([stallingCall]).model(),
      input: 'Go',
      tools: [stalledTool(executed)],
      context: { actor },
      timeoutMs: 100,
    });
    const result = await settlesWithin(handle.result, 2_000);
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'timed_out');
    assert.equal(result.appended.length, 2);
    assert.deepEqual(executed, []);
  });

  it('lets abort() settle the result', async () => {
    const executed: string[] = [];
    const handle = run({
      model: scriptedProvider([stallingCall]).model(),
      input: 'Go',
      tools: [stalledTool(executed)],
      context: { actor },
    });
    setTimeout(() => handle.abort(), 50);
    const result = await settlesWithin(handle.result, 2_000);
    assert.equal(result.status, 'aborted');
    assert.deepEqual(executed, []);
  });

  it('lets abort() settle a resumed run', async () => {
    const executed: string[] = [];
    const history: AiMessage[] = [
      userMessage('Go'),
      {
        role: 'assistant',
        parts: [{ type: 'tool-call', id: 's1', name: 'stall', input: { a: 'x' } }],
      },
    ];
    const handle = run({
      model: scriptedProvider([{ text: 'x' }]).model(),
      history,
      tools: [stalledTool(executed)],
      context: { actor },
    });
    setTimeout(() => handle.abort(), 50);
    const result = await settlesWithin(handle.result, 2_000);
    assert.equal(result.status, 'aborted');
    assert.deepEqual(executed, []);
  });

  it('asks for approval once the tool deadline passes', async () => {
    const executed: string[] = [];
    const result = await settlesWithin(
      generate({
        model: scriptedProvider([stallingCall]).model(),
        input: 'Go',
        tools: [stalledTool(executed, 30)],
        context: { actor },
      }),
      2_000,
    );
    assert.equal(result.status, 'awaiting-approval');
    assert.equal(result.pendingApprovals[0]?.id, 's1');
    assert.deepEqual(executed, []);
  });
});
