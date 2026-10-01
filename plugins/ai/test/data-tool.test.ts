import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { AiError } from '../src/contracts.js';
import { aiTool } from '../src/data-tool.js';
import { defineData } from 'jsails/data';

const CreateUser = defineData({
  name: 'CreateUser',
  description: 'Create a user account.',
  properties: {
    email: z.email().describe('The account email address.'),
    name: z.string().min(1).max(120).describe('The display name.'),
  },
});

describe('aiTool', () => {
  it('projects data metadata and input JSON Schema to an AiTool', async () => {
    const seen: unknown[] = [];
    const tool = aiTool(CreateUser, {
      call: (input) => {
        seen.push(input);
        return { ok: true };
      },
    });

    assert.equal(tool.name, 'CreateUser');
    assert.equal(tool.description, 'Create a user account.');
    assert.equal(tool.parameters?.type, 'object');
    const properties = tool.parameters?.properties as Record<string, Record<string, unknown>>;
    assert.equal(properties.email?.format, 'email');
    assert.equal(properties.email?.description, 'The account email address.');
    assert.equal(properties.name?.minLength, 1);
    assert.deepEqual(tool.parameters?.required, ['email', 'name']);

    await tool.call({ email: 'ada@example.com', name: 'Ada' });
    assert.deepEqual(seen, [{ email: 'ada@example.com', name: 'Ada' }]);
  });

  it('validates model arguments through the same schema', async () => {
    const tool = aiTool(CreateUser, { call: () => 'ok' });
    await assert.rejects(
      async () => tool.call({ email: 'not-an-email', name: '' }),
      (error: unknown) => {
        assert.ok(error instanceof AiError);
        assert.equal(error.code, 'invalid_tool_arguments');
        assert.equal(error.message.includes('not-an-email'), false);
        return true;
      },
    );
  });

  it('validates an optional return contract', async () => {
    const Result = defineData({
      name: 'Result',
      description: 'A result.',
      properties: { ok: z.boolean() },
    });
    const tool = aiTool(CreateUser, {
      call: () => ({ ok: true }),
      returns: Result,
    });
    assert.deepEqual(await tool.call({ email: 'ada@example.com', name: 'Ada' }), { ok: true });

    const invalid = aiTool(CreateUser, {
      call: () => ({ ok: 'yes' }),
      returns: Result,
    });
    await assert.rejects(
      async () => invalid.call({ email: 'ada@example.com', name: 'Ada' }),
      (error: unknown) => {
        assert.ok(error instanceof AiError);
        assert.equal(error.code, 'invalid_tool_result');
        assert.equal(error.message.includes('yes'), false);
        return true;
      },
    );
  });

  it('allows name and description overrides', () => {
    const tool = aiTool(CreateUser, {
      name: 'create_user',
      description: 'Override.',
      call: () => 'ok',
    });
    assert.equal(tool.name, 'create_user');
    assert.equal(tool.description, 'Override.');
  });

  it('rejects invalid tool metadata and schemas', () => {
    assert.throws(() => aiTool(CreateUser, { name: 'bad name', call: () => 'ok' }));
    assert.throws(() => aiTool(CreateUser, { call: () => 'ok', description: '' }));
    assert.throws(() =>
      aiTool(CreateUser, {
        call: () => 'ok',
        returns: {} as never,
      }),
    );

    const withDate = defineData({
      name: 'WithDate',
      description: 'Date.',
      properties: { at: z.date() },
    });
    assert.throws(() => aiTool(withDate, { call: () => 'ok' }));

    const withAnySchema = aiTool(withDate, {
      call: () => 'ok',
      jsonSchema: { unrepresentable: 'any' },
    });
    assert.deepEqual((withAnySchema.parameters?.properties as Record<string, unknown>).at, {});
  });
});
