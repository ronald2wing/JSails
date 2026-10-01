/**
 * Seeded property test over random scripted runs: the transcript stays valid
 * with every tool call answered in the next message, history only grows
 * (every checkpoint is a prefix of the next and of the result), total usage
 * equals the sum of the steps, provider calls never exceed `maxSteps`, and
 * the event stream ends with exactly one `finish`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { addUsage, ZERO_USAGE } from '../../src/usage/usage.js';
import { toolCallsOf, validateMessages } from '../../src/content/validate-messages.js';
import type { AiMessage } from '../../src/content/types.js';
import { run } from '../../src/run/run.js';
import type { AiRunEvent } from '../../src/run/run-contract.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { AiToolFailure } from '../../src/tools/tool-failure.js';
import { scriptedProvider, type Turn } from './scripted-provider.js';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tools = [
  defineTool({
    name: 'ok',
    description: 'Succeeds.',
    input: z.object({ n: z.number() }),
    execute: ({ n }) => n * 2,
  }),
  defineTool({
    name: 'fail',
    description: 'Fails.',
    input: z.object({}),
    execute: () => {
      throw new AiToolFailure('nope');
    },
  }),
];

function isPrefix(prefix: readonly AiMessage[], whole: readonly AiMessage[]): boolean {
  return (
    prefix.length <= whole.length && prefix.every((message, index) => message === whole[index])
  );
}

describe('run invariants (seeded)', () => {
  it('hold over 200 random runs', async () => {
    const random = mulberry32(0x5eed);
    for (let trial = 0; trial < 200; trial += 1) {
      let ids = 0;
      const maxSteps = 1 + Math.floor(random() * 5);
      const provider = scriptedProvider((): Turn => {
        const roll = random();
        const usage = {
          inputTokens: 10 + Math.floor(random() * 100),
          outputTokens: Math.floor(random() * 50),
        };
        if (roll < 0.3) return { text: 'final', usage };
        if (roll < 0.35) return { text: 'cut', finishReason: 'length', usage };
        const count = 1 + Math.floor(random() * 3);
        const toolCalls = Array.from({ length: count }, () => {
          ids += 1;
          const pick = random();
          const name = pick < 0.5 ? 'ok' : pick < 0.75 ? 'fail' : pick < 0.9 ? 'missing' : 'ok';
          const input = pick >= 0.9 ? { n: 'bad' } : name === 'ok' ? { n: ids } : {};
          return { id: `t${trial}_${ids}`, name, input };
        });
        return {
          toolCalls,
          usage,
          ...(random() < 0.05 ? { finishReason: 'length' as const } : {}),
        };
      });
      const checkpoints: (readonly AiMessage[])[] = [];
      const handle = run({
        model: provider.model(),
        input: `trial ${trial}`,
        tools,
        context: { actor: { kind: 'service', id: 'prop' } },
        limits: { maxSteps },
        onStepFinish: (checkpoint) => {
          checkpoints.push(checkpoint.messages);
        },
        onToolResults: (checkpoint) => {
          checkpoints.push(checkpoint.messages);
        },
      });
      const events: AiRunEvent[] = [];
      for await (const event of handle) events.push(event);
      const result = await handle.result;

      assert.doesNotThrow(() => validateMessages(result.messages, { mode: 'transcript' }));
      const last = result.messages.at(-1);
      if (last?.role === 'assistant') assert.equal(toolCallsOf(last).length, 0);
      for (let index = 1; index < checkpoints.length; index += 1) {
        assert.ok(isPrefix(checkpoints[index - 1] ?? [], checkpoints[index] ?? []));
      }
      for (const checkpoint of checkpoints) assert.ok(isPrefix(checkpoint, result.messages));
      const summed = result.steps.reduce((total, step) => addUsage(total, step.usage), ZERO_USAGE);
      assert.deepEqual(result.usage, summed);
      assert.ok(provider.requests.length <= maxSteps);
      assert.equal(
        events.filter((event) => event.type === 'step-start').length,
        provider.requests.length,
      );
      assert.equal(events.at(-1)?.type, 'finish');
      assert.equal(events.filter((event) => event.type === 'finish').length, 1);
      assert.ok(['completed', 'failed'].includes(result.status));
    }
  });
});
