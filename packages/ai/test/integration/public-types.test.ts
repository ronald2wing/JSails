/**
 * Compile-time contracts of the public surface, checked by the build (an
 * unused `@ts-expect-error` is an error): tool input inferred from Zod and
 * from a structural data contract, tools typed over an app context that a
 * run must supply, and `providerOptions` typed per adapter through module
 * augmentation once that adapter's subpath is imported.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  defineTool,
  run,
  type AiActor,
  type AiProviderOptions,
  type AiRunOptions,
} from '../../src/index.js';
import type { AnthropicRequestOptions } from '../../src/anthropic/index.js';
import type { OpenAICompatibleRequestOptions } from '../../src/openai-compatible/index.js';
import { createFakeProvider } from '../../src/testing/index.js';

interface AppContext {
  readonly actor: AiActor;
  readonly tenantId: string;
}

describe('public types', () => {
  it('infers tool input from Zod and from a structural data contract', () => {
    const fromZod = defineTool({
      name: 'add',
      description: 'Add two numbers.',
      input: z.object({ a: z.number(), b: z.number().optional() }),
      execute: (input) => {
        const a: number = input.a;
        const b: number | undefined = input.b;
        // @ts-expect-error the input has no `c`
        void input.c;
        return a + (b ?? 0);
      },
    });
    const contract = {
      name: 'save_theme',
      description: 'Save the display theme.',
      schema: z.object({ theme: z.enum(['light', 'dark']) }),
    };
    const fromContract = defineTool({
      input: contract,
      execute: (input) => {
        const theme: 'light' | 'dark' = input.theme;
        // @ts-expect-error the theme is not any string
        const other: 'blue' = input.theme;
        void other;
        return theme;
      },
    });
    assert.equal(fromZod.name, 'add');
    assert.equal(fromContract.name, 'save_theme');
  });

  it('types a tool’s context as the app context, which the run must supply', () => {
    const scoped = defineTool<z.ZodObject<{ id: z.ZodString }>, string, AppContext>({
      name: 'find_record',
      description: 'Find a record in the current tenant.',
      input: z.object({ id: z.string() }),
      execute: ({ id }, ctx) => `${ctx.tenantId}:${ctx.toolCallId}:${id}`,
    });
    const model = createFakeProvider([{ text: 'ok' }]).model();
    const options: AiRunOptions<AppContext> = {
      model,
      input: 'Find r1.',
      tools: [scoped],
      context: { actor: { kind: 'user', id: 'u1' }, tenantId: 't1' },
    };
    const missingTenant = (): unknown =>
      run<AppContext>({
        model,
        input: 'Find r1.',
        tools: [scoped],
        // @ts-expect-error the app context needs its tenant
        context: { actor: { kind: 'user', id: 'u1' } },
      });
    const missingContext = (): unknown =>
      // @ts-expect-error a run that offers tools must say whose authority they run under
      run({ model, input: 'Find r1.', tools: [scoped] });
    assert.equal(typeof missingTenant, 'function');
    assert.equal(typeof missingContext, 'function');
    assert.equal(options.context?.tenantId, 't1');
  });

  it('types providerOptions per adapter', () => {
    const anthropic: AnthropicRequestOptions = { speed: 'fast', inferenceGeo: 'us' };
    const compatible: OpenAICompatibleRequestOptions = { temperature: 0.2, seed: 7 };
    const options: AiProviderOptions = { anthropic, openaiCompatible: compatible };
    // @ts-expect-error `slow` is not a speed
    const badSpeed: AiProviderOptions = { anthropic: { speed: 'slow' } };
    // @ts-expect-error temperature is a number
    const badTemperature: AiProviderOptions = { openaiCompatible: { temperature: 'hot' } };
    void badSpeed;
    void badTemperature;
    assert.equal(options.anthropic?.speed, 'fast');
  });
});
