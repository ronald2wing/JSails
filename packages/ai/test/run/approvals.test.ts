/**
 * Approval binding primitives: canonical JSON and the call digest (stable
 * under key order, sensitive to actor, id, name, and input).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson, readApprovals, toolCallDigest } from '../../src/run/approvals.js';

describe('canonicalJson', () => {
  it('sorts keys at every level and keeps arrays in order', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [3, 1], c: null } }),
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
    assert.equal(canonicalJson('x"y'), '"x\\"y"');
  });
});

describe('toolCallDigest', () => {
  const actor = { kind: 'user', id: 'u1' } as const;
  const call = { id: 'c1', name: 'refund', input: { amount: 5, orderId: 'o1' } };

  it('ignores key order and changes with every bound field', () => {
    const base = toolCallDigest(actor, call);
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(toolCallDigest(actor, { ...call, input: { orderId: 'o1', amount: 5 } }), base);
    for (const variant of [
      toolCallDigest({ kind: 'user', id: 'u2' }, call),
      toolCallDigest({ kind: 'service', id: 'u1' }, call),
      toolCallDigest(actor, { ...call, id: 'c2' }),
      toolCallDigest(actor, { ...call, name: 'refunds' }),
      toolCallDigest(actor, { ...call, input: { amount: 6, orderId: 'o1' } }),
    ]) {
      assert.notEqual(variant, base);
    }
  });
});

describe('readApprovals', () => {
  it('keys decisions by id and freezes them', () => {
    const map = readApprovals([
      { id: 'a', name: 't', inputDigest: 'f'.repeat(64), decision: 'deny', extra: true },
    ]);
    assert.deepEqual(map.get('a'), {
      id: 'a',
      name: 't',
      inputDigest: 'f'.repeat(64),
      decision: 'deny',
    });
    assert.ok(Object.isFrozen(map.get('a')));
    assert.equal(readApprovals(undefined).size, 0);
  });
});
