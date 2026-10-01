/**
 * Chain advance and catch as follow-ups: the next step is keyed, with the
 * later steps, the catch and a fired catch carried on; the last step builds
 * nothing; the catch is a keyed callback built only while it has not fired;
 * the queues a settle needs are checked against the worker's; and
 * `withCatchFired` marks a chain step only.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { JobEnvelope, JobFlowMembership, JobFlowStep } from '../../src/contract/index.js';
import { buildEnvelope } from '../../src/envelope/codec.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import {
  chainAdvance,
  chainCatch,
  chainQueuesDeclared,
  stepEnvelope,
  stepFollowUp,
  withCatchFired,
} from '../../src/flows/chain-advance.js';
import { FLOW_KEY_WINDOW_MS } from '../../src/flows/flow-limits.js';
import { queuesOf } from './flow-recorder.js';

const NOW = 1_700_000_000_000;

function step(name: string, extra: Partial<JobFlowStep> = {}): JobFlowStep {
  return { queue: 'default', name, payload: { name }, options: {}, ...extra };
}

function settled(flow: JobFlowMembership, context?: unknown): JobEnvelope {
  return buildEnvelope({
    name: 'a',
    payload: null,
    options: {},
    ...(context === undefined ? {} : { context }),
    flow,
    dispatchedAt: 0,
  });
}

describe('chain advance', () => {
  test('builds the next step keyed, carrying the rest, the catch and the context', () => {
    const caught = step('on-catch');
    const envelope = settled(
      {
        kind: 'chain',
        id: 'c1',
        step: 0,
        next: [step('b', { tags: ['t'], overlap: { key: 'o', ttlMs: 1_000 } }), step('c')],
        catch: caught,
      },
      { trace: 'x' },
    );
    const next = chainAdvance(envelope, NOW);
    assert.equal(next?.queue, 'default');
    assert.equal(next.envelope.name, 'b');
    assert.deepEqual(next.envelope.payload, { name: 'b' });
    assert.deepEqual(next.envelope.meta, {
      key: 'jsails:chain:c1:1',
      keyWindowMs: FLOW_KEY_WINDOW_MS,
      tags: ['t'],
      context: { trace: 'x' },
      overlap: { key: 'o', ttlMs: 1_000 },
      flow: { kind: 'chain', id: 'c1', step: 1, next: [step('c')], catch: caught },
      dispatchedAt: NOW,
    });
  });

  test('a step built after a fired catch carries catchFired, and builds no catch itself', () => {
    const forced = settled({
      kind: 'chain',
      id: 'c',
      step: 0,
      next: [step('b')],
      catch: step('on-catch'),
      catchFired: true,
    });
    assert.equal(chainCatch(forced, NOW), undefined, 'the catch fired already');
    const next = chainAdvance(forced, NOW);
    assert.deepEqual(next?.envelope.meta.flow, {
      kind: 'chain',
      id: 'c',
      step: 1,
      next: [],
      catch: step('on-catch'),
      catchFired: true,
    });
    assert.equal(chainCatch(next.envelope, NOW), undefined, 'nor does any later step');
  });

  test('the last step, a non-chain job, and a chain without a catch build nothing', () => {
    const last = settled({ kind: 'chain', id: 'c', step: 2, next: [] });
    const batch = settled({ kind: 'batch', id: 'b', index: 0 });
    assert.deepEqual(
      [chainAdvance(last, NOW), chainCatch(last, NOW), chainAdvance(batch, NOW)],
      [undefined, undefined, undefined],
    );
    assert.equal(chainCatch(batch, NOW), undefined);
  });

  test('the next step of a chain without a catch carries none', () => {
    const next = chainAdvance(settled({ kind: 'chain', id: 'c', step: 0, next: [step('b')] }), NOW);
    assert.equal('catch' in (next?.envelope.meta.flow ?? {}), false);
    assert.equal('catchFired' in (next?.envelope.meta.flow ?? {}), false);
  });

  test('the catch is a keyed chain callback', () => {
    const fired = chainCatch(
      settled({ kind: 'chain', id: 'c', step: 1, next: [step('c')], catch: step('on-catch') }),
      NOW,
    );
    assert.equal(fired?.envelope.name, 'on-catch');
    assert.equal(fired.envelope.meta.key, 'jsails:chain:c:catch');
    assert.deepEqual(fired.envelope.meta.flow, {
      kind: 'callback',
      flow: 'chain',
      id: 'c',
      callback: 'catch',
    });
  });

  test('the queues a settle needs are the next step and the catch, checked against the worker', () => {
    const queues = queuesOf('default');
    const chain = (next: JobFlowStep[], caught?: JobFlowStep) =>
      settled({
        kind: 'chain',
        id: 'c',
        step: 0,
        next,
        ...(caught === undefined ? {} : { catch: caught }),
      });
    assert.equal(chainQueuesDeclared(chain([step('b')], step('x')), queues), true);
    assert.equal(chainQueuesDeclared(chain([]), queues), true);
    assert.equal(
      chainQueuesDeclared(chain([step('b'), step('c', { queue: 'later' })]), queues),
      true,
      'only the next step is enqueued by this settle',
    );
    assert.equal(chainQueuesDeclared(chain([step('b', { queue: 'elsewhere' })]), queues), false);
    assert.equal(
      chainQueuesDeclared(chain([step('b')], step('x', { queue: 'elsewhere' })), queues),
      false,
    );
    assert.equal(chainQueuesDeclared(settled({ kind: 'batch', id: 'b', index: 0 }), queues), true);
  });

  test('stepEnvelope leaves out absent tags, overlap and context', () => {
    const parts = {
      key: 'k',
      flow: { kind: 'batch', id: 'b', index: 3 },
      context: undefined,
      dispatchedAt: 1,
    } as const;
    const envelope = stepEnvelope(step('b'), parts);
    assert.deepEqual(Object.keys(envelope.meta).sort(), [
      'dispatchedAt',
      'flow',
      'key',
      'keyWindowMs',
    ]);
    assert.deepEqual(stepFollowUp(step('b', { queue: 'mail' }), parts), {
      queue: 'mail',
      envelope,
    });
  });

  test('withCatchFired marks a chain step and refuses anything else', () => {
    const marked = withCatchFired(settled({ kind: 'chain', id: 'c', step: 0, next: [step('b')] }));
    assert.deepEqual(marked.meta.flow, {
      kind: 'chain',
      id: 'c',
      step: 0,
      next: [step('b')],
      catchFired: true,
    });
    assert.ok(Object.isFrozen(marked.meta.flow));
    for (const value of [settled({ kind: 'batch', id: 'b', index: 0 }), { v: 0 }]) {
      assert.throws(
        () => withCatchFired(value as JobEnvelope),
        (error: unknown) => JobsErrors.is(error, 'invalid_envelope'),
      );
    }
  });
});
