/**
 * Tests for the two-instance live harness: a write captured by either instance
 * reaches subscribers on both through the one shared stream, with one
 * deployment-wide sequence, and the capture routes to the chosen writer only.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openClient, subscribe } from './fixtures.js';
import { startTwoInstanceLive } from './two-instance-live.js';

describe('startTwoInstanceLive', () => {
  it('delivers a write made through either instance to subscribers on both', async () => {
    const pair = await startTwoInstanceLive({ table: 'live_pair_harness' });
    const onA = await openClient(pair.a.port);
    const onB = await openClient(pair.b.port);
    try {
      assert.notEqual(pair.a.port, pair.b.port);
      for (const client of [onA, onB]) {
        assert.deepEqual(await subscribe(client.socket, 'live.items'), { ok: true });
        await client.next((m) => m.type === 'snapshot');
      }

      const first = await pair.Item.create({ name: 'from a', status: 'published' }).save();
      for (const client of [onA, onB]) {
        const change = await client.next((m) => m.type === 'change' && m.sequence === 1);
        assert.ok(change.type === 'change');
        assert.equal(change.id, String(first.id));
      }

      pair.writeThrough('b');
      const second = await pair.Item.create({ name: 'from b', status: 'published' }).save();
      for (const client of [onA, onB]) {
        const change = await client.next((m) => m.type === 'change' && m.sequence === 2);
        assert.ok(change.type === 'change');
        assert.equal(change.id, String(second.id));
      }

      // Each write was appended once, by its writer, to the one shared stream.
      assert.equal(pair.valkey.streams.get(`${pair.prefix}:changes`)?.length, 2);
      assert.equal(pair.valkey.counters.get(`${pair.prefix}:sequence`), 2);
    } finally {
      onA.socket.close();
      onB.socket.close();
      await pair.close();
    }
  });
});
