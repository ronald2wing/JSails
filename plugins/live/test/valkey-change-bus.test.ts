/**
 * Tests for the cross-instance change bus and stream tailer (LIVE-PLAN.md
 * Phase 7).
 *
 * The bus is a notification channel, not a transport: it says "the stream
 * advanced" and the tailer reads the changes from the stream. That split is
 * what makes a dropped notification cost latency rather than correctness, so
 * these tests assert both halves — the notification arrives, and the tailer
 * still catches up when it does not.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LiveChange } from 'jsails/live';

import { createFakeValkey } from './fake-valkey.js';
import { createStreamTailer, createValkeyChangeBus } from '../src/valkey-change-bus.js';
import { createValkeyChangeLog } from '../src/valkey-change-log.js';

const URL = 'redis://127.0.0.1:6379';

function change(id: string): LiveChange {
  return {
    sequence: 0,
    collection: 'Item',
    id,
    operation: 'update',
    row: { id: Number(id), name: `n${id}` },
    at: 1_700_000_000_000,
  };
}

describe('createValkeyChangeBus', () => {
  it('notifies a subscriber when another instance publishes', async () => {
    const fake = createFakeValkey();
    const first = await createValkeyChangeBus({
      valkeyUrl: URL,
      createClient: () => fake.busClient(),
    });
    const second = await createValkeyChangeBus({
      valkeyUrl: URL,
      createClient: () => fake.busClient(),
    });

    let notified = 0;
    second.onNotify(() => {
      notified += 1;
    });
    await first.publish();

    assert.equal(notified, 1);

    await first.close();
    await second.close();
  });

  it('stops notifying after close', async () => {
    const fake = createFakeValkey();
    const bus = await createValkeyChangeBus({
      valkeyUrl: URL,
      createClient: () => fake.busClient(),
    });
    let notified = 0;
    bus.onNotify(() => {
      notified += 1;
    });
    await bus.close();
    await bus.publish();
    assert.equal(notified, 0);
  });

  it('rejects an invalid URL without echoing it', async () => {
    await assert.rejects(
      () =>
        createValkeyChangeBus({
          valkeyUrl: 'not-a-url',
          createClient: () => {
            throw new Error('should not connect');
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('not-a-url'));
        return true;
      },
    );
  });
});

describe('createStreamTailer', () => {
  it('reads forward from its cursor and reports each change once', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      valkeyUrl: URL,
      createClient: () => fake.client(),
    });
    const seen: number[] = [];
    const tailer = createStreamTailer({
      client: fake.client(),
      streamKey: 'jsails:live:changes',
      onChanges: (changes) => {
        for (const entry of changes) {
          seen.push(entry.sequence);
        }
      },
      pollIntervalMs: 10_000,
    });

    await log.append(change('1'));
    await log.append(change('2'));
    await tailer.pump();
    await tailer.pump();

    // A second pump with no new entries must not re-deliver.
    assert.deepEqual(seen, [1, 2]);
    assert.equal(tailer.cursor, 2);

    tailer.close();
    await log.close();
  });

  it('delivers only entries after the cursor', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      valkeyUrl: URL,
      createClient: () => fake.client(),
    });
    const seen: number[] = [];
    const tailer = createStreamTailer({
      client: fake.client(),
      streamKey: 'jsails:live:changes',
      onChanges: (changes) => {
        for (const entry of changes) {
          seen.push(entry.sequence);
        }
      },
      pollIntervalMs: 10_000,
    });

    await log.append(change('1'));
    await tailer.pump();
    await log.append(change('2'));
    await tailer.pump();

    assert.deepEqual(seen, [1, 2]);

    tailer.close();
    await log.close();
  });

  it('reports truncated and jumps forward when the cursor was trimmed away', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      valkeyUrl: URL,
      maxChanges: 2,
      createClient: () => fake.client(),
    });
    const errors: string[] = [];
    const seen: number[] = [];
    const tailer = createStreamTailer({
      client: fake.client(),
      streamKey: 'jsails:live:changes',
      onChanges: (changes) => {
        for (const entry of changes) {
          seen.push(entry.sequence);
        }
      },
      onError: (error) => {
        errors.push(error.message);
      },
      pollIntervalMs: 10_000,
    });

    await log.append(change('1'));
    await tailer.pump();
    // Trim past the cursor: the tailer can no longer reconstruct what it missed.
    await log.append(change('2'));
    await log.append(change('3'));
    await log.append(change('4'));
    await tailer.pump();

    assert.ok(errors.some((message) => message.includes('trimmed')));
    assert.equal(tailer.cursor, 4);

    tailer.close();
    await log.close();
  });

  it('routes a read failure to onError without breaking later pumps', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      valkeyUrl: URL,
      createClient: () => fake.client(),
    });
    const errors: string[] = [];
    const seen: number[] = [];
    const tailer = createStreamTailer({
      client: fake.client(),
      streamKey: 'jsails:live:changes',
      onChanges: (changes) => {
        for (const entry of changes) {
          seen.push(entry.sequence);
        }
      },
      onError: (error) => {
        errors.push(error.message);
      },
      pollIntervalMs: 10_000,
    });

    await log.append(change('1'));
    fake.failNext = new Error('connection reset');
    await tailer.pump();
    assert.equal(errors.length, 1);

    // The chain survives the failure: the next pump still delivers.
    await tailer.pump();
    assert.deepEqual(seen, [1]);

    tailer.close();
    await log.close();
  });

  it('stops reading after close', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      valkeyUrl: URL,
      createClient: () => fake.client(),
    });
    const seen: number[] = [];
    const tailer = createStreamTailer({
      client: fake.client(),
      streamKey: 'jsails:live:changes',
      onChanges: (changes) => {
        for (const entry of changes) {
          seen.push(entry.sequence);
        }
      },
      pollIntervalMs: 10_000,
    });

    tailer.close();
    await log.append(change('1'));
    await tailer.pump();
    assert.deepEqual(seen, []);

    await log.close();
  });
});
