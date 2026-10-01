/**
 * Conversation codec tests: creation, append-only growth (with a seeded
 * property test that every append preserves the prefix), the JSON round trip,
 * and value-free rejection of malformed persisted data.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import type { AiMessage } from '../../src/content/types.js';
import {
  appendToConversation,
  createConversation,
  parseConversation,
  type Conversation,
} from '../../src/conversation/conversation.js';

const CANARY = 'CANARY-conversation';
const usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 };
const user = (text: string): AiMessage => ({ role: 'user', parts: [{ type: 'text', text }] });
const assistant = (text: string): AiMessage => ({
  role: 'assistant',
  parts: [{ type: 'text', text }],
});

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

describe('createConversation', () => {
  it('starts empty at revision 0 with the owner id', () => {
    const conversation = createConversation({ id: 'c1', owner: { kind: 'user', id: 'u1' } });
    assert.deepEqual(conversation, {
      v: 1,
      id: 'c1',
      ownerId: 'u1',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      revision: 0,
    });
    assert.ok(Object.isFrozen(conversation));
    assert.equal(createConversation({ owner: { kind: 'anonymous' } }).ownerId, null);
    assert.match(createConversation({ owner: { kind: 'anonymous' } }).id, /^[0-9a-f-]{36}$/);
  });

  it('requires an id for a user or service owner', () => {
    assert.throws(() => createConversation({ owner: { kind: 'user' } }), AiError);
    assert.throws(() => createConversation({ owner: { kind: 'service', id: '' } }), AiError);
    assert.throws(() => createConversation({ id: '', owner: { kind: 'anonymous' } }), AiError);
  });
});

describe('appendToConversation', () => {
  it('appends a run addition, sums usage, and bumps the revision', () => {
    const start = createConversation({ id: 'c', owner: { kind: 'user', id: 'u' } });
    const next = appendToConversation(start, { appended: [user('hi'), assistant('hello')], usage });
    assert.equal(next.revision, 1);
    assert.equal(next.messages.length, 2);
    assert.deepEqual(next.usage, usage);
    assert.equal(start.messages.length, 0);
    const after = appendToConversation(next, [user('again')]);
    assert.equal(after.revision, 2);
    assert.equal(after.messages[0], next.messages[0]);
  });

  it('returns the conversation unchanged for an empty, free append but counts usage-only additions', () => {
    const start = createConversation({ id: 'c', owner: { kind: 'anonymous' } });
    assert.equal(appendToConversation(start, []), start);
    const charged = appendToConversation(start, { appended: [], usage });
    assert.equal(charged.revision, 1);
    assert.deepEqual(charged.usage, usage);
  });

  it('rejects an append that breaks the transcript', () => {
    const start = appendToConversation(
      createConversation({ id: 'c', owner: { kind: 'anonymous' } }),
      [user('hi')],
    );
    assert.throws(
      () =>
        appendToConversation(start, [
          { role: 'system', parts: [{ type: 'text', text: 'x' }] },
          user('y'),
        ]),
      (error: unknown) => error instanceof AiError && error.code === 'invalid_messages',
    );
    assert.throws(
      () => appendToConversation(start, { appended: [], usage: { ...usage, inputTokens: -1 } }),
      AiError,
    );
  });

  it('keeps an earlier pending tool call answerable by the next append', () => {
    const pending = appendToConversation(
      createConversation({ id: 'c', owner: { kind: 'anonymous' } }),
      [
        user('do it'),
        { role: 'assistant', parts: [{ type: 'tool-call', id: 't', name: 'act', input: {} }] },
      ],
    );
    const resumed = appendToConversation(pending, [
      {
        role: 'user',
        parts: [{ type: 'tool-result', id: 't', name: 'act', output: 'done', isError: false }],
      },
      assistant('finished'),
    ]);
    assert.equal(resumed.messages.length, 4);
    assert.throws(() => appendToConversation(pending, [user('ignore it')]), AiError);
  });

  it('preserves the existing prefix on every append (seeded property)', () => {
    const random = mulberry32(42);
    for (let trial = 0; trial < 50; trial += 1) {
      let conversation: Conversation = createConversation({
        id: `c${trial}`,
        owner: { kind: 'anonymous' },
      });
      let expectTurn: 'user' | 'assistant' = 'user';
      for (let step = 0; step < 10; step += 1) {
        const count = Math.floor(random() * 3);
        const batch: AiMessage[] = [];
        for (let index = 0; index < count; index += 1) {
          batch.push(
            expectTurn === 'user' ? user(`u${step}.${index}`) : assistant(`a${step}.${index}`),
          );
          expectTurn = expectTurn === 'user' ? 'assistant' : 'user';
        }
        const before = conversation;
        conversation = appendToConversation(conversation, batch);
        assert.deepEqual(conversation.messages.slice(0, before.messages.length), before.messages);
        for (let index = 0; index < before.messages.length; index += 1) {
          assert.equal(conversation.messages[index], before.messages[index]);
        }
        assert.ok(conversation.revision === before.revision + (count > 0 ? 1 : 0));
      }
    }
  });
});

describe('parseConversation', () => {
  it('round-trips through JSON', () => {
    const conversation = appendToConversation(
      createConversation({ id: 'c', owner: { kind: 'user', id: 'u' } }),
      {
        appended: [
          user('hi'),
          {
            role: 'assistant',
            parts: [
              { type: 'reasoning', text: '' },
              { type: 'text', text: 'hello' },
            ],
            native: {
              provider: 'anthropic',
              model: 'claude-opus-5-5',
              content: [{ type: 'thinking', thinking: '', signature: 'sig' }],
            },
            meta: { provider: 'anthropic', model: 'claude-opus-5-5', finishReason: 'stop', usage },
          },
        ],
        usage,
      },
    );
    const parsed = parseConversation(JSON.parse(JSON.stringify(conversation)));
    assert.deepEqual(parsed, conversation);
    assert.ok(Object.isFrozen(parsed.messages[1]?.native?.content));
  });

  const cases: readonly (readonly [string, unknown, string])[] = [
    ['a non-object', CANARY, 'root'],
    ['a wrong version', { v: 2, id: 'c', ownerId: null, messages: [], usage, revision: 0 }, 'v'],
    ['an empty id', { v: 1, id: '', ownerId: null, messages: [], usage, revision: 0 }, 'id'],
    ['a numeric owner', { v: 1, id: 'c', ownerId: 3, messages: [], usage, revision: 0 }, 'ownerId'],
    [
      'bad usage',
      { v: 1, id: 'c', ownerId: null, messages: [], usage: { inputTokens: CANARY }, revision: 0 },
      'usage',
    ],
    [
      'a negative revision',
      { v: 1, id: 'c', ownerId: null, messages: [], usage, revision: -1 },
      'revision',
    ],
    [
      'messages that are not an array',
      { v: 1, id: 'c', ownerId: null, messages: {}, usage, revision: 0 },
      'messages',
    ],
    [
      'an invalid message',
      {
        v: 1,
        id: 'c',
        ownerId: null,
        messages: [{ role: 'user', parts: [{ type: 'text', text: ' ' }], secret: CANARY }],
        usage,
        revision: 0,
      },
      'messages',
    ],
  ];
  for (const [name, value, field] of cases) {
    it(`rejects ${name} naming only the field`, () => {
      assert.throws(
        () => parseConversation(value),
        (error: unknown) => {
          assert.ok(error instanceof AiError);
          assert.equal(error.code, 'invalid_conversation');
          assert.equal(error.context.field, field);
          assert.equal(`${error.message}${JSON.stringify(error.context)}`.includes(CANARY), false);
          return true;
        },
      );
    });
  }
});
