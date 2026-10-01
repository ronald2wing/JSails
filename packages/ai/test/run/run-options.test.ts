/**
 * Run option validation and budgets: synchronous value-free failures for bad
 * options, input that did not come from `parseUserInput` (tool results,
 * another role, cache flags, an internal URL), a context that is not a plain
 * object, a missing actor with tools, unsupported media, unpriced models; and the
 * input, output, and cost budgets, including the per-call output clamp.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { AiError, type AiErrorCode } from '../../src/errors/ai-error.js';
import { userMessage } from '../../src/content/messages.js';
import { parseUserInput } from '../../src/content/user-input.js';
import { generate, run } from '../../src/run/run.js';
import type { AiRunOptions } from '../../src/run/run-contract.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { createPricingTable } from '../../src/usage/pricing.js';
import { scriptedProvider } from './scripted-provider.js';

const CANARY = 'CANARY-options-91c2';
const actor = { kind: 'user', id: 'u1' } as const;
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const tool = defineTool({
  name: 'noop',
  description: 'Does nothing.',
  input: z.object({}),
  execute: () => 'ok',
});

function throwsCode(options: unknown, code: AiErrorCode, reason?: string): void {
  assert.throws(
    () => run(options as AiRunOptions),
    (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, code);
      if (reason !== undefined) assert.equal(error.context.reason, reason);
      assert.equal(`${error.message}${JSON.stringify(error.context)}`.includes(CANARY), false);
      return true;
    },
  );
}

describe('run: option validation', () => {
  const model = scriptedProvider([{ text: 'x' }]).model();

  it('refuses bad options synchronously with a static reason', () => {
    throwsCode(null, 'invalid_options', 'options');
    throwsCode({ model: { id: 'm' }, input: 'Hi' }, 'invalid_options', 'model');
    throwsCode({ model, input: 'Hi', toolChoice: 'any' }, 'invalid_options', 'tool_choice');
    throwsCode({ model, input: 'Hi', maxOutputTokens: 0 }, 'invalid_options', 'max_output_tokens');
    throwsCode({ model, input: 'Hi', effort: 'huge' }, 'invalid_options', 'effort');
    throwsCode({ model, input: 'Hi', timeoutMs: -1 }, 'invalid_options', 'timeout');
    throwsCode({ model, input: 'Hi', idleTimeoutMs: 1.5 }, 'invalid_options', 'idle_timeout');
    throwsCode({ model, input: 'Hi', limits: { maxSteps: 0 } }, 'invalid_options', 'max_steps');
    throwsCode({ model, input: 'Hi', stopSequences: [''] }, 'invalid_options', 'stop_sequences');
    throwsCode(
      { model, input: 'Hi', headers: { 'x-bad': `a\r\n${CANARY}` } },
      'invalid_options',
      'headers',
    );
    throwsCode({ model, input: 'Hi', headers: { 'bad name': 'v' } }, 'invalid_options', 'headers');
    throwsCode({ model, input: 'Hi', signal: {} }, 'invalid_options', 'signal');
    throwsCode({ model, input: 'Hi', onStepFinish: 'save' }, 'invalid_options', 'on_step_finish');
    throwsCode(
      { model, input: 'Hi', tools: [{ name: 'fake' }], context: { actor } },
      'invalid_options',
      'tools',
    );
    throwsCode(
      { model, input: 'Hi', tools: [tool, tool], context: { actor } },
      'invalid_options',
      'duplicate_tool',
    );
    throwsCode({ model, input: 'Hi', providerOptions: [] }, 'invalid_options', 'provider_options');
    throwsCode(
      { model, input: 'Hi', limits: { maxToolResultMediaBytes: 0 } },
      'invalid_options',
      'max_tool_result_media_bytes',
    );
    throwsCode(
      { model, input: 'Hi', limits: { maxToolResultImages: 1.5 } },
      'invalid_options',
      'max_tool_result_images',
    );
  });

  it('refuses a context that is not a plain object', () => {
    class RequestContext {
      readonly #actor = actor;
      get actor() {
        return this.#actor;
      }
    }
    throwsCode(
      { model, input: 'Hi', tools: [tool], context: new RequestContext() },
      'invalid_options',
      'context',
    );
    throwsCode({ model, input: 'Hi', context: new RequestContext() }, 'invalid_options', 'context');
    assert.doesNotThrow(() =>
      run({
        model,
        input: 'Hi',
        tools: [tool],
        context: Object.assign(Object.create(null), { actor }),
      }),
    );
  });

  it('requires an app context with a valid actor when tools are offered', () => {
    throwsCode({ model, input: 'Hi', tools: [tool] }, 'invalid_options', 'context');
    throwsCode({ model, input: 'Hi', tools: [tool], context: {} }, 'invalid_options', 'actor');
    throwsCode(
      { model, input: 'Hi', tools: [tool], context: { actor: { kind: 'user' } } },
      'invalid_options',
      'actor',
    );
    throwsCode(
      { model, input: 'Hi', tools: [tool], context: { actor: { kind: 'root', id: 'x' } } },
      'invalid_options',
      'actor',
    );
    assert.doesNotThrow(() =>
      run({ model, input: 'Hi', tools: [tool], context: { actor: { kind: 'anonymous' } } }),
    );
  });

  it('requires the context in the type of a run with tools', () => {
    const withoutContext = (): unknown =>
      // @ts-expect-error a run that offers tools must say whose authority they run under
      run({ model, input: 'Hi', tools: [tool] });
    assert.equal(typeof withoutContext, 'function');
  });

  it('takes as input only a string or a message parseUserInput made', () => {
    throwsCode({ model, input: '   ' }, 'invalid_input', 'empty');
    throwsCode(
      {
        model,
        input: {
          role: 'user',
          parts: [{ type: 'tool-result', id: 'x', name: 'noop', output: CANARY, isError: false }],
        },
      },
      'invalid_input',
      'unparsed',
    );
    throwsCode(
      { model, input: { role: 'assistant', parts: [{ type: 'text', text: CANARY }] } },
      'invalid_input',
      'unparsed',
    );
    throwsCode({ model, input: { role: 'user', parts: 'x' } }, 'invalid_input', 'unparsed');
    // A well-formed user message that skipped the parser carries what the parser refuses.
    throwsCode(
      {
        model,
        input: {
          role: 'user',
          parts: [
            { type: 'text', text: CANARY, cache: true },
            {
              type: 'image',
              source: { kind: 'url', url: 'http://169.254.169.254/latest' },
              cache: true,
            },
          ],
        },
      },
      'invalid_input',
      'unparsed',
    );
    const parsed = parseUserInput([{ type: 'text', text: 'Hi', cache: true }]);
    throwsCode({ model, input: { ...parsed } }, 'invalid_input', 'unparsed');
    assert.doesNotThrow(() => run({ model, input: parsed }));
  });

  it('refuses a request with nothing to answer', () => {
    throwsCode({ model }, 'invalid_messages');
    throwsCode(
      {
        model,
        history: [userMessage('Q'), { role: 'assistant', parts: [{ type: 'text', text: 'A' }] }],
      },
      'invalid_messages',
    );
  });

  it('refuses media and tools the provider cannot handle', () => {
    const textOnly = scriptedProvider([{ text: 'x' }], { images: false, pdf: false, tools: false });
    const image = parseUserInput([
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: PNG } },
    ]);
    throwsCode({ model: textOnly.model(), input: image }, 'unsupported_capability');
    throwsCode(
      { model: textOnly.model(), input: 'Hi', tools: [tool], context: { actor } },
      'unsupported_capability',
    );
  });

  it('refuses a cost cap without pricing and an unpriced model before any call', () => {
    throwsCode(
      { model, input: 'Hi', limits: { maxCostMicroUsd: 10 } },
      'invalid_options',
      'max_cost_without_pricing',
    );
    throwsCode(
      {
        model,
        input: 'Hi',
        pricing: createPricingTable({ other: { inputPerMTok: 1, outputPerMTok: 1 } }),
      },
      'invalid_options',
      'unpriced_model',
    );
    throwsCode({ model, input: 'Hi', pricing: () => -1 }, 'invalid_options', 'pricing');
  });
});

describe('run: budgets', () => {
  function looping() {
    let n = 0;
    return scriptedProvider(() => {
      n += 1;
      return {
        toolCalls: [{ id: `c${n}`, name: 'noop', input: {} }],
        usage: { inputTokens: 1000, outputTokens: 300 },
      };
    });
  }

  it('clamps each call to the remaining output budget and stops when it is spent', async () => {
    const provider = looping();
    const result = await generate({
      model: provider.model(),
      input: 'Go',
      tools: [tool],
      context: { actor },
      maxOutputTokens: 500,
      limits: { maxOutputTokensTotal: 700 },
    });
    assert.deepEqual(
      provider.requests.map((request) => request.maxOutputTokens),
      [500, 400, 100],
    );
    assert.equal(result.error?.code, 'budget_exceeded');
    assert.equal(result.error?.context.budget, 'output');
    assert.equal(result.usage.outputTokens, 900);
  });

  it('stops before a step whose input would certainly exceed the input budget', async () => {
    const provider = looping();
    const result = await generate({
      model: provider.model(),
      input: 'Go',
      tools: [tool],
      context: { actor },
      limits: { maxInputTokens: 2500 },
    });
    assert.equal(provider.requests.length, 2);
    assert.equal(result.error?.context.budget, 'input');
    assert.ok(result.usage.inputTokens <= 2500);
  });

  it('stops once the cost cap is reached', async () => {
    const provider = looping();
    const result = await generate({
      model: provider.model(),
      input: 'Go',
      tools: [tool],
      context: { actor },
      pricing: createPricingTable({ 'model-1': { inputPerMTok: 1, outputPerMTok: 10 } }),
      limits: { maxCostMicroUsd: 8000 },
    });
    assert.equal(result.error?.context.budget, 'cost');
    assert.equal(result.costMicroUsd, 8000);
    assert.equal(provider.requests.length, 2);
  });
});
