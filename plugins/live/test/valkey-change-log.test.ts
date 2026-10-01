/**
 * Tests for the Valkey Streams change log (LIVE-PLAN.md Phase 7).
 *
 * The log is the multi-instance half of the {@link ChangeLog} contract: one
 * stream and one counter per deployment, so a sequence means the same thing on
 * every instance and a client can resume against any of them. These tests run
 * against {@link createFakeValkey}, which implements the atomic append script,
 * `XRANGE`, and `MAXLEN ~` trimming.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LiveChange } from 'jsails/live';

import { createFakeValkey } from './fake-valkey.js';
import {
  createValkeyChangeLog,
  parseEntries,
  readStreamSlice,
  ValkeyChangeLogError,
} from '../src/valkey-change-log.js';

const URL = 'redis://127.0.0.1:6379';

function change(overrides: Partial<LiveChange> = {}): LiveChange {
  return {
    sequence: 0,
    collection: 'Item',
    id: '1',
    operation: 'update',
    row: { id: 1, name: 'a' },
    at: 1_700_000_000_000,
    ...overrides,
  };
}

const makeError = (message: string) => new Error(message);

describe('createValkeyChangeLog', () => {
  it('assigns deployment-wide sequences from 1 and advances head', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      valkeyUrl: URL,
      createClient: () => fake.client(),
    });

    assert.equal(log.head, 0);
    assert.equal(await log.append(change()), 1);
    assert.equal(await log.append(change({ id: '2' })), 2);
    assert.equal(log.head, 2);

    await log.close();
  });

  it('shares one sequence across two logs over the same stream', async () => {
    const fake = createFakeValkey();
    const first = await createValkeyChangeLog({
      valkeyUrl: URL,
      createClient: () => fake.client(),
    });
    const second = await createValkeyChangeLog({
      valkeyUrl: URL,
      createClient: () => fake.client(),
    });

    assert.equal(await first.append(change()), 1);
    assert.equal(await second.append(change({ id: '2' })), 2);

    // Both instances read the same suffix: the sequence is deployment-wide, not
    // per-process, which is what makes cross-instance resume work.
    const slice = await second.since(1);
    assert.deepEqual(
      slice.changes.map((entry) => entry.sequence),
      [1, 2],
    );
    assert.equal(slice.truncated, false);

    await first.close();
    await second.close();
  });

  it('returns the changes at a sequence and later, inclusively', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      valkeyUrl: URL,
      createClient: () => fake.client(),
    });
    await log.append(change({ id: '1' }));
    await log.append(change({ id: '2' }));
    await log.append(change({ id: '3' }));

    const slice = await log.since(2);
    assert.deepEqual(
      slice.changes.map((entry) => entry.id),
      ['2', '3'],
    );
    assert.equal(slice.truncated, false);

    await log.close();
  });

  it('reports truncated when the requested sequence was trimmed away', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      valkeyUrl: URL,
      maxChanges: 2,
      createClient: () => fake.client(),
    });
    await log.append(change({ id: '1' }));
    await log.append(change({ id: '2' }));
    await log.append(change({ id: '3' }));

    // Sequence 1 is gone; the window starts at 2.
    const slice = await log.since(1);
    assert.equal(slice.truncated, true);
    assert.deepEqual(
      slice.changes.map((entry) => entry.sequence),
      [2, 3],
    );
    assert.ok(fake.trimmed > 0);

    await log.close();
  });

  it('drops a malformed entry instead of failing the whole read', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      valkeyUrl: URL,
      createClient: () => fake.client(),
    });
    await log.append(change({ id: '1' }));

    // A deployment fault: one bad write must not make every subscriber fail.
    const entries = fake.streams.get('jsails:live:changes');
    assert.ok(entries !== undefined);
    entries.push({ id: '2-0', fields: ['change', '{"not":"a change"}'] });
    await log.append(change({ id: '3' }));

    const slice = await log.since(1);
    assert.deepEqual(
      slice.changes.map((entry) => entry.id),
      ['1', '3'],
    );

    await log.close();
  });

  it('rejects an invalid URL without echoing it', async () => {
    await assert.rejects(
      () =>
        createValkeyChangeLog({
          valkeyUrl: 'http://example.com',
          createClient: () => {
            throw new Error('should not connect');
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ValkeyChangeLogError);
        assert.equal(error.code, 'invalid_url');
        assert.ok(!error.message.includes('example.com'));
        return true;
      },
    );
  });

  it('rejects a non-integer sequence', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      valkeyUrl: URL,
      createClient: () => fake.client(),
    });
    await assert.rejects(
      () => log.since(-1),
      (error: unknown) => {
        assert.ok(error instanceof ValkeyChangeLogError);
        assert.equal(error.code, 'invalid_sequence');
        return true;
      },
    );
    await log.close();
  });

  it('refuses to append after close', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      valkeyUrl: URL,
      createClient: () => fake.client(),
    });
    await log.close();
    await assert.rejects(
      () => log.append(change()),
      (error: unknown) => {
        assert.ok(error instanceof ValkeyChangeLogError);
        assert.equal(error.code, 'closed');
        return true;
      },
    );
  });

  it('surfaces a backend failure as unavailable without the payload', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      valkeyUrl: URL,
      createClient: () => fake.client(),
    });
    fake.failNext = new Error('connection reset by peer');
    await assert.rejects(
      () => log.append(change({ row: { secret: 'hunter2' } })),
      (error: unknown) => {
        assert.ok(error instanceof ValkeyChangeLogError);
        assert.equal(error.code, 'unavailable');
        assert.ok(!error.message.includes('hunter2'));
        return true;
      },
    );
    await log.close();
  });
});

describe('readStreamSlice', () => {
  it('treats an empty stream as truncated for a positive sequence', async () => {
    const fake = createFakeValkey();
    const slice = await readStreamSlice(fake.client(), 'jsails:live:changes', 5, makeError);
    assert.equal(slice.truncated, true);
    assert.deepEqual(slice.changes, []);
  });

  it('treats sequence 0 as never truncated', async () => {
    const fake = createFakeValkey();
    const slice = await readStreamSlice(fake.client(), 'jsails:live:changes', 0, makeError);
    assert.equal(slice.truncated, false);
  });
});

describe('parseEntries', () => {
  it('rejects a non-array stream shape', () => {
    assert.throws(() => parseEntries('nope', makeError), /unexpected stream shape/);
  });

  it('skips entries with no change field or a non-object payload', () => {
    const parsed = parseEntries(
      [
        ['1-0', ['other', 'x']],
        ['2-0', ['change', '[]']],
        ['3-0', ['change', 'null']],
        [
          '4-0',
          ['change', '{"collection":"Item","id":"1","operation":"update","row":null,"at":1}'],
        ],
      ],
      makeError,
    );
    assert.equal(parsed.length, 1);
    // The sequence comes from the stream id, not the payload.
    assert.equal(parsed[0]!.sequence, 4);
  });

  it('rejects an unknown operation', () => {
    const parsed = parseEntries(
      [
        [
          '1-0',
          ['change', '{"collection":"Item","id":"1","operation":"upsert","row":null,"at":1}'],
        ],
      ],
      makeError,
    );
    assert.deepEqual(parsed, []);
  });
});
