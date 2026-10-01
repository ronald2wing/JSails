/**
 * The Valkey stores against a real Valkey: the cache, lease and defined-cache
 * conformance cases, plus the server-side guarantees the fake can only model (`SET NX`
 * and the lease scripts racing across two connections, and `PX` expiry on the
 * server's clock).
 *
 * Opt-in: it runs only when `JSAILS_TEST_VALKEY` is `"1"` and `VALKEY_URL` is
 * set (the convention of the jobs and live packages); otherwise one skipped
 * test says so and nothing connects. The cache stage of
 * `npm run verify:integrations` runs this package that way. Every case uses
 * its own key prefix, so a shared server is not disturbed, and keys expire on
 * their own.
 */

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, test } from 'node:test';

import { createValkeyConnections, type ValkeyConnections } from 'jsails/plugin-sdk';
import {
  cacheStoreConformance,
  defineCacheConformance,
  leaseStoreConformance,
} from 'jsails/testing';

import { ValkeyCacheStore, ValkeyLeaseStore } from '../src/index.js';

const url = process.env.VALKEY_URL?.trim() ?? '';
const gated = process.env.JSAILS_TEST_VALKEY === '1' && url !== '';

/** Long enough for a round trip to fit well inside it on a loaded runner. */
const TTL_MS = 300;

let sequence = 0;

function connect(): ValkeyConnections {
  return createValkeyConnections(url, { appPrefix: 'jsails-cache-live', name: 'cache-live' });
}

function uniquePrefix(kind: string): string {
  sequence += 1;
  return `jsails-cache-live:${String(process.pid)}:${String(Date.now())}:${String(sequence)}:${kind}`;
}

const realTime = async (ms: number): Promise<void> => {
  await sleep(ms);
};

if (gated) {
  describe('ValkeyCacheStore on a live Valkey', () => {
    for (const entry of cacheStoreConformance(
      async () => {
        const connections = connect();
        const store = new ValkeyCacheStore({ connections, prefix: uniquePrefix('cache') });
        return {
          store,
          advance: realTime,
          close: async () => {
            await store.close();
            await connections.close();
          },
        };
      },
      { ttlMs: TTL_MS },
    )) {
      test(entry.name, () => entry.run());
    }

    it('admits one add of a key raced over two connections', async () => {
      const prefix = uniquePrefix('race');
      const [first, second] = [connect(), connect()];
      try {
        const stores = [first, second].map(
          (connections) => new ValkeyCacheStore({ connections, prefix }),
        );
        const results = await Promise.all(
          Array.from({ length: 40 }, (_unused, index) =>
            stores[index % 2]!.add('claim', String(index), 60_000),
          ),
        );
        assert.equal(results.filter(Boolean).length, 1);
      } finally {
        await first.close();
        await second.close();
      }
    });
  });

  describe('defineCache over the Valkey stores on a live Valkey', () => {
    for (const entry of defineCacheConformance(async () => {
      const connections = connect();
      const store = new ValkeyCacheStore({ connections, prefix: uniquePrefix('defined') });
      const leases = new ValkeyLeaseStore({
        connections,
        prefix: uniquePrefix('defined-lease'),
        onWarning: () => undefined,
      });
      return {
        store,
        leases,
        close: async () => {
          await leases.close();
          await store.close();
          await connections.close();
        },
      };
    })) {
      test(entry.name, () => entry.run());
    }
  });

  describe('ValkeyLeaseStore on a live Valkey', () => {
    for (const entry of leaseStoreConformance(
      async () => {
        const connections = connect();
        const store = new ValkeyLeaseStore({
          connections,
          prefix: uniquePrefix('lease'),
          onWarning: () => undefined,
        });
        return {
          store,
          advance: realTime,
          close: async () => {
            await store.close();
            await connections.close();
          },
        };
      },
      { ttlMs: TTL_MS },
    )) {
      test(entry.name, () => entry.run());
    }

    it('grants one lease of a key raced over two connections', async () => {
      const prefix = uniquePrefix('lease-race');
      const [first, second] = [connect(), connect()];
      try {
        const stores = [first, second].map(
          (connections) =>
            new ValkeyLeaseStore({ connections, prefix, onWarning: () => undefined }),
        );
        const leases = await Promise.all(
          Array.from({ length: 40 }, (_unused, index) => stores[index % 2]!.acquire('job', 60_000)),
        );
        const granted = leases.filter((lease) => lease !== null);
        assert.equal(granted.length, 1);
        assert.equal(await stores[1]!.release(granted[0]!), true);
      } finally {
        await first.close();
        await second.close();
      }
    });
  });
} else {
  test(
    'Valkey stores on a live Valkey',
    { skip: 'set JSAILS_TEST_VALKEY=1 and VALKEY_URL' },
    () => {},
  );
}
