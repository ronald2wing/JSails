/**
 * In-memory notification store tests: records are scoped by notifiable, listed
 * newest first, marked read and unread, detached from the caller, and their
 * payload is validated as bounded JSON.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryNotificationStore, isNotificationStore } from '../src/store.js';
import { exerciseStore } from './fixtures.js';

describe('InMemoryNotificationStore', () => {
  it('meets the store contract', async () => {
    await exerciseStore(new InMemoryNotificationStore());
  });

  it('detaches stored data from the caller', async () => {
    const store = new InMemoryNotificationStore({ now: () => new Date(0) });
    const data = { nested: { n: 1 } };
    const created = await store.create({ notifiable: '1', type: 'a', data });
    data.nested.n = 2;
    (created.data.nested as { n: number }).n = 3;
    assert.deepEqual((await store.list('1'))[0]?.data, { nested: { n: 1 } });
    assert.equal(created.createdAt.getTime(), 0);
  });

  it('recognizes the store surface', () => {
    assert.equal(isNotificationStore(new InMemoryNotificationStore()), true);
    assert.equal(isNotificationStore({ create() {} }), false);
    assert.equal(isNotificationStore(null), false);
  });
});
