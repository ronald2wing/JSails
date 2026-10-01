/**
 * The FIFO lock: permits, arrival order, the acquire timeout, and close.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FifoLock } from '../../src/engine/fifo-lock.js';

describe('FifoLock', () => {
  it('grants permits immediately while any are free', async () => {
    const lock = new FifoLock(2);
    await lock.acquire(0);
    await lock.acquire(0);
    assert.equal(lock.available, 0);
    lock.release();
    assert.equal(lock.available, 1);
  });

  it('hands permits to waiters in arrival order', async () => {
    const lock = new FifoLock(1);
    await lock.acquire(0);
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) => lock.acquire(0).then(() => order.push(n)));
    assert.equal(lock.waiting, 3);
    for (let index = 0; index < 3; index += 1) {
      lock.release();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(waiters);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('times a waiter out with acquire_timeout and leaves the queue intact', async () => {
    const lock = new FifoLock(1);
    await lock.acquire(0);
    const timedOut = lock.acquire(20);
    const patient = lock.acquire(0);
    await assert.rejects(timedOut, { code: 'acquire_timeout' });
    assert.equal(lock.waiting, 1);
    lock.release();
    await patient;
  });

  it('rejects waiters and later acquires with closed', async () => {
    const lock = new FifoLock(1);
    await lock.acquire(0);
    const waiting = lock.acquire(1000);
    lock.close();
    await assert.rejects(waiting, { code: 'closed' });
    await assert.rejects(lock.acquire(0), { code: 'closed' });
  });

  it('refuses fewer than one permit', () => {
    assert.throws(() => new FifoLock(0), RangeError);
  });
});
