/**
 * `defineTool` tests: Zod and contract inputs, defaults, type inference,
 * strict-mode lowering checks at definition time, and invalid specs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { defineData } from 'jsails/data';

import { AiError } from '../../src/errors/ai-error.js';
import { AI_TOOL, defineTool, isAiTool } from '../../src/tools/define-tool.js';

function invalidTool(reason: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof AiError && error.code === 'invalid_tool' && error.context.reason === reason;
}

describe('defineTool', () => {
  it('defines a frozen, branded tool with defaults', () => {
    const tool = defineTool({
      name: 'weather',
      description: 'Current weather for a city.',
      input: z.object({ city: z.string() }),
      execute: ({ city }) => `sunny in ${city}`,
    });
    assert.equal(isAiTool(tool), true);
    assert.equal(isAiTool({ name: 'x' }), false);
    assert.ok(Object.isFrozen(tool));
    assert.ok(Object.isFrozen(tool[AI_TOOL]));
    assert.equal(tool.strict, true);
    assert.equal(tool.idempotent, false);
    assert.equal(tool.exposeToBrowser, false);
    assert.equal(tool.timeoutMs, 30_000);
    assert.equal(tool.maxResultChars, undefined);
    assert.equal(tool.maxResultMediaBytes, undefined);
    assert.equal(tool[AI_TOOL].inputJsonSchema.type, 'object');
  });

  it('takes name and description from a data contract and validates through its schema', () => {
    const CreateUser = defineData({
      name: 'CreateUser',
      description: 'Create a user account.',
      properties: { email: z.email(), name: z.string().min(1) },
    });
    const tool = defineTool({ input: CreateUser, execute: (input) => input.email });
    assert.equal(tool.name, 'CreateUser');
    assert.equal(tool.description, 'Create a user account.');
    assert.equal(tool[AI_TOOL].validateInput({ email: 'ada@example.com', name: 'Ada' }).ok, true);
    const check = tool[AI_TOOL].validateInput({ email: 'nope', name: '' });
    assert.equal(check.ok, false);
    assert.deepEqual(check.ok ? [] : check.issues.map((issue) => issue.path), ['email', 'name']);
    const renamed = defineTool({ name: 'create_user', input: CreateUser, execute: () => 'ok' });
    assert.equal(renamed.name, 'create_user');
  });

  it('accepts a structural contract that is not from jsails/data', () => {
    const tool = defineTool({
      input: { name: 'echo', description: 'Echo text.', schema: z.object({ text: z.string() }) },
      execute: ({ text }) => text,
    });
    assert.equal(tool.name, 'echo');
  });

  it('infers the input type and requires a name for a bare Zod input', () => {
    const tool = defineTool({
      name: 'add',
      description: 'Add two numbers.',
      input: z.object({ a: z.number(), b: z.number().default(1) }),
      execute: (input, ctx) => {
        const sum: number = input.a + input.b;
        const actorKind: 'user' | 'service' | 'anonymous' = ctx.actor.kind;
        return { sum, actorKind, call: ctx.toolCallId };
      },
    });
    assert.equal(tool.name, 'add');
    assert.throws(
      () =>
        // @ts-expect-error -- a bare Zod input needs a name and a description
        defineTool({ input: z.object({ a: z.number() }), execute: () => 1 }),
      invalidTool('name'),
    );
  });

  it('passes an app context through its type parameter', () => {
    interface AppContext {
      readonly actor: { readonly kind: 'user'; readonly id: string };
      readonly tenant: string;
    }
    const input = z.object({});
    const tool = defineTool<typeof input, string, AppContext>({
      name: 'tenant_echo',
      description: 'Echo the tenant.',
      input,
      execute: (_input, ctx) => `${ctx.tenant}:${ctx.actor.id}`,
    });
    assert.equal(tool.name, 'tenant_echo');
  });

  it('refuses a strict tool whose schema cannot be lowered, and allows it when not strict', () => {
    const input = z.object({ attributes: z.record(z.string(), z.string()) });
    assert.throws(
      () => defineTool({ name: 'tag', description: 'Tag.', input, execute: () => 1 }),
      invalidTool('open_object'),
    );
    const loose = defineTool({
      name: 'tag',
      description: 'Tag.',
      input,
      strict: false,
      execute: () => 1,
    });
    assert.equal(loose.strict, false);
  });

  it('refuses invalid specs with a static reason', () => {
    const input = z.object({ a: z.string() });
    const execute = (): string => 'x';
    const cases: readonly (readonly [() => unknown, string])[] = [
      [() => defineTool({ name: 'bad name', description: 'd', input, execute }), 'name'],
      [() => defineTool({ name: 'x'.repeat(65), description: 'd', input, execute }), 'name'],
      [() => defineTool({ name: 'ok', description: '  ', input, execute }), 'description'],
      [
        () =>
          defineTool({
            name: 'ok',
            description: 'd',
            input: {} as unknown as typeof input,
            execute,
          }),
        'input',
      ],
      [
        () => defineTool({ name: 'ok', description: 'd', input: z.string(), execute }),
        'input_not_object',
      ],
      [
        () =>
          defineTool({
            name: 'ok',
            description: 'd',
            input,
            execute: 'x' as unknown as typeof execute,
          }),
        'execute',
      ],
      [() => defineTool({ name: 'ok', description: 'd', input, execute, timeoutMs: 0 }), 'timeout'],
      [
        () => defineTool({ name: 'ok', description: 'd', input, execute, maxResultChars: 1.5 }),
        'max_result_chars',
      ],
      [
        () => defineTool({ name: 'ok', description: 'd', input, execute, maxResultMediaBytes: 0 }),
        'max_result_media_bytes',
      ],
      [
        () =>
          defineTool({
            name: 'ok',
            description: 'd',
            input: z.object({ INVALID_JSON: z.string().optional() }),
            execute,
          }),
        'reserved_property',
      ],
      [
        () =>
          defineTool({
            name: 'ok',
            description: 'd',
            input,
            execute,
            strict: 'yes' as unknown as boolean,
          }),
        'strict',
      ],
      [
        () =>
          defineTool({
            name: 'ok',
            description: 'd',
            input,
            execute,
            needsApproval: 1 as unknown as boolean,
          }),
        'needs_approval',
      ],
      [
        () =>
          defineTool({
            name: 'ok',
            description: 'd',
            input,
            execute,
            output: {} as unknown as z.ZodString,
          }),
        'output',
      ],
      [
        () =>
          defineTool({
            name: 'ok',
            description: 'd',
            input: z.object({ when: z.date() }),
            execute,
          }),
        'unrepresentable',
      ],
    ];
    for (const [make, reason] of cases) assert.throws(make, invalidTool(reason));
  });
});
