/**
 * Tests for the in-memory lock table: re-entrant acquisition, waiting for the
 * holder to end, release, deadlock refusal across a chain of waiters, the
 * wait timeout, and unambiguous lock keys.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lockKey, TransactionLocks, type LockHolder } from '../src/transaction-locks.js';
import { rejectedCode } from './thrown-code.js';

interface TestHolder extends LockHolder {
  finish(): void;
}

function holder(locks: TransactionLocks): TestHolder {
  let end: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const self: TestHolder = {
    ended,
    waitingFor: null,
    finish() {
      locks.releaseAll(self);
      end();
    },
  };
  return self;
}

describe('TransactionLocks', () => {
  it('is re-entrant and makes others wait until the holder ends', async () => {
    const locks = new TransactionLocks(1000);
    const a = holder(locks);
    const b = holder(locks);
    await locks.acquire(a, 'k');
    await locks.acquire(a, 'k');
    let acquired = false;
    const waiting = locks.acquire(b, 'k').then(() => {
      acquired = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(acquired, false);
    assert.equal(b.waitingFor, a);
    a.finish();
    await waiting;
    assert.equal(acquired, true);
    assert.equal(b.waitingFor, null);
  });

  it('refuses a wait that closes a cycle, through a chain of waiters', async () => {
    const locks = new TransactionLocks(1000);
    const a = holder(locks);
    const b = holder(locks);
    const c = holder(locks);
    await locks.acquire(a, 'a');
    await locks.acquire(b, 'b');
    await locks.acquire(c, 'c');
    const aWaits = locks.acquire(a, 'b');
    const bWaits = locks.acquire(b, 'c');
    assert.equal(await rejectedCode(locks.acquire(c, 'a')), 'transaction_conflict');
    c.finish();
    await bWaits;
    b.finish();
    await aWaits;
    a.finish();
  });

  it('times a wait out', async () => {
    const locks = new TransactionLocks(10);
    const a = holder(locks);
    const b = holder(locks);
    await locks.acquire(a, 'k');
    assert.equal(await rejectedCode(locks.acquire(b, 'k')), 'transaction_conflict');
    assert.equal(b.waitingFor, null);
    a.finish();
  });

  it('builds keys that cannot collide across parts', () => {
    assert.notEqual(lockKey('memberships', 1, 'a,b'), lockKey('memberships', '1,a', 'b'));
    assert.notEqual(lockKey('tenants', 1), lockKey('tenants', '1'));
  });
});
