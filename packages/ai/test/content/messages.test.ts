/**
 * Message constructor and reader tests: `userMessage`, `systemMessage`,
 * `textOf`, `toolCallsOf`, `toolResultsOf`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import { systemMessage, textOf, userMessage } from '../../src/content/messages.js';
import { toolCallsOf, toolResultsOf } from '../../src/content/validate-messages.js';
import type { AiMessage, AiUserPart } from '../../src/content/types.js';

describe('message constructors', () => {
  it('builds frozen user and system messages', () => {
    const user = userMessage('hi');
    assert.deepEqual(user, { role: 'user', parts: [{ type: 'text', text: 'hi' }] });
    assert.ok(Object.isFrozen(user));
    assert.deepEqual(systemMessage('rules'), {
      role: 'system',
      parts: [{ type: 'text', text: 'rules' }],
    });
  });

  it('builds a user message from parts and rejects invalid ones', () => {
    const parts: AiUserPart[] = [{ type: 'text', text: 'a', cache: true }];
    assert.deepEqual(userMessage(parts).parts, [{ type: 'text', text: 'a', cache: true }]);
    assert.throws(() => userMessage(''), AiError);
    assert.throws(
      () => userMessage([{ type: 'reasoning', text: 'x' }] as unknown as AiUserPart[]),
      AiError,
    );
  });

  it('reads text, tool calls, and tool results in order', () => {
    const assistant: AiMessage = {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'one ' },
        { type: 'reasoning', text: 'hidden' },
        { type: 'tool-call', id: 'a', name: 'x', input: {} },
        { type: 'text', text: 'two' },
      ],
    };
    assert.equal(textOf(assistant), 'one two');
    assert.deepEqual(
      toolCallsOf(assistant).map((part) => part.id),
      ['a'],
    );
    const results: AiMessage = {
      role: 'user',
      parts: [{ type: 'tool-result', id: 'a', name: 'x', output: 'ok', isError: false }],
    };
    assert.deepEqual(
      toolResultsOf(results).map((part) => part.id),
      ['a'],
    );
    assert.equal(textOf(results), '');
  });
});
