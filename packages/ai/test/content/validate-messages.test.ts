/**
 * `validateMessages` tests: one table row per transcript rule, the request vs
 * transcript modes, normalization and freezing, and the value-free canary.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import { validateMessages, type MessageRule } from '../../src/content/validate-messages.js';

const CANARY = 'CANARY-7f3a-secret';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const user = (text = 'hello'): unknown => ({ role: 'user', parts: [{ type: 'text', text }] });
const assistant = (text = 'hi'): unknown => ({
  role: 'assistant',
  parts: [{ type: 'text', text }],
});
const call = (id: string, name = 'lookup'): unknown => ({
  role: 'assistant',
  parts: [{ type: 'tool-call', id, name, input: { q: 1 } }],
});
const result = (id: string, name = 'lookup'): Record<string, unknown> => ({
  type: 'tool-result',
  id,
  name,
  output: 'ok',
  isError: false,
});

function rejects(value: unknown, rule: MessageRule, mode?: 'request' | 'transcript'): void {
  assert.throws(
    () => validateMessages(value, mode === undefined ? {} : { mode }),
    (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, 'invalid_messages');
      assert.equal(error.context.rule, rule);
      assert.equal(error.message.includes(CANARY), false);
      assert.equal(JSON.stringify(error.context).includes(CANARY), false);
      return true;
    },
  );
}

describe('validateMessages', () => {
  it('accepts a full tool round trip and returns frozen normalized copies', () => {
    const input = [
      { role: 'user', parts: [{ type: 'text', text: 'weather?', cache: true }], extra: 1 },
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '' },
          { type: 'text', text: 'Let me check.' },
          { type: 'tool-call', id: 't1', name: 'weather', input: { city: 'Oslo' } },
          { type: 'tool-call', id: 't2', name: 'time', input: {} },
        ],
        native: {
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          content: [{ type: 'thinking' }],
        },
        meta: { provider: 'anthropic', finishReason: 'tool-calls', unknown: true },
      },
      {
        role: 'user',
        parts: [result('t1', 'weather'), result('t2', 'time'), { type: 'text', text: 'thanks' }],
      },
      assistant('Sunny.'),
      user('and tomorrow?'),
      { role: 'system', parts: [{ type: 'text', text: 'Be brief.' }] },
    ];
    const messages = validateMessages(input);
    assert.equal(messages.length, 6);
    assert.ok(Object.isFrozen(messages));
    assert.ok(Object.isFrozen(messages[1]));
    assert.ok(Object.isFrozen(messages[1]?.parts));
    assert.equal('extra' in (messages[0] as object), false);
    assert.deepEqual(messages[1]?.meta, { provider: 'anthropic', finishReason: 'tool-calls' });
    const toolCall = messages[1]?.parts[2];
    assert.ok(toolCall?.type === 'tool-call');
    assert.ok(Object.isFrozen(toolCall.input));
    assert.notEqual(toolCall.input, (input[1] as { parts: { input?: unknown }[] }).parts[2]?.input);
  });

  it('accepts images and files with matching media types', () => {
    const messages = validateMessages([
      {
        role: 'user',
        parts: [
          { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: PNG } },
          { type: 'image', source: { kind: 'url', url: 'https://example.com/a.png' } },
          {
            type: 'file',
            mediaType: 'text/plain',
            title: 'notes',
            source: { kind: 'base64', mediaType: 'text/plain', data: 'aGVsbG8=' },
          },
          { type: 'text', text: 'describe' },
        ],
      },
    ]);
    assert.equal(messages[0]?.parts.length, 4);
  });

  const table: readonly (readonly [string, unknown, MessageRule, ('request' | 'transcript')?])[] = [
    ['a non-array', { role: 'user' }, 'not_array'],
    ['an empty request', [], 'empty'],
    ['a non-object message', ['hi'], 'not_object'],
    ['an unknown role', [{ role: 'tool', parts: [] }], 'role'],
    ['parts that are not an array', [{ role: 'user', parts: CANARY }], 'parts'],
    ['an empty message', [{ role: 'user', parts: [] }], 'empty_message'],
    ['an unknown part type', [{ role: 'user', parts: [{ type: 'audio' }] }], 'part_type'],
    [
      'a tool call in a user message',
      [{ role: 'user', parts: [{ type: 'tool-call', id: 'x', name: 'y', input: {} }] }],
      'part_role',
    ],
    [
      'reasoning in a system message',
      [user(), { role: 'system', parts: [{ type: 'reasoning', text: '' }] }],
      'part_role',
    ],
    ['whitespace-only user text', [user('   ')], 'text'],
    ['non-string text', [{ role: 'user', parts: [{ type: 'text', text: 5 }] }], 'text'],
    [
      'a bad base64 payload',
      [
        {
          role: 'user',
          parts: [
            {
              type: 'image',
              source: { kind: 'base64', mediaType: 'image/png', data: `${CANARY}!` },
            },
          ],
        },
      ],
      'media_source',
    ],
    [
      'a disallowed image media type',
      [
        {
          role: 'user',
          parts: [
            { type: 'image', source: { kind: 'base64', mediaType: 'image/tiff', data: PNG } },
          ],
        },
      ],
      'media_type',
    ],
    [
      'a non-http URL',
      [
        {
          role: 'user',
          parts: [{ type: 'image', source: { kind: 'url', url: `file:///${CANARY}` } }],
        },
      ],
      'media_source',
    ],
    [
      'a file whose source type differs from the part',
      [
        {
          role: 'user',
          parts: [
            {
              type: 'file',
              mediaType: 'application/pdf',
              source: { kind: 'base64', mediaType: 'text/plain', data: 'aGVsbG8=' },
            },
          ],
        },
      ],
      'media_type',
    ],
    [
      'an overlong file title',
      [
        {
          role: 'user',
          parts: [
            {
              type: 'file',
              mediaType: 'text/plain',
              title: 'x'.repeat(513),
              source: { kind: 'base64', mediaType: 'text/plain', data: 'aGVsbG8=' },
            },
          ],
        },
      ],
      'title',
    ],
    [
      'a cache flag that is not true',
      [{ role: 'user', parts: [{ type: 'text', text: 'a', cache: false }] }],
      'cache',
    ],
    [
      'a tool call with non-JSON input',
      [
        user(),
        {
          role: 'assistant',
          parts: [{ type: 'tool-call', id: 'a', name: 'b', input: { n: Number.NaN } }],
        },
        user(),
      ],
      'tool_call',
    ],
    [
      'a tool result without isError',
      [
        user(),
        call('a'),
        { role: 'user', parts: [{ type: 'tool-result', id: 'a', name: 'lookup', output: 'x' }] },
      ],
      'tool_result',
    ],
    [
      'native content on a user message',
      [{ ...(user() as object), native: { provider: 'p', model: 'm', content: [] } }],
      'native',
    ],
    [
      'native content that is not an array',
      [
        user(),
        { ...(assistant() as object), native: { provider: 'p', model: 'm', content: {} } },
        user(),
      ],
      'native',
    ],
    [
      'a bad finish reason',
      [user(), { ...(assistant() as object), meta: { finishReason: CANARY } }, user()],
      'meta',
    ],
    [
      'usage with cache above input',
      [
        user(),
        {
          ...(assistant() as object),
          meta: {
            usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 2, cacheWriteTokens: 0 },
          },
        },
        user(),
      ],
      'meta',
    ],
    ['an assistant first message', [assistant(), user()], 'first_message'],
    [
      'a system first message',
      [{ role: 'system', parts: [{ type: 'text', text: 'x' }] }],
      'first_message',
    ],
    ['assistant prefill', [user(), assistant()], 'trailing_assistant'],
    ['pending tool calls in a request', [user(), call('a')], 'trailing_assistant'],
    [
      'a system message after an assistant message',
      [user(), assistant(), { role: 'system', parts: [{ type: 'text', text: 'x' }] }],
      'system_placement',
    ],
    [
      'a system message followed by a user message',
      [user(), { role: 'system', parts: [{ type: 'text', text: 'x' }] }, user()],
      'system_placement',
    ],
    [
      'text before tool results',
      [user(), call('a'), { role: 'user', parts: [{ type: 'text', text: 'x' }, result('a')] }],
      'tool_result_order',
    ],
    [
      'a result with no call',
      [user(), assistant(), { role: 'user', parts: [result('zz')] }],
      'tool_result_unmatched',
    ],
    [
      'a result for a call two messages back',
      [
        user(),
        call('a'),
        { role: 'user', parts: [result('a')] },
        assistant(),
        { role: 'user', parts: [result('a')] },
      ],
      'duplicate_tool_result_id',
    ],
    ['a call left unanswered', [user(), call('a'), user()], 'tool_result_missing'],
    [
      'a result with the wrong name',
      [user(), call('a'), { role: 'user', parts: [result('a', 'other')] }],
      'tool_result_name',
    ],
    [
      'a reused tool call id across the conversation',
      [
        user(),
        call('a'),
        { role: 'user', parts: [result('a')] },
        call('a'),
        { role: 'user', parts: [{ ...result('a'), id: 'a' }] },
      ],
      'duplicate_tool_call_id',
    ],
    [
      'a call followed by an assistant message',
      [user(), call('a'), assistant()],
      'dangling_tool_call',
      'transcript',
    ],
  ];

  for (const [name, value, rule, mode] of table) {
    it(`rejects ${name} (${rule})`, () => rejects(value, rule, mode));
  }

  it('allows an empty transcript and a trailing assistant or pending calls in transcript mode', () => {
    assert.deepEqual(validateMessages([], { mode: 'transcript' }), []);
    assert.equal(validateMessages([user(), assistant()], { mode: 'transcript' }).length, 2);
    assert.equal(validateMessages([user(), call('a')], { mode: 'transcript' }).length, 2);
  });

  it('allows a trailing system message after a user message', () => {
    const messages = validateMessages([
      user(),
      { role: 'system', parts: [{ type: 'text', text: 'x' }] },
    ]);
    assert.equal(messages.at(-1)?.role, 'system');
  });

  it('allows whitespace-only assistant text and an assistant with only native content', () => {
    const messages = validateMessages([
      user(),
      { role: 'assistant', parts: [{ type: 'text', text: '\n' }] },
      user(),
      {
        role: 'assistant',
        parts: [],
        native: { provider: 'p', model: 'm', content: [{ type: 'x' }] },
      },
      user(),
    ]);
    assert.equal(messages.length, 5);
  });
});
