/**
 * The outcome check: every well-formed outcome comes back as a frozen copy of
 * its known fields, follow-ups copied through JSON, and anything else as the
 * broken-contract failure.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  checkedAttemptOutcome,
  MAX_FOLLOW_UPS,
  PROCESSOR_BROKE_CONTRACT,
} from '../../src/contract/outcome-check.js';
import { buildEnvelope } from '../../src/envelope/codec.js';

const summary = { code: 'jobs.invalid_payload', kind: 'invalid', name: 'JobsError' } as const;
const followUp = {
  queue: 'default',
  envelope: buildEnvelope({ name: 'next', payload: { n: 1 }, options: {}, dispatchedAt: 0 }),
};

describe('checkedAttemptOutcome', () => {
  test('every variant is accepted as a frozen copy without extra keys', () => {
    const accepted: [unknown, unknown][] = [
      [{ kind: 'completed', extra: 1 }, { kind: 'completed' }],
      [
        { kind: 'discarded', error: summary, extra: 1 },
        { kind: 'discarded', error: summary },
      ],
      [
        { kind: 'skipped', reason: 'overlap', extra: 1 },
        { kind: 'skipped', reason: 'overlap' },
      ],
      [
        { kind: 'released', reason: 'shutdown' },
        { kind: 'released', reason: 'shutdown' },
      ],
      [
        { kind: 'released', reason: 'unknown_job', delayMs: 500, extra: 1 },
        { kind: 'released', reason: 'unknown_job', delayMs: 500 },
      ],
      [
        { kind: 'released', reason: 'rate_limited', delayMs: -1 },
        { kind: 'released', reason: 'rate_limited', delayMs: -1 },
      ],
      [
        {
          kind: 'failed',
          error: { ...summary, stack: '    at x', message: 'm' },
          retryable: false,
        },
        {
          kind: 'failed',
          error: { ...summary, stack: '    at x', message: 'm' },
          retryable: false,
        },
      ],
    ];
    for (const [input, expected] of accepted) {
      const checked = checkedAttemptOutcome(input);
      assert.deepEqual(checked, expected);
      assert.notEqual(checked, input);
      assert.equal(Object.isFrozen(checked), true);
      if ('error' in checked) {
        assert.equal(Object.isFrozen(checked.error), true);
        assert.notEqual(checked.error, (input as { error: unknown }).error);
      }
    }
  });

  test('follow-ups are copied whole, so the processor keeps no reference into them', () => {
    const payload = { n: 1 };
    const envelope = { ...followUp.envelope, payload };
    for (const outcome of [
      { kind: 'completed', followUps: [{ queue: 'default', envelope, extra: 1 }] },
      { kind: 'discarded', error: summary, followUps: [{ queue: 'default', envelope }] },
      { kind: 'skipped', reason: 'overlap', followUps: [{ queue: 'default', envelope }] },
      {
        kind: 'failed',
        error: summary,
        retryable: false,
        catchFired: true,
        followUps: [{ queue: 'default', envelope }],
      },
    ]) {
      const checked = checkedAttemptOutcome(outcome);
      assert.notEqual(checked, PROCESSOR_BROKE_CONTRACT, outcome.kind);
      const copies = checked.kind === 'released' ? undefined : checked.followUps;
      assert.deepEqual(copies, [{ queue: 'default', envelope }]);
      assert.equal(Object.isFrozen(copies), true);
      assert.equal(Object.isFrozen(copies?.[0]), true);
      payload.n = 2;
      assert.deepEqual(copies?.[0]?.envelope.payload, { n: 1 });
      payload.n = 1;
    }
    assert.deepEqual(
      checkedAttemptOutcome({ kind: 'released', reason: 'shutdown', followUps: [followUp] }),
      { kind: 'released', reason: 'shutdown' },
      'a release carries none',
    );
  });

  test('each malformed field gives the broken-contract failure', () => {
    for (const input of [
      { kind: 'discarded' },
      { kind: 'discarded', error: { ...summary, kind: 'handler' } },
      { kind: 'failed', error: summary },
      { kind: 'failed', error: summary, retryable: 1 },
      { kind: 'failed', error: { ...summary, token: 'x' }, retryable: true },
      { kind: 'skipped' },
      { kind: 'skipped', reason: 'busy' },
      { kind: 'released' },
      { kind: 'released', reason: 'later' },
      { kind: 'released', reason: 'shutdown', delayMs: '5' },
      { kind: 'released', reason: 'shutdown', delayMs: Number.POSITIVE_INFINITY },
      { kind: 'completed', followUps: [] },
      { kind: 'completed', followUps: followUp },
      { kind: 'completed', followUps: Array.from({ length: MAX_FOLLOW_UPS + 1 }, () => followUp) },
      { kind: 'completed', followUps: [{ queue: 7, envelope: followUp.envelope }] },
      { kind: 'completed', followUps: [{ queue: 'default', envelope: 'x' }] },
      { kind: 'completed', followUps: [null] },
      { kind: 'discarded', error: summary, followUps: [] },
      { kind: 'skipped', reason: 'overlap', followUps: [] },
      { kind: 'failed', error: summary, retryable: false, followUps: [] },
      { kind: 'failed', error: summary, retryable: false, catchFired: true },
    ]) {
      assert.equal(checkedAttemptOutcome(input), PROCESSOR_BROKE_CONTRACT, JSON.stringify(input));
    }
  });

  test('a non-object, an unknown kind or a throwing getter is handled', () => {
    const throwing = {
      get kind(): string {
        throw new Error('getter');
      },
    };
    for (const input of [undefined, null, 'completed', 1, [], { kind: 'bogus' }, throwing]) {
      assert.equal(checkedAttemptOutcome(input), PROCESSOR_BROKE_CONTRACT);
    }
    assert.deepEqual(PROCESSOR_BROKE_CONTRACT, {
      kind: 'failed',
      error: { code: 'jobs.processor_broke_contract', kind: 'internal', name: 'JobsError' },
      retryable: true,
    });
  });
});
