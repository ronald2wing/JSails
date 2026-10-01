/**
 * Stopping a run: abort during the provider stream, during a tool, and
 * between steps; the caller signal; the run deadline and the idle timeout;
 * the first stop reason winning; and no tool starting after a stop.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import type { AiToolResultPart } from '../../src/content/types.js';
import { createRunControl, stopError } from '../../src/run/run-control.js';
import { generate, run } from '../../src/run/run.js';
import type { AiRun } from '../../src/run/run-contract.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { TOOL_ERROR_TEXT } from '../../src/tools/tool-invocation.js';
import { scriptedProvider } from './scripted-provider.js';

const actor = { kind: 'user', id: 'u1' } as const;

describe('run: abort', () => {
  it('aborts during the provider stream and keeps the input', async () => {
    const provider = scriptedProvider([{ hang: true }]);
    const handle = run({ model: provider.model(), input: 'Go' });
    const result = handle.result;
    setTimeout(() => handle.abort(), 5);
    const settled = await result;
    assert.equal(settled.status, 'aborted');
    assert.equal(settled.error?.code, 'aborted');
    assert.equal(settled.appended.length, 1);
    assert.equal(provider.inits[0]?.signal.aborted, true);
  });

  it('honours the caller signal, including one aborted before the start', async () => {
    const controller = new AbortController();
    const provider = scriptedProvider([{ hang: true }]);
    const pending = generate({ model: provider.model(), input: 'Go', signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    assert.equal((await pending).status, 'aborted');

    const early = scriptedProvider([{ text: 'never' }]);
    const result = await generate({
      model: early.model(),
      input: 'Go',
      signal: AbortSignal.abort(),
    });
    assert.equal(result.status, 'aborted');
    assert.equal(early.requests.length, 0);
  });

  it('aborts a running tool, records its aborted result, and starts no other', async () => {
    const started: string[] = [];
    const toolSignals: AbortSignal[] = [];
    const tool = defineTool({
      name: 'wait',
      description: 'Waits.',
      input: z.object({ id: z.string() }),
      execute: (input, ctx) => {
        started.push(input.id);
        toolSignals.push(ctx.signal);
        return new Promise<string>(() => undefined);
      },
    });
    const provider = scriptedProvider([
      {
        toolCalls: [
          { id: 'a', name: 'wait', input: { id: 'a' } },
          { id: 'b', name: 'wait', input: { id: 'b' } },
        ],
      },
    ]);
    const handle = run({
      model: provider.model(),
      input: 'Go',
      tools: [tool],
      context: { actor },
      limits: { toolConcurrency: 1 },
    });
    const result = handle.result;
    setTimeout(() => handle.abort(), 10);
    const settled = await result;
    assert.equal(settled.status, 'aborted');
    assert.deepEqual(started, ['a']);
    assert.equal(toolSignals[0]?.aborted, true);
    const results = (settled.appended.at(-1)?.parts ?? []) as AiToolResultPart[];
    assert.deepEqual(
      results.map((part) => part.output),
      [TOOL_ERROR_TEXT.aborted, TOOL_ERROR_TEXT.aborted],
    );
    assert.equal(provider.requests.length, 1);
  });

  it('stops between steps when aborted in a checkpoint', async () => {
    const provider = scriptedProvider([
      { toolCalls: [{ id: 'a', name: 'noop', input: {} }] },
      { text: 'never' },
    ]);
    const executed: string[] = [];
    const noop = defineTool({
      name: 'noop',
      description: 'No-op.',
      input: z.object({}),
      execute: () => {
        executed.push('noop');
        return 'ok';
      },
    });
    const handle: AiRun = run({
      model: provider.model(),
      input: 'Go',
      tools: [noop],
      context: { actor },
      onToolResults: (): void => handle.abort(),
    });
    const result = await handle.result;
    assert.equal(result.status, 'aborted');
    assert.deepEqual(executed, ['noop']);
    assert.equal(provider.requests.length, 1);
    assert.equal(result.appended.length, 3);
  });
});

describe('run: timeouts', () => {
  it('fails with timed_out when the run deadline passes', async () => {
    const provider = scriptedProvider([{ hang: true }]);
    const result = await generate({ model: provider.model(), input: 'Go', timeoutMs: 15 });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'timed_out');
    assert.equal(result.error?.context.timeout, 'deadline');
  });

  it('fails with timed_out when the stream goes silent', async () => {
    const provider = scriptedProvider([{ text: 'abc', chunk: 1, delayMs: 40 }]);
    const result = await generate({ model: provider.model(), input: 'Go', idleTimeoutMs: 10 });
    assert.equal(result.error?.code, 'timed_out');
    assert.equal(result.error?.context.timeout, 'idle');
    assert.equal(provider.inits[0]?.signal.aborted, true);
  });

  it('does not count a paused consumer as an idle stream', async () => {
    const provider = scriptedProvider([{ text: 'abcdef', chunk: 1 }]);
    const handle = run({ model: provider.model(), input: 'Go', idleTimeoutMs: 10 });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (;;) {
      if ((await iterator.next()).done === true) break;
    }
    assert.equal((await handle.result).status, 'completed');
  });
});

describe('createRunControl', () => {
  it('keeps the first stop reason', () => {
    const control = createRunControl(0, undefined);
    control.start();
    control.stop('idle');
    control.stop('aborted');
    assert.equal(control.stopReason(), 'idle');
    assert.equal(control.signal.aborted, true);
    control.dispose();
    assert.equal(stopError('aborted').code, 'aborted');
    assert.equal(stopError('deadline').code, 'timed_out');
  });

  it('detaches from the caller signal when disposed', () => {
    const external = new AbortController();
    const control = createRunControl(0, external.signal);
    control.start();
    control.dispose();
    external.abort();
    assert.equal(control.stopReason(), undefined);
  });
});
