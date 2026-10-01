/**
 * Tests for tenancy actors: user ids, reasons, and the audit actor and reason
 * derived from each actor kind.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkActor, parseReason, parseUserId, systemActor } from '../src/tenancy-actor.js';
import { thrownCode } from './thrown-code.js';

describe('parseUserId', () => {
  it('accepts opaque ids and refuses blank, padded, control or overlong ones', () => {
    assert.equal(parseUserId('user_01H'), 'user_01H');
    assert.equal(parseUserId('é'.repeat(191)), 'é'.repeat(191));
    for (const value of ['', ' a', 'a ', 'a\nb', 'x'.repeat(192), 7, null, undefined]) {
      assert.equal(parseUserId(value), null, JSON.stringify(value));
    }
  });
});

describe('parseReason', () => {
  it('normalises and bounds a reason', () => {
    assert.equal(parseReason('  chargeback  '), 'chargeback');
    assert.equal(parseReason(`e${String.fromCodePoint(0x301)}`), 'é');
    assert.equal(
      thrownCode(() => parseReason('   ')),
      'reason_required',
    );
    assert.equal(
      thrownCode(() => parseReason(undefined)),
      'reason_required',
    );
    assert.equal(
      thrownCode(() => parseReason('a\u0000b')),
      'invalid_reason',
    );
    assert.equal(
      thrownCode(() => parseReason('x'.repeat(501))),
      'invalid_reason',
    );
    assert.equal(parseReason('x'.repeat(500)).length, 500);
  });
});

describe('checkActor', () => {
  it('derives the audit actor and reason for each kind', () => {
    assert.deepEqual(checkActor({ kind: 'user', userId: 'alice' }), {
      actor: { kind: 'user', userId: 'alice' },
      audit: { kind: 'user', id: 'alice' },
      reason: null,
    });
    assert.deepEqual(checkActor({ kind: 'operator', userId: 'op', reason: ' ticket ' }), {
      actor: { kind: 'operator', userId: 'op', reason: 'ticket' },
      audit: { kind: 'operator', id: 'op' },
      reason: 'ticket',
    });
    const machine = systemActor('nightly');
    assert.deepEqual(machine.audit, { kind: 'system' });
    assert.equal(machine.reason, 'nightly');
    assert.ok(Object.isFrozen(machine) && Object.isFrozen(machine.actor));
  });

  it('refuses malformed actors', () => {
    for (const value of [
      null,
      'alice',
      {},
      { kind: 'robot' },
      { kind: 'user' },
      { kind: 'user', userId: '' },
      { kind: 'operator', userId: ' op', reason: 'x' },
    ]) {
      assert.equal(
        thrownCode(() => checkActor(value)),
        'invalid_actor',
        JSON.stringify(value),
      );
    }
    assert.equal(
      thrownCode(() => checkActor({ kind: 'operator', userId: 'op' })),
      'reason_required',
    );
    assert.equal(
      thrownCode(() => checkActor({ kind: 'system' })),
      'reason_required',
    );
  });
});
