/**
 * The ai.v1 projection and encoder: the projection table, hidden tool IO
 * unless exposed, the approval digest only for exposed calls (a resumed run
 * included, which emits no tool-call events), reasoning only
 * on opt-in, code-only errors and cost-free finish events, an exact wire
 * snapshot, and a seeded encode-then-parse round trip over hostile strings.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { AiError } from '../../src/errors/ai-error.js';
import { createSseParser, type SseEvent } from '../../src/client/sse-parser.js';
import { decodeWireEvent } from '../../src/client/wire-decoding.js';
import type { AiResult, AiRunEvent } from '../../src/run/run-contract.js';
import { generate, run } from '../../src/run/run.js';
import { createFakeProvider } from '../../src/testing/fake-provider.js';
import { defineTool } from '../../src/tools/define-tool.js';
import {
  AI_TOOL_ERROR_CODES,
  SSE_HEARTBEAT,
  createWireProjector,
  encodeWireEvent,
  type AiWireEvent,
} from '../../src/event-stream/wire-events.js';

const usage = { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 };

function result(overrides: Partial<AiResult> = {}): AiResult {
  return {
    status: 'completed',
    text: '',
    finishReason: 'stop',
    appended: [],
    messages: [],
    steps: [],
    usage,
    costMicroUsd: 999,
    pendingApprovals: [],
    ...overrides,
  };
}

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

function parseAll(text: string): AiWireEvent[] {
  const events: SseEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  parser.push(text);
  parser.end();
  return events.map((event) => {
    const decoded = decodeWireEvent(event);
    assert.ok(decoded !== undefined);
    return decoded;
  });
}

describe('createWireProjector', () => {
  it('projects each run event as the table says', () => {
    const projector = createWireProjector({ reasoning: true });
    const table: [AiRunEvent, readonly AiWireEvent[]][] = [
      [{ type: 'step-start', step: 0 }, [{ event: 'step', data: { index: 0 } }]],
      [{ type: 'text-delta', step: 0, delta: 'Hi' }, [{ event: 'text', data: { delta: 'Hi' } }]],
      [{ type: 'text-delta', step: 0, delta: '' }, []],
      [
        { type: 'reasoning-delta', step: 0, delta: 'hmm' },
        [{ event: 'reasoning', data: { delta: 'hmm' } }],
      ],
      [
        { type: 'tool-call-start', step: 0, id: 'c1', name: 'weather' },
        [{ event: 'tool', data: { id: 'c1', name: 'weather', state: 'started' } }],
      ],
      [{ type: 'step-finish', step: 0, finishReason: 'tool-calls', usage, appended: [] }, []],
      [{ type: 'tool-results', message: { role: 'user', parts: [] } }, []],
    ];
    for (const [event, expected] of table) {
      assert.deepEqual(projector.project(event), expected, event.type);
    }
  });

  it('hides tool input and output unless the tool is exposed, keeping failure codes', () => {
    const projector = createWireProjector();
    assert.deepEqual(
      projector.project({
        type: 'tool-call',
        step: 0,
        id: 'c1',
        name: 'secret',
        input: { ssn: 'CANARY' },
        exposeToBrowser: false,
      }),
      [{ event: 'tool', data: { id: 'c1', name: 'secret', state: 'called' } }],
    );
    assert.deepEqual(
      projector.project({
        type: 'tool-result',
        id: 'c1',
        name: 'secret',
        isError: true,
        output: 'error: CANARY',
        code: 'tool_failed',
        exposeToBrowser: false,
      }),
      [{ event: 'tool', data: { id: 'c1', name: 'secret', state: 'failed', code: 'tool_failed' } }],
    );
    assert.deepEqual(
      projector.project({
        type: 'tool-call',
        step: 0,
        id: 'c2',
        name: 'weather',
        input: { city: 'Oslo' },
        exposeToBrowser: true,
      }),
      [
        {
          event: 'tool',
          data: { id: 'c2', name: 'weather', state: 'called', input: { city: 'Oslo' } },
        },
      ],
    );
    assert.deepEqual(
      projector.project({
        type: 'tool-result',
        id: 'c2',
        name: 'weather',
        isError: false,
        output: '21C',
        exposeToBrowser: true,
      }),
      [{ event: 'tool', data: { id: 'c2', name: 'weather', state: 'done', output: '21C' } }],
    );
  });

  it('carries the approval digest and input only for exposed calls', () => {
    const projector = createWireProjector();
    const [approval] = projector.project({
      type: 'approval-required',
      calls: [
        {
          id: 'shown',
          name: 'refund',
          input: { amount: 5 },
          inputDigest: 'd1',
          exposeToBrowser: true,
        },
        {
          id: 'hidden',
          name: 'delete',
          input: { id: 'CANARY' },
          inputDigest: 'd2',
          exposeToBrowser: false,
        },
      ],
    });
    assert.deepEqual(approval, {
      event: 'approval',
      data: {
        calls: [
          { id: 'shown', name: 'refund', inputDigest: 'd1', input: { amount: 5 } },
          { id: 'hidden', name: 'delete' },
        ],
      },
    });
    assert.ok(!JSON.stringify(approval).includes('CANARY'));
  });

  it('projects a resumed run that still waits for a decision on an exposed tool', async () => {
    const refund = defineTool({
      name: 'refund',
      description: 'Refund an order.',
      input: z.object({ orderId: z.string() }),
      needsApproval: true,
      exposeToBrowser: true,
      execute: () => 'refunded',
    });
    const hidden = defineTool({
      name: 'erase',
      description: 'Erase an order.',
      input: z.object({ orderId: z.string() }),
      needsApproval: true,
      execute: () => 'erased',
    });
    const context = { actor: { kind: 'user', id: 'u1' } } as const;
    const fake = createFakeProvider([
      {
        toolCalls: [
          { id: 'r1', name: 'refund', input: { orderId: 'o1' } },
          { id: 'e1', name: 'erase', input: { orderId: 'CANARY' } },
        ],
      },
    ]);
    const first = await generate({
      model: fake.model(),
      input: 'Refund and erase.',
      tools: [refund, hidden],
      context,
    });
    assert.equal(first.status, 'awaiting-approval');
    const erase = first.pendingApprovals.find((call) => call.id === 'e1');
    assert.ok(erase !== undefined);
    const resumed = run({
      model: fake.model(),
      history: first.messages,
      approvals: [
        { id: erase.id, name: erase.name, inputDigest: erase.inputDigest, decision: 'deny' },
      ],
      tools: [refund, hidden],
      context,
    });
    const projector = createWireProjector();
    const wireEvents: unknown[] = [];
    for await (const event of resumed) wireEvents.push(...projector.project(event));
    const refundCall = first.pendingApprovals.find((call) => call.id === 'r1');
    assert.deepEqual(wireEvents[0], {
      event: 'approval',
      data: {
        calls: [
          {
            id: 'r1',
            name: 'refund',
            inputDigest: refundCall?.inputDigest,
            input: { orderId: 'o1' },
          },
        ],
      },
    });
    assert.ok(!JSON.stringify(wireEvents).includes('CANARY'));
  });

  it('drops reasoning unless asked for it', () => {
    assert.deepEqual(
      createWireProjector().project({ type: 'reasoning-delta', step: 0, delta: 'secret plan' }),
      [],
    );
  });

  it('ends with a code-only error and a cost-free finish', () => {
    const error = new AiError('provider_failed', 'the provider call failed', {
      context: { reason: 'CANARY' },
    });
    const events = createWireProjector().project({
      type: 'finish',
      result: result({ status: 'failed', error, finishReason: undefined }),
    });
    assert.deepEqual(events, [
      { event: 'error', data: { code: 'provider_failed' } },
      { event: 'finish', data: { status: 'failed', usage } },
    ]);
    assert.ok(!JSON.stringify(events).includes('CANARY'));
    assert.ok(!JSON.stringify(events).includes('999'));
  });
});

describe('encodeWireEvent', () => {
  it('matches the ai.v1 wire snapshot', () => {
    const events: AiWireEvent[] = [
      { event: 'start', data: { v: 1 } },
      { event: 'step', data: { index: 0 } },
      { event: 'text', data: { delta: 'a\nb' } },
      { event: 'tool', data: { id: 'c1', name: 'w', state: 'failed', code: 'tool_denied' } },
      { event: 'approval', data: { calls: [{ id: 'c2', name: 'x' }] } },
      { event: 'error', data: { code: 'aborted' } },
      { event: 'finish', data: { status: 'aborted', finishReason: 'stop', usage } },
    ];
    assert.equal(
      events.map(encodeWireEvent).join('') + SSE_HEARTBEAT,
      'event: start\ndata: {"v":1}\n\n' +
        'event: step\ndata: {"index":0}\n\n' +
        'event: text\ndata: {"delta":"a\\nb"}\n\n' +
        'event: tool\ndata: {"id":"c1","name":"w","state":"failed","code":"tool_denied"}\n\n' +
        'event: approval\ndata: {"calls":[{"id":"c2","name":"x"}]}\n\n' +
        'event: error\ndata: {"code":"aborted"}\n\n' +
        'event: finish\ndata: {"status":"aborted","finishReason":"stop","usage":' +
        '{"inputTokens":12,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0}}\n\n' +
        ':\n\n',
    );
  });

  it('drops an input that is not JSON rather than break the stream', () => {
    const text = encodeWireEvent({
      event: 'tool',
      data: { id: 'c1', name: 'w', state: 'called', input: { n: 1n } },
    });
    assert.equal(text, 'event: tool\ndata: {"id":"c1","name":"w","state":"called"}\n\n');
  });

  it('round-trips hostile strings through the parser (seeded)', () => {
    const random = mulberry32(0xa1);
    const alphabet = [
      'a',
      ' ',
      '\n',
      '\r',
      '\r\n',
      ' ',
      ' ',
      ':',
      '\0',
      '😀',
      'é',
      '"',
      '\\',
      'data: x',
      'event: finish',
      '﻿',
    ];
    for (let trial = 0; trial < 300; trial += 1) {
      const pick = (): string => {
        let text = '';
        const length = Math.floor(random() * 12);
        for (let at = 0; at < length; at += 1) {
          text += alphabet[Math.floor(random() * alphabet.length)];
        }
        return text;
      };
      const events: AiWireEvent[] = [
        { event: 'start', data: { v: 1 } },
        { event: 'text', data: { delta: pick() } },
        { event: 'reasoning', data: { delta: pick() } },
        {
          event: 'tool',
          data: { id: 'c1', name: 'w', state: 'done', input: { q: pick() }, output: pick() },
        },
        { event: 'finish', data: { status: 'completed', usage } },
      ];
      assert.deepEqual(parseAll(events.map(encodeWireEvent).join('')), events);
    }
  });

  it('lists every tool error code once', () => {
    assert.equal(new Set(AI_TOOL_ERROR_CODES).size, AI_TOOL_ERROR_CODES.length);
    assert.ok(AI_TOOL_ERROR_CODES.includes('approval_denied'));
  });
});
