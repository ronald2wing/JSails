/**
 * Tests for the Valkey Streams change log (docs/design/live.md §13.2).
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
  STREAM_PAGE_SIZE,
  ValkeyChangeLogError,
} from '../src/valkey-change-log.js';

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

describe('createValkeyChangeLog', () => {
  it('assigns deployment-wide sequences from 1 and advances head', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      connections: fake.connections(),
    });

    assert.equal(log.head, 0);
    assert.equal(await log.append(change()), 1);
    assert.equal(await log.append(change({ id: '2' })), 2);
    assert.equal(log.head, 2);

    await log.close();
  });

  it('reads the deployment-wide head that another instance advanced', async () => {
    const fake = createFakeValkey();
    const local = await createValkeyChangeLog({
      connections: fake.connections(),
    });
    const other = await createValkeyChangeLog({
      connections: fake.connections(),
    });

    await other.append(change());
    await other.append(change({ id: '2' }));
    // The cached head only moves on local appends; readHead goes to the counter.
    assert.equal(local.head, 0);
    assert.equal(await local.readHead(), 2);
    assert.equal(local.head, 2);

    await local.close();
    await other.close();
  });

  it('shares one sequence across two logs over the same stream', async () => {
    const fake = createFakeValkey();
    const first = await createValkeyChangeLog({
      connections: fake.connections(),
    });
    const second = await createValkeyChangeLog({
      connections: fake.connections(),
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
      connections: fake.connections(),
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
      connections: fake.connections(),
      maxChanges: 2,
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
      connections: fake.connections(),
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

  it('fails unavailable, without echoing the URL, when Valkey refuses the connection', async () => {
    const fake = createFakeValkey();
    fake.refuseConnect = new Error('connect ECONNREFUSED redis://user:secret@valkey.internal:6379');
    const connections = fake.connections();
    await assert.rejects(
      () => createValkeyChangeLog({ connections }),
      (error: unknown) => {
        assert.ok(error instanceof ValkeyChangeLogError);
        assert.equal(error.code, 'unavailable');
        assert.ok(!error.message.includes('secret'));
        assert.ok(!error.message.includes('valkey.internal'));
        return true;
      },
    );
    await connections.close();
  });

  it('rejects a non-integer sequence', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      connections: fake.connections(),
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
      connections: fake.connections(),
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
      connections: fake.connections(),
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
    const slice = await readStreamSlice(fake.client(), 'jsails:live:changes', 5);
    assert.equal(slice.truncated, true);
    assert.deepEqual(slice.changes, []);
  });

  it('reads forward from the sequence instead of the whole window', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({ connections: fake.connections() });
    for (let index = 1; index <= 10; index += 1) {
      await log.append(change({ id: String(index) }));
    }
    fake.xranges.length = 0;

    const slice = await readStreamSlice(fake.client(), 'jsails:live:changes', 9);
    assert.deepEqual(
      slice.changes.map((entry) => entry.sequence),
      [9, 10],
    );
    assert.equal(slice.truncated, false);
    // One bounded forward read; nothing scans from the start of the stream.
    assert.deepEqual(fake.xranges, [['9-0', '+', STREAM_PAGE_SIZE]]);

    await log.close();
  });

  it('pages through a suffix longer than one read', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({
      connections: fake.connections(),
      maxChanges: STREAM_PAGE_SIZE * 3,
    });
    for (let index = 1; index <= STREAM_PAGE_SIZE + 5; index += 1) {
      await log.append(change({ id: String(index) }));
    }

    const slice = await readStreamSlice(fake.client(), 'jsails:live:changes', 1);
    assert.equal(slice.changes.length, STREAM_PAGE_SIZE + 5);
    assert.equal(slice.changes.at(-1)?.sequence, STREAM_PAGE_SIZE + 5);

    await log.close();
  });

  it('is truncated when the sequence is past the head of a non-empty stream', async () => {
    const fake = createFakeValkey();
    const log = await createValkeyChangeLog({ connections: fake.connections() });
    await log.append(change());
    // A client presenting a sequence the counter never reached (a reset
    // counter, another deployment) cannot be continued: it needs a snapshot.
    const ahead = await readStreamSlice(fake.client(), 'jsails:live:changes', 500);
    assert.equal(ahead.truncated, true);
    assert.deepEqual(ahead.changes, []);
    // At the head itself the window still covers the client.
    const atHead = await log.since(1);
    assert.equal(atHead.truncated, false);
    assert.deepEqual(
      atHead.changes.map((entry) => entry.sequence),
      [1],
    );
    await log.close();
  });

  it('treats sequence 0 as never truncated', async () => {
    const fake = createFakeValkey();
    const slice = await readStreamSlice(fake.client(), 'jsails:live:changes', 0);
    assert.equal(slice.truncated, false);
  });
});

describe('parseEntries', () => {
  it('rejects a non-array stream shape', () => {
    assert.throws(() => parseEntries('nope'), /unexpected stream shape/);
  });

  it('skips entries with no change field or a non-object payload', () => {
    const parsed = parseEntries([
      ['1-0', ['other', 'x']],
      ['2-0', ['change', '[]']],
      ['3-0', ['change', 'null']],
      ['4-0', ['change', '{"collection":"Item","id":"1","operation":"update","row":null,"at":1}']],
    ]);
    assert.equal(parsed.length, 1);
    // The sequence comes from the stream id, not the payload.
    assert.equal(parsed[0]!.sequence, 4);
  });

  it('rejects an unknown operation', () => {
    const parsed = parseEntries([
      ['1-0', ['change', '{"collection":"Item","id":"1","operation":"upsert","row":null,"at":1}']],
    ]);
    assert.deepEqual(parsed, []);
  });
});
