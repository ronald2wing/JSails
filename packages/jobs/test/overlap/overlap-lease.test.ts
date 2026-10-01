/**
 * The overlap lease around one run: a held key is reported, the lease is
 * renewed every third of its TTL with one renewal in flight, a refused
 * renewal loses it once, a failed one only when no renewal lands before the
 * store's deadline (a TTL after the last confirmed request was sent), and
 * release is bounded, swallows errors and is idempotent.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { LeaseCapability } from '../../src/contract/index.js';
import { acquireOverlapLease, MAX_RELEASE_WAIT_MS } from '../../src/overlap/overlap-lease.js';
import { flush, VirtualClock } from '../timing/virtual-clock.js';

const TTL = 3_000;

interface Call {
  readonly op: 'acquire' | 'renew' | 'release';
  readonly key: string;
}

/** A lease store whose answers the test sets. */
class FakeLeases implements LeaseCapability {
  readonly calls: Call[] = [];
  token: string | undefined = 'token-1';
  renewal: () => Promise<boolean> = () => Promise.resolve(true);
  releasing: () => Promise<boolean> = () => Promise.resolve(true);

  acquire(key: string): Promise<string | undefined> {
    this.calls.push({ op: 'acquire', key });
    return Promise.resolve(this.token);
  }
  renew(key: string): Promise<boolean> {
    this.calls.push({ op: 'renew', key });
    return this.renewal();
  }
  release(key: string): Promise<boolean> {
    this.calls.push({ op: 'release', key });
    return this.releasing();
  }
  count(op: Call['op']): number {
    return this.calls.filter((call) => call.op === op).length;
  }
}

async function acquired(leases: FakeLeases, clock: VirtualClock) {
  const lease = await acquireOverlapLease(leases, { key: 'k', ttlMs: TTL }, clock);
  assert.ok(lease !== 'held');
  return lease;
}

describe('overlap lease', () => {
  test('a held key is reported as held, under the overlap prefix', async () => {
    const leases = new FakeLeases();
    leases.token = undefined;
    assert.equal(
      await acquireOverlapLease(leases, { key: 'k', ttlMs: TTL }, new VirtualClock(0)),
      'held',
    );
    assert.deepEqual(leases.calls, [{ op: 'acquire', key: 'overlap:k' }]);
  });

  test('renews every third of the TTL until released', async () => {
    const leases = new FakeLeases();
    const clock = new VirtualClock(0);
    const lease = await acquired(leases, clock);
    await clock.advance(TTL);
    assert.equal(leases.count('renew'), 3);
    await lease.release();
    await clock.advance(TTL);
    assert.equal(leases.count('renew'), 3);
    assert.equal(leases.count('release'), 1);
  });

  test('keeps one renewal in flight', async () => {
    const leases = new FakeLeases();
    let answer: ((held: boolean) => void) | undefined;
    leases.renewal = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const clock = new VirtualClock(0);
    const lease = await acquired(leases, clock);
    await clock.advance(TTL - 1);
    assert.equal(leases.count('renew'), 1);
    answer!(true);
    await flush();
    await clock.advance(TTL / 3);
    assert.equal(leases.count('renew'), 2);
    answer!(true);
    await lease.release();
  });

  test('a refused renewal loses the lease once and stops renewing', async () => {
    const leases = new FakeLeases();
    leases.renewal = () => Promise.resolve(false);
    const clock = new VirtualClock(0);
    const lease = await acquired(leases, clock);
    let lost = 0;
    lease.watch(() => (lost += 1));
    await clock.advance(TTL * 2);
    assert.equal(lost, 1);
    assert.equal(leases.count('renew'), 1);
    let late = 0;
    lease.watch(() => (late += 1));
    assert.equal(late, 1, 'a watcher set after the loss hears of it at once');
    await lease.release();
  });

  test('a renewal that rejects keeps the lease, which the store still holds', async () => {
    const leases = new FakeLeases();
    let failures = 1;
    leases.renewal = () => {
      if (failures === 0) return Promise.resolve(true);
      failures -= 1;
      return Promise.reject(new Error('store down'));
    };
    const clock = new VirtualClock(0);
    const lease = await acquired(leases, clock);
    let lost = 0;
    lease.watch(() => (lost += 1));
    await clock.advance(TTL * 3);
    assert.equal(lost, 0, 'one failed renewal lost the lease');
    assert.equal(leases.count('renew'), 9, 'renewing goes on');
    await lease.release();
  });

  test('renewals that keep failing lose the lease at the TTL after the acquire was sent', async () => {
    const leases = new FakeLeases();
    leases.renewal = () => Promise.reject(new Error('store down'));
    const clock = new VirtualClock(0);
    const lease = await acquired(leases, clock);
    let lost = 0;
    lease.watch(() => (lost += 1));
    await clock.advance(TTL - 1);
    assert.equal(lost, 0);
    await clock.advance(1);
    assert.equal(lost, 1);
    const renewals = leases.count('renew');
    await clock.advance(TTL);
    assert.equal(leases.count('renew'), renewals, 'a lost lease is not renewed');
    await lease.release();
  });

  test('the deadline moves to a TTL after the last confirmed renewal was sent', async () => {
    const leases = new FakeLeases();
    let answer: ((held: boolean) => void) | undefined;
    let calls = 0;
    leases.renewal = () => {
      calls += 1;
      if (calls > 1) return Promise.reject(new Error('store down'));
      return new Promise((resolve) => {
        answer = resolve;
      });
    };
    const clock = new VirtualClock(0);
    const lease = await acquired(leases, clock);
    let lost = 0;
    lease.watch(() => (lost += 1));
    await clock.advance(TTL / 3 + 500);
    answer!(true);
    await flush();
    await clock.advance(TTL / 3 + TTL - 500 - 1 - TTL / 3);
    assert.equal(clock.now(), TTL / 3 + TTL - 1);
    assert.equal(lost, 0);
    await clock.advance(1);
    assert.equal(lost, 1, 'counted from when the renewal was sent, not answered');
    await lease.release();
  });

  test('a renewal that hangs past the deadline loses the lease', async () => {
    const leases = new FakeLeases();
    leases.renewal = () => new Promise(() => undefined);
    const clock = new VirtualClock(0);
    const lease = await acquired(leases, clock);
    let lost = 0;
    lease.watch(() => (lost += 1));
    await clock.advance(TTL);
    assert.equal(lost, 1);
    assert.equal(leases.count('renew'), 1);
    await lease.release();
  });

  test('release stops the deadline', async () => {
    const leases = new FakeLeases();
    leases.renewal = () => Promise.reject(new Error('store down'));
    const clock = new VirtualClock(0);
    const lease = await acquired(leases, clock);
    let lost = 0;
    lease.watch(() => (lost += 1));
    await lease.release();
    await clock.advance(TTL * 2);
    assert.equal(lost, 0);
    assert.equal(clock.pending, 0);
  });

  test('a renewal refused after release began is not a loss', async () => {
    const leases = new FakeLeases();
    let answer: ((held: boolean) => void) | undefined;
    leases.renewal = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const clock = new VirtualClock(0);
    const lease = await acquired(leases, clock);
    let lost = 0;
    lease.watch(() => (lost += 1));
    await clock.advance(TTL / 3);
    const releasing = lease.release();
    answer!(false);
    await releasing;
    assert.equal(lost, 0);
  });

  test('release swallows errors, waits at most the bound, and is idempotent', async () => {
    const failing = new FakeLeases();
    failing.releasing = () => Promise.reject(new Error('store down'));
    const lease = await acquired(failing, new VirtualClock(0));
    await lease.release();
    await lease.release();
    assert.equal(failing.count('release'), 1);

    const hanging = new FakeLeases();
    hanging.releasing = () => new Promise(() => undefined);
    const clock = new VirtualClock(0);
    const stuck = await acquireOverlapLease(hanging, { key: 'k', ttlMs: 60_000 }, clock);
    assert.ok(stuck !== 'held');
    let done = false;
    const releasing = stuck.release().then(() => {
      done = true;
    });
    await clock.advance(MAX_RELEASE_WAIT_MS - 1);
    assert.equal(done, false);
    await clock.advance(1);
    await releasing;
    assert.equal(done, true);
  });
});
