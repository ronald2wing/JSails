/**
 * `reduceAiEvents`: the starting state, text and reasoning parts in model
 * order, tool parts updated in place (input kept once seen), approvals,
 * error codes, finish (pending approvals kept only while awaiting), frozen
 * results that never mutate the previous state, and no change after finish.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reduceAiEvents, type AiClientMessage } from '../../src/client/reduce-ai-events.js';
import type { AiWireEvent } from '../../src/event-stream/wire-events.js';

const usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

function fold(events: readonly AiWireEvent[]): AiClientMessage {
  let state: AiClientMessage | undefined;
  for (const event of events) state = reduceAiEvents(state, event);
  assert.ok(state !== undefined);
  return state;
}

describe('reduceAiEvents', () => {
  it('starts streaming and empty', () => {
    assert.deepEqual(reduceAiEvents(undefined, { event: 'start', data: { v: 1 } }), {
      status: 'streaming',
      parts: [],
      text: '',
      reasoning: '',
      pendingApprovals: [],
    });
  });

  it('keeps parts in model order and joins text across tool calls', () => {
    const state = fold([
      { event: 'start', data: { v: 1 } },
      { event: 'step', data: { index: 0 } },
      { event: 'reasoning', data: { delta: 'think' } },
      { event: 'reasoning', data: { delta: 'ing' } },
      { event: 'text', data: { delta: 'Let me ' } },
      { event: 'text', data: { delta: 'check.' } },
      { event: 'text', data: { delta: '' } },
      { event: 'tool', data: { id: 'c1', name: 'weather', state: 'started' } },
      {
        event: 'tool',
        data: { id: 'c1', name: 'weather', state: 'called', input: { city: 'Oslo' } },
      },
      { event: 'tool', data: { id: 'c1', name: 'weather', state: 'done', output: '21C' } },
      { event: 'step', data: { index: 1 } },
      { event: 'text', data: { delta: 'It is 21C.' } },
      { event: 'finish', data: { status: 'completed', finishReason: 'stop', usage } },
    ]);
    assert.deepEqual(state.parts, [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'Let me check.' },
      {
        type: 'tool',
        id: 'c1',
        name: 'weather',
        state: 'done',
        input: { city: 'Oslo' },
        output: '21C',
      },
      { type: 'text', text: 'It is 21C.' },
    ]);
    assert.equal(state.text, 'Let me check.\n\nIt is 21C.');
    assert.equal(state.reasoning, 'thinking');
    assert.equal(state.status, 'completed');
    assert.equal(state.finishReason, 'stop');
    assert.deepEqual(state.usage, usage);
  });

  it('records a failed tool with its code', () => {
    const state = fold([
      { event: 'tool', data: { id: 'c1', name: 'x', state: 'failed', code: 'tool_denied' } },
    ]);
    assert.deepEqual(state.parts, [
      { type: 'tool', id: 'c1', name: 'x', state: 'failed', code: 'tool_denied' },
    ]);
  });

  it('marks calls awaiting approval and keeps them through an awaiting finish', () => {
    const calls = [{ id: 'c1', name: 'refund', inputDigest: 'd', input: { amount: 5 } }];
    const state = fold([
      { event: 'tool', data: { id: 'c1', name: 'refund', state: 'started' } },
      { event: 'approval', data: { calls } },
      { event: 'finish', data: { status: 'awaiting-approval', finishReason: 'tool-calls', usage } },
    ]);
    assert.deepEqual(state.parts, [
      { type: 'tool', id: 'c1', name: 'refund', state: 'awaiting-approval', input: { amount: 5 } },
    ]);
    assert.deepEqual(state.pendingApprovals, calls);
    assert.equal(state.status, 'awaiting-approval');
  });

  it('records the error code and clears approvals on a failed finish', () => {
    const state = fold([
      { event: 'approval', data: { calls: [{ id: 'c1', name: 'x' }] } },
      { event: 'error', data: { code: 'budget_exceeded' } },
      { event: 'finish', data: { status: 'failed', usage } },
    ]);
    assert.equal(state.error, 'budget_exceeded');
    assert.equal(state.status, 'failed');
    assert.deepEqual(state.pendingApprovals, []);
    assert.equal(state.finishReason, undefined);
  });

  it('returns new frozen states and ignores events after finish', () => {
    const first = reduceAiEvents(undefined, { event: 'text', data: { delta: 'a' } });
    const second = reduceAiEvents(first, { event: 'text', data: { delta: 'b' } });
    assert.notEqual(first, second);
    assert.equal(first.text, 'a');
    assert.equal(second.text, 'ab');
    assert.ok(Object.isFrozen(second) && Object.isFrozen(second.parts));
    const done = reduceAiEvents(second, { event: 'finish', data: { status: 'aborted', usage } });
    assert.equal(reduceAiEvents(done, { event: 'text', data: { delta: 'late' } }), done);
  });
});
