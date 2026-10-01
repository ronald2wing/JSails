/**
 * `createMemoryConversation`: a run's result appends through the real codec
 * and a JSON round trip, the revision and usage grow, the messages feed the
 * next run as history, and an invalid append is rejected without changing
 * the stored conversation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import { generate } from '../../src/run/run.js';
import { createFakeProvider } from '../../src/testing/fake-provider.js';
import { createMemoryConversation } from '../../src/testing/memory-conversation.js';

describe('createMemoryConversation', () => {
  it('persists run results through the codec and feeds them back as history', async () => {
    const memory = createMemoryConversation({ id: 'c1', owner: { kind: 'user', id: 'u1' } });
    assert.equal(memory.conversation.revision, 0);
    assert.equal(memory.conversation.ownerId, 'u1');
    const provider = createFakeProvider([{ text: 'one' }, { text: 'two' }]);
    memory.append(await generate({ model: provider.model(), input: 'a' }));
    const second = await generate({
      model: provider.model(),
      history: memory.messages,
      input: 'b',
    });
    const stored = memory.append(second);
    assert.equal(stored.revision, 2);
    assert.equal(stored.messages.length, 4);
    assert.equal(stored.usage.inputTokens, 20);
    assert.equal(provider.requests[1]?.messages.length, 3);
    assert.equal(memory.conversation, stored);
    assert.ok(Object.isFrozen(stored.messages));
  });

  it('rejects an invalid append and keeps the stored conversation', () => {
    const memory = createMemoryConversation({ owner: { kind: 'anonymous' } });
    const before = memory.conversation;
    assert.throws(
      () => memory.append([{ role: 'assistant', parts: [{ type: 'text', text: 'prefill' }] }]),
      (error) => error instanceof AiError && error.code === 'invalid_messages',
    );
    assert.equal(memory.conversation, before);
  });
});
