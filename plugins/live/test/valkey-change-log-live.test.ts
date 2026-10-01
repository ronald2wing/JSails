/**
 * Live Valkey integration test for the change log, bus, and tailer.
 *
 * Opt-in, env-gated: it runs only when `JSAILS_TEST_VALKEY` is `"1"` and
 * `VALKEY_URL` is set. When the gate is unset the suite is reported skipped and
 * no network is touched — the default unit suite (which fakes the client) is
 * unaffected. The server under test is the Valkey backing service Jamal
 * provisions (`jamal up` with `valkey: { type: 'valkey' }`).
 *
 * Env contract:
 *   JSAILS_TEST_VALKEY   "1" to enable
 *   VALKEY_URL           redis://127.0.0.1:6379
 *
 * Every test uses a unique key prefix and deletes it afterwards, so a shared
 * development server is not polluted and parallel runs do not collide.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LiveChange } from 'jsails/live';

import { createStreamTailer, createValkeyChangeBus } from '../src/valkey-change-bus.js';
import { createValkeyChangeLog } from '../src/valkey-change-log.js';

function read(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function gated(): boolean {
  return read('JSAILS_TEST_VALKEY') === '1' && read('VALKEY_URL') !== undefined;
}

const url = read('VALKEY_URL') ?? '';

/** A prefix unique to this run, so a shared server is not polluted. */
function uniquePrefix(): string {
  return `jsails:live:test:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function change(id: string): LiveChange {
  return {
    sequence: 0,
    collection: 'Item',
    id,
    operation: 'update',
    row: { id: Number(id), name: `n${id}` },
    at: Date.now(),
  };
}

/** Delete the keys a test created. */
async function cleanup(prefix: string): Promise<void> {
  const { Redis } = await import('ioredis');
  const client = new Redis(url, { maxRetriesPerRequest: 3 });
  try {
    await client.del(`${prefix}:sequence`, `${prefix}:changes`);
  } finally {
    client.disconnect();
  }
}

describe('valkey change log (live)', { skip: !gated() }, () => {
  it('round-trips a change through a real stream', async () => {
    const prefix = uniquePrefix();
    const log = await createValkeyChangeLog({ valkeyUrl: url, prefix });
    try {
      const sequence = await log.append(change('1'));
      assert.equal(sequence, 1);
      assert.equal(log.head, 1);

      const slice = await log.since(1);
      assert.equal(slice.truncated, false);
      assert.equal(slice.changes.length, 1);
      assert.equal(slice.changes[0]!.id, '1');
      assert.equal(slice.changes[0]!.sequence, 1);
      assert.deepEqual(slice.changes[0]!.row, { id: 1, name: 'n1' });
    } finally {
      await log.close();
      await cleanup(prefix);
    }
  });

  it('shares one sequence across two connections', async () => {
    const prefix = uniquePrefix();
    const first = await createValkeyChangeLog({ valkeyUrl: url, prefix });
    const second = await createValkeyChangeLog({ valkeyUrl: url, prefix });
    try {
      assert.equal(await first.append(change('1')), 1);
      assert.equal(await second.append(change('2')), 2);

      const slice = await second.since(1);
      assert.deepEqual(
        slice.changes.map((entry) => entry.sequence),
        [1, 2],
      );
    } finally {
      await first.close();
      await second.close();
      await cleanup(prefix);
    }
  });

  it('notifies across connections and the tailer reads the stream', async () => {
    const prefix = uniquePrefix();
    const log = await createValkeyChangeLog({ valkeyUrl: url, prefix });
    const bus = await createValkeyChangeBus({ valkeyUrl: url, prefix });
    const { Redis } = await import('ioredis');
    const reader = new Redis(url, { maxRetriesPerRequest: 3 });
    const seen: number[] = [];
    const tailer = createStreamTailer({
      client: reader as unknown as Parameters<typeof createStreamTailer>[0]['client'],
      streamKey: `${prefix}:changes`,
      onChanges: (changes) => {
        for (const entry of changes) {
          seen.push(entry.sequence);
        }
      },
      pollIntervalMs: 10_000,
    });

    try {
      let notified = 0;
      bus.onNotify(() => {
        notified += 1;
      });

      await log.append(change('1'));
      await bus.publish();
      await tailer.pump();

      assert.equal(notified, 1);
      assert.deepEqual(seen, [1]);
    } finally {
      tailer.close();
      reader.disconnect();
      await bus.close();
      await log.close();
      await cleanup(prefix);
    }
  });
});
