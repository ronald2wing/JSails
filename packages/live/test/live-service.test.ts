/**
 * Tests for the live service — the composition point of the live layer.
 *
 * `createLiveService` drives the snapshot (registry + publication query +
 * snapshot buffer), assigns publications' client-visible collections, routes the capture
 * flush through the change log, and fans out through drivers keyed by
 * `publication + params + identity`. These tests exercise the behaviour against a
 * real on-disk sql.js database wired to the service's `ingest` entry via
 * `dataSource.liveCapture`:
 *
 * - snapshot then change for insert / update / delete;
 * - a change committing during the snapshot query is delivered after it, on the
 *   local and the shared-log path alike, without stalling other subscribers;
 * - coalescing collapses two rapid writes to one row into one change;
 * - `maxRows` and authorization both gate the snapshot;
 * - resume replays changes when the log still covers the sequence and degrades
 *   to a full snapshot (`resumed: false`) when it does not;
 * - membership is per-row: a row that stops matching a scalar `where` is removed
 *   (`row: null`);
 * - fan-out reaches every matching subscription and is isolated by identity; and
 * - subscriptions sharing a key share one membership probe per change.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { qEq, query } from 'jsails/database';
import {
  createPublicationRegistry,
  definePublication,
  type LiveChange,
  type LiveServerMessage,
} from 'jsails/live';
import { Async } from 'jsails/support';
import { waitFor as waitForCondition } from 'jsails/testing';

import { createInMemoryChangeLog } from '../src/in-memory-change-log.js';
import { createLiveService, LiveDeliveryError } from '../src/live-service.js';
import {
  collectMessages,
  createItemDataSource,
  defineItemEntity,
  messageMatching,
  ITEM_FIELDS,
} from './fixtures.js';

const makeItem = () => defineItemEntity('ls_items');
const createDataSource = createItemDataSource;
const collector = collectMessages;
const waitFor = messageMatching;

const changesOnly = (messages: readonly LiveServerMessage[]) =>
  messages.filter((m): m is Extract<LiveServerMessage, { type: 'change' }> => m.type === 'change');

// ---------------------------------------------------------------------------
// createLiveService — snapshot, change, buffering, coalescing, resume, membership
// ---------------------------------------------------------------------------

describe('createLiveService', () => {
  it('delivers a snapshot then changes for insert, update, and delete', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.items',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item).orderBy('id', 'ASC'),
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 5,
    });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const { messages, sink } = collector();
    const handle = await service.subscribe({ publication: 'ls.items', params: {} }, sink);

    const snapshot = await waitFor(messages, (m) => m.type === 'snapshot');
    assert.equal(snapshot.type, 'snapshot');
    assert.equal(snapshot.rows.length, 0);

    const item = await Item.create({ name: 'alice', status: 'published' }).save();
    let change = await waitFor(messages, (m) => m.type === 'change' && rowName(m) === 'alice');
    assert.ok(change.type === 'change');
    assert.equal(change.collection, 'items');
    assert.equal(change.id, String(item.id));
    assert.equal(change.sequence, 1);
    assert.deepEqual((change as { row: unknown }).row, {
      id: item.id,
      name: 'alice',
      status: 'published',
      ownerId: null,
    });

    item.name = 'alice-updated';
    await item.save();
    change = await waitFor(messages, (m) => m.type === 'change' && rowName(m) === 'alice-updated');
    assert.ok(change.type === 'change');
    assert.equal(change.sequence, 2);

    const itemId = item.id;
    await item.remove();
    change = await waitFor(
      messages,
      (m) =>
        m.type === 'change' &&
        (m as { id: string }).id === String(itemId) &&
        (m as { row: unknown }).row === null,
    );
    assert.ok(change.type === 'change');
    assert.equal((change as { row: unknown }).row, null);

    await handle.close();
    await service.stop();
    await ds.destroy();
  });

  it('assigns the publication collection, not the entity name, to changes', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.renamed',
      collection: 'posts',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item),
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 5,
    });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const { messages, sink } = collector();
    await service.subscribe({ publication: 'ls.renamed', params: {} }, sink);
    await waitFor(messages, (m) => m.type === 'snapshot');

    await Item.create({ name: 'x', status: 'published' }).save();
    const change = await waitFor(messages, (m) => m.type === 'change');
    assert.equal((change as { collection: string }).collection, 'posts');
    // The provisional capture collection is the entity name 'LIVE_ITEM' (the
    // @Entity table name) — never the publication name; the service translates.
    assert.notEqual((change as { collection: string }).collection, 'ls.renamed');

    await service.stop();
    await ds.destroy();
  });

  it('delivers a change committing during the snapshot query after the snapshot', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const publication = definePublication({
      name: 'ls.gated',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => {
        const q = query(Item);
        // Slow the snapshot so a write can commit while it is in flight.
        const original = q.getMany.bind(q);
        q.getMany = async () => {
          await gate;
          return original();
        };
        return q;
      },
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 5,
    });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const { messages, sink } = collector();
    const pending = service.subscribe({ publication: 'ls.gated', params: {} }, sink);

    // Commit a write while the snapshot query is gated.
    await Item.create({ name: 'mid-snapshot', status: 'published' }).save();

    release();
    await pending;

    const first = await waitFor(messages, (m) => m.type === 'snapshot');
    assert.equal(first.type, 'snapshot');
    // The snapshot sequence reflects the log before the gated write committed.
    const change = await waitFor(messages, (m) => m.type === 'change');
    assert.equal(change.type, 'change');
    assert.equal(change.sequence, (first as { sequence: number }).sequence + 1);
    assert.ok(messages.indexOf(first) < messages.indexOf(change), 'snapshot precedes the change');

    await service.stop();
    await ds.destroy();
  });

  it('coalesces two rapid writes to one row into one change', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.coalesce',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item),
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 50,
    });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const { messages, sink } = collector();
    await service.subscribe({ publication: 'ls.coalesce', params: {} }, sink);
    await waitFor(messages, (m) => m.type === 'snapshot');

    const item = await Item.create({ name: 'first', status: 'published' }).save();
    item.name = 'second';
    await item.save();

    // Both writes land inside the 50 ms coalescing window; only the last survives.
    await Async.sleep(120);
    const changes = changesOnly(messages);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.row?.name, 'second');

    await service.stop();
    await ds.destroy();
  });

  it('delivers a batch in sequence order when a membership probe is slow', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.order',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item),
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 10,
    });
    await service.start();

    const { messages, sink } = collector();
    await service.subscribe({ publication: 'ls.order', params: {} }, sink);
    await waitFor(messages, (m) => m.type === 'snapshot');

    const first = await Item.create({ name: 'first', status: 'published' }).save();
    const second = await Item.create({ name: 'second', status: 'published' }).save();

    // Delay the first membership probe so an unserialized second delivery would
    // overtake it and the client would see sequence 2 before sequence 1.
    const builderProto = Object.getPrototypeOf(query(Item).builder);
    const realGetMany = builderProto.getMany;
    let probes = 0;
    builderProto.getMany = async function (this: unknown) {
      probes += 1;
      if (probes === 1) {
        await Async.sleep(120);
      }
      return realGetMany.call(this);
    };

    try {
      // One ingest call, two rows: `route` hands both changes to the driver
      // back-to-back, so a slow first probe is overtaken unless deliveries are
      // serialized per driver.
      const at = Date.now();
      const collection = Item.getRepository().metadata.name;
      await service.ingest([
        {
          sequence: 0,
          collection,
          id: String(first.id),
          operation: 'update',
          row: { id: first.id, name: 'first-updated', status: 'published', ownerId: null },
          at,
        },
        {
          sequence: 0,
          collection,
          id: String(second.id),
          operation: 'update',
          row: { id: second.id, name: 'second-updated', status: 'published', ownerId: null },
          at,
        },
      ]);

      await Async.sleep(400);
      const changes = changesOnly(messages);
      assert.equal(changes.length, 2);
      const sequences = changes.map((change) => change.sequence);
      assert.deepEqual(
        sequences,
        [...sequences].sort((a, b) => a - b),
      );
    } finally {
      builderProto.getMany = realGetMany;
    }

    await service.stop();
    await ds.destroy();
  });

  it('does not route locally when deliverLocally is false', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.remote',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item),
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const changeLog = createInMemoryChangeLog();
    const service = createLiveService({
      registry,
      changeLog,
      flushIntervalMs: 10,
      deliverLocally: false,
    });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const { messages, sink } = collector();
    await service.subscribe({ publication: 'ls.remote', params: {} }, sink);
    await waitFor(messages, (m) => m.type === 'snapshot');

    await Item.create({ name: 'written', status: 'published' }).save();
    await Async.sleep(200);

    // The change reached the log but was not fanned out: with a shared log the
    // tailer is the single delivery path, so routing here would race it.
    assert.equal(changesOnly(messages).length, 0);
    assert.equal(changeLog.head, 1);

    await service.stop();
    await ds.destroy();
  });

  it('delivers changes passed to applyRemote in the order given', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.apply',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item),
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      deliverLocally: false,
    });
    await service.start();

    const { messages, sink } = collector();
    await service.subscribe({ publication: 'ls.apply', params: {} }, sink);
    await waitFor(messages, (m) => m.type === 'snapshot');

    const item = await Item.create({ name: 'remote', status: 'published' }).save();
    const at = Date.now();
    const collection = Item.getRepository().metadata.name;

    // Two changes for one row, as a tailer would read them from a shared log.
    service.applyRemote([
      {
        sequence: 1,
        collection,
        id: String(item.id),
        operation: 'update',
        row: { id: item.id, name: 'remote', status: 'published', ownerId: null },
        at,
      },
      {
        sequence: 2,
        collection,
        id: String(item.id),
        operation: 'delete',
        row: null,
        at,
      },
    ]);

    await Async.sleep(200);
    const changes = changesOnly(messages);
    assert.deepEqual(
      changes.map((change) => change.sequence),
      [1, 2],
    );
    assert.equal(changes[1]!.row, null);

    await service.stop();
    await ds.destroy();
  });

  it('emits too_many_rows when the snapshot exceeds the row cap', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    await Item.create({ name: 'a', status: 'published' }).save();
    await Item.create({ name: 'b', status: 'published' }).save();
    await Item.create({ name: 'c', status: 'published' }).save();

    const publication = definePublication({
      name: 'ls.capped',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item),
      maxRows: 2,
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const service = createLiveService({ registry, changeLog: createInMemoryChangeLog() });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const { messages, sink } = collector();
    await service.subscribe({ publication: 'ls.capped', params: {} }, sink);

    const error = await waitFor(messages, (m) => m.type === 'error');
    assert.equal((error as { code: string }).code, 'too_many_rows');

    await service.stop();
    await ds.destroy();
  });

  it('denies an unauthorized subscribe and permits an authorized one', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const locked = definePublication({
      name: 'ls.locked',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => false,
      query: () => query(Item),
    });
    const open = definePublication({
      name: 'ls.open',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item),
    });

    const registry = createPublicationRegistry();
    registry.register(locked);
    registry.register(open);
    const service = createLiveService({ registry, changeLog: createInMemoryChangeLog() });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const denied = collector();
    await service.subscribe({ publication: 'ls.locked', params: {} }, denied.sink);
    const error = await waitFor(denied.messages, (m) => m.type === 'error');
    assert.equal((error as { code: string }).code, 'unauthorized');

    const allowed = collector();
    await service.subscribe({ publication: 'ls.open', params: {} }, allowed.sink);
    const snapshot = await waitFor(allowed.messages, (m) => m.type === 'snapshot');
    assert.equal(snapshot.type, 'snapshot');

    await service.stop();
    await ds.destroy();
  });

  it('resumes within the log window by replaying changes, not a snapshot', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.resume',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item),
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 5,
    });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const first = collector();
    const h1 = await service.subscribe({ publication: 'ls.resume', params: {} }, first.sink);
    const snap = await waitFor(first.messages, (m) => m.type === 'snapshot');
    const applied = (snap as { sequence: number }).sequence;

    await Item.create({ name: 'replayed', status: 'published' }).save();
    await waitFor(first.messages, (m) => m.type === 'change');
    await h1.close();

    // Resume from the snapshot sequence: the retained change is replayed.
    const second = collector();
    await service.subscribe(
      { publication: 'ls.resume', params: {}, resumeFrom: applied },
      second.sink,
    );

    const replayed = await waitFor(second.messages, (m) => m.type === 'change');
    assert.equal(replayed.type, 'change');
    assert.equal(rowName(replayed), 'replayed');
    assert.ok(
      second.messages.every((m) => m.type !== 'snapshot'),
      'a covered resume must not emit a snapshot',
    );

    await service.stop();
    await ds.destroy();
  });

  it('falls back to a snapshot with resumed: false when the window is lost', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.lost',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item),
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    // A two-entry log: three appends evict the first, so resequencing from 1
    // reports truncated and the service degrades to a full snapshot.
    const log = createInMemoryChangeLog({ maxChanges: 2 });
    const seed: LiveChange = {
      sequence: 0,
      collection: 'Item',
      id: 'x',
      operation: 'insert',
      row: null,
      at: 0,
    };
    await log.append(seed);
    await log.append(seed);
    await log.append(seed);

    const service = createLiveService({ registry, changeLog: log });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const { messages, sink } = collector();
    await service.subscribe({ publication: 'ls.lost', params: {}, resumeFrom: 1 }, sink);

    const snapshot = await waitFor(messages, (m) => m.type === 'snapshot');
    assert.equal(snapshot.type, 'snapshot');
    assert.equal((snapshot as { resumed: boolean }).resumed, false);

    await service.stop();
    await ds.destroy();
  });

  it('removes a row that stops matching a scalar where (row: null)', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.published',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item).where(qEq('status', 'published')),
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 5,
    });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const { messages, sink } = collector();
    await service.subscribe({ publication: 'ls.published', params: {} }, sink);
    await waitFor(messages, (m) => m.type === 'snapshot');

    const item = await Item.create({ name: 'posted', status: 'published' }).save();
    const inSet = await waitFor(messages, (m) => m.type === 'change' && rowName(m) === 'posted');
    assert.ok(inSet.type === 'change');
    assert.notEqual((inSet as { row: unknown }).row, null);

    item.status = 'draft';
    await item.save();
    const removed = await waitFor(
      messages,
      (m) =>
        m.type === 'change' && rowName(m) === null && (m as { id: string }).id === String(item.id),
    );
    assert.equal((removed as { row: unknown }).row, null);

    await service.stop();
    await ds.destroy();
  });

  it("never discloses a row that was not in the subscriber's set", async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.hidden',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item).where(qEq('status', 'published')),
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 5,
    });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const { messages, sink } = collector();
    await service.subscribe({ publication: 'ls.hidden', params: {} }, sink);
    await waitFor(messages, (m) => m.type === 'snapshot');

    // A draft is written and rewritten; it never matched the publication, so
    // the subscriber must not even learn its id.
    const draft = await Item.create({ name: 'secret', status: 'draft' }).save();
    draft.name = 'secret-edited';
    await draft.save();
    // A published row follows and is delivered, proving the fan-out ran.
    await Item.create({ name: 'visible', status: 'published' }).save();
    await waitFor(messages, (m) => m.type === 'change' && rowName(m) === 'visible');

    const ids = messages.filter((m) => m.type === 'change').map((m) => (m as { id: string }).id);
    assert.ok(!ids.includes(String(draft.id)), 'draft id must not be disclosed');

    await service.stop();
    await ds.destroy();
  });

  it('fans out to every subscriber and isolates by identity', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.scoped',
      collection: 'docs',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: (ctx) => {
        const owner = ctx.user ? String(ctx.user.id) : 'anonymous';
        return query(Item).where(qEq('ownerId', owner));
      },
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 5,
    });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const alice = collector();
    const bob = collector();
    await service.subscribe(
      { publication: 'ls.scoped', params: {}, user: { id: 'alice' } },
      alice.sink,
    );
    await service.subscribe(
      { publication: 'ls.scoped', params: {}, user: { id: 'bob' } },
      bob.sink,
    );
    await waitFor(alice.messages, (m) => m.type === 'snapshot');
    await waitFor(bob.messages, (m) => m.type === 'snapshot');

    await Item.create({ name: 'alice-doc', status: 'published', ownerId: 'alice' }).save();

    const aliceChange = await waitFor(alice.messages, (m) => m.type === 'change');
    assert.equal(rowName(aliceChange), 'alice-doc');
    assert.equal((aliceChange as { row: Record<string, unknown> }).row.ownerId, 'alice');

    // Bob's own row arrives, and nothing about Alice's — not even its id.
    await Item.create({ name: 'bob-doc', status: 'published', ownerId: 'bob' }).save();
    const bobChange = await waitFor(bob.messages, (m) => m.type === 'change');
    assert.equal(rowName(bobChange), 'bob-doc', "bob does not see alice's row");
    assert.ok(
      bob.messages.every((m) => m.type !== 'change' || rowName(m) === 'bob-doc'),
      "alice's row must not be mentioned to bob",
    );

    await service.stop();
    await ds.destroy();
  });
  it('shares one membership probe across subscriptions with the same key', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.shared',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({ status: z.string() }),
      authorize: () => true,
      query: (ctx) => query(Item).where(qEq('status', ctx.params.status)),
    });

    const registry = createPublicationRegistry();
    registry.register(publication);
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 5,
    });
    await service.start();

    const first = collector();
    const second = collector();
    const other = collector();
    const handle = await service.subscribe(
      { publication: 'ls.shared', params: { status: 'published' }, user: { id: 'u1' } },
      first.sink,
    );
    await service.subscribe(
      { publication: 'ls.shared', params: { status: 'published' }, user: { id: 'u1' } },
      second.sink,
    );
    await service.subscribe(
      { publication: 'ls.shared', params: { status: 'published' }, user: { id: 'u2' } },
      other.sink,
    );

    // Changes are ingested by hand (no capture listener) so every `getMany` the
    // counter sees is a membership probe, not the capture path's re-read.
    const collection = Item.getRepository().metadata.name;
    const ingestRow = async (name: string) => {
      const row = await Item.create({ name, status: 'published', ownerId: null }).save();
      // `save` reloads the row through a query builder; count only the fan-out.
      probes = 0;
      await service.ingest([
        {
          sequence: 0,
          collection,
          id: String(row.id),
          operation: 'insert',
          row: { id: row.id, name, status: 'published', ownerId: null },
          at: Date.now(),
        },
      ]);
    };

    const builderProto = Object.getPrototypeOf(query(Item).builder);
    const realGetMany = builderProto.getMany;
    let probes = 0;
    builderProto.getMany = async function (this: unknown) {
      probes += 1;
      return realGetMany.call(this);
    };

    try {
      await ingestRow('shared');
      const a = await waitFor(first.messages, (m) => m.type === 'change');
      const b = await waitFor(second.messages, (m) => m.type === 'change');
      await waitFor(other.messages, (m) => m.type === 'change');
      assert.equal(probes, 2, 'one probe per key (u1, u2), not one per subscription');
      assert.notEqual(a.subscriptionId, b.subscriptionId, 'each member keeps its own id');
      assert.equal(rowName(a), 'shared');
      assert.equal(rowName(b), 'shared');

      // A member leaving keeps the shared driver alive for the remaining one.
      await handle.close();
      const before = changesOnly(second.messages).length;
      await ingestRow('after-close');
      await waitFor(second.messages, () => changesOnly(second.messages).length > before);
      assert.equal(changesOnly(first.messages).length, 1, 'a closed member receives nothing');
    } finally {
      builderProto.getMany = realGetMany;
    }

    await service.stop();
    await ds.destroy();
  });

  it('sends only the allowlisted fields in snapshots and changes', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    await Item.create({ name: 'seed', status: 'published', ownerId: 'owner-1' }).save();
    const registry = createPublicationRegistry();
    registry.register(
      definePublication({
        name: 'ls.names',
        collection: 'items',
        fields: ['id', 'name'],
        params: z.object({}).strict(),
        authorize: () => true,
        query: () => query(Item),
      }),
    );
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 5,
    });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const { messages, sink } = collector();
    const handle = await service.subscribe({ publication: 'ls.names', params: {} }, sink);
    const snapshot = await waitFor(messages, (m) => m.type === 'snapshot');
    assert.ok(snapshot.type === 'snapshot');
    assert.deepEqual(Object.keys(snapshot.rows[0]!), ['id', 'name']);

    await Item.create({ name: 'fresh', status: 'draft', ownerId: 'owner-2' }).save();
    const change = await waitFor(messages, (m) => m.type === 'change' && rowName(m) === 'fresh');
    assert.deepEqual(Object.keys((change as { row: object }).row), ['id', 'name']);

    await handle.close();
    await service.stop();
    await ds.destroy();
  });

  it('fails a snapshot whose projected id does not match the primary key', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    await Item.create({ name: 'seed', status: 'published' }).save();
    const registry = createPublicationRegistry();
    registry.register(
      definePublication({
        name: 'ls.renamed',
        collection: 'items',
        params: z.object({}).strict(),
        authorize: () => true,
        query: () => query(Item),
        project: (row) => ({ id: `item-${String((row as { id: number }).id)}` }),
      }),
    );
    const service = createLiveService({ registry, changeLog: createInMemoryChangeLog() });
    await service.start();

    const { messages, sink } = collector();
    await service.subscribe({ publication: 'ls.renamed', params: {} }, sink);
    const error = await waitFor(messages, (m) => m.type === 'error');
    assert.equal((error as { code: string }).code, 'invalid_publication_projection');
    assert.equal(
      messages.some((m) => m.type === 'snapshot'),
      false,
    );

    await service.stop();
    await ds.destroy();
  });

  it('fails a subscription whose fields name no column of the entity', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const registry = createPublicationRegistry();
    registry.register(
      definePublication({
        name: 'ls.bad',
        collection: 'items',
        fields: ['id', 'passwordHash'],
        params: z.object({}).strict(),
        authorize: () => true,
        query: () => query(Item),
      }),
    );
    const service = createLiveService({ registry, changeLog: createInMemoryChangeLog() });
    await service.start();

    const { messages, sink } = collector();
    await service.subscribe({ publication: 'ls.bad', params: {} }, sink);
    const error = await waitFor(messages, (m) => m.type === 'error');
    assert.equal((error as { code: string }).code, 'invalid_publication_fields');
    assert.equal(
      messages.some((m) => m.type === 'snapshot'),
      false,
    );

    await service.stop();
    await ds.destroy();
  });

  it('delivers a remote change appended while a shared-log snapshot is in flight', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const seeded = await Item.create({ name: 'before', status: 'published' }).save();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const inQuery = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const publication = definePublication({
      name: 'ls.shared-gap',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => {
        const q = query(Item);
        const original = q.getMany.bind(q);
        q.getMany = async () => {
          // The query reads the table *before* the remote write lands.
          const rows = await original();
          entered();
          await gate;
          return rows;
        };
        return q;
      },
    });
    const registry = createPublicationRegistry();
    registry.register(publication);

    // A shared log whose cached head lags: another instance appended up to 4,
    // but this process has not appended anything itself.
    const inner = createInMemoryChangeLog();
    const collection = Item.getRepository().metadata.name;
    const filler: LiveChange = {
      sequence: 0,
      collection: 'Other',
      id: 'x',
      operation: 'insert',
      row: null,
      at: 0,
    };
    for (let index = 0; index < 4; index += 1) {
      await inner.append(filler);
    }
    const changeLog = {
      append: (change: LiveChange) => inner.append(change),
      since: (sequence: number) => inner.since(sequence),
      head: 0,
      readHead: async () => inner.head,
      close: () => inner.close(),
    };
    const service = createLiveService({ registry, changeLog, deliverLocally: false });
    await service.start();

    const { messages, sink } = collector();
    const pending = service.subscribe({ publication: 'ls.shared-gap', params: {} }, sink);
    await inQuery;

    // Another instance commits and its change is tailed in mid-snapshot. There
    // is no driver for this key yet, so before the buffer it was dropped.
    seeded.name = 'after';
    await seeded.save();
    const sequence = await inner.append({
      sequence: 0,
      collection,
      id: String(seeded.id),
      operation: 'update',
      row: { id: seeded.id, name: 'after', status: 'published', ownerId: null },
      at: Date.now(),
    });
    service.applyRemote([
      {
        sequence,
        collection,
        id: String(seeded.id),
        operation: 'update',
        row: { id: seeded.id, name: 'after', status: 'published', ownerId: null },
        at: Date.now(),
      },
    ]);
    release();
    await pending;

    const snapshot = await waitFor(messages, (m) => m.type === 'snapshot');
    assert.ok(snapshot.type === 'snapshot');
    assert.equal(snapshot.rows[0]?.['name'], 'before', 'the snapshot predates the write');
    // The watermark is the real head, not the stale cached 0.
    assert.equal(snapshot.sequence, 4);
    const change = await waitFor(messages, (m) => m.type === 'change');
    assert.ok(change.type === 'change');
    assert.equal(change.sequence, 5);
    assert.equal(rowName(change), 'after');
    assert.ok(change.sequence > snapshot.sequence, 'a client watermark keeps the change');

    await service.stop();
    await ds.destroy();
  });

  it('keeps delivering to other subscribers while a snapshot is slow', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = createPublicationRegistry();
    registry.register(
      definePublication({
        name: 'ls.fast',
        collection: 'items',
        fields: ITEM_FIELDS,
        params: z.object({}).strict(),
        authorize: () => true,
        query: () => query(Item),
      }),
    );
    registry.register(
      definePublication({
        name: 'ls.slow',
        collection: 'items',
        fields: ITEM_FIELDS,
        params: z.object({}).strict(),
        authorize: () => true,
        query: () => {
          const q = query(Item);
          const original = q.getMany.bind(q);
          q.getMany = async () => {
            await gate;
            return original();
          };
          return q;
        },
      }),
    );
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 5,
    });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const fast = collector();
    await service.subscribe({ publication: 'ls.fast', params: {} }, fast.sink);
    const slow = collector();
    const pending = service.subscribe({ publication: 'ls.slow', params: {} }, slow.sink);

    try {
      // With one service-wide fence the open slow snapshot held this change
      // back from every subscriber until it finished.
      await Item.create({ name: 'unblocked', status: 'published' }).save();
      const change = await waitFor(fast.messages, (m) => m.type === 'change');
      assert.equal(rowName(change), 'unblocked');
      assert.equal(slow.messages.length, 0);
    } finally {
      release();
      await pending;
    }
    await waitFor(slow.messages, (m) => m.type === 'snapshot');

    await service.stop();
    await ds.destroy();
  });

  it('applies the row cap in the query instead of loading every row', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    for (let index = 0; index < 6; index += 1) {
      await Item.create({ name: `row-${index}`, status: 'published' }).save();
    }
    const registry = createPublicationRegistry();
    registry.register(
      definePublication({
        name: 'ls.capped-query',
        collection: 'items',
        fields: ITEM_FIELDS,
        params: z.object({}).strict(),
        authorize: () => true,
        query: () => query(Item),
        maxRows: 2,
      }),
    );
    const service = createLiveService({ registry, changeLog: createInMemoryChangeLog() });
    await service.start();

    const builderProto = Object.getPrototypeOf(query(Item).builder);
    const realGetMany = builderProto.getMany;
    const loaded: number[] = [];
    builderProto.getMany = async function (this: unknown) {
      const rows = (await realGetMany.call(this)) as unknown[];
      loaded.push(rows.length);
      return rows;
    };
    try {
      const { messages, sink } = collector();
      await service.subscribe({ publication: 'ls.capped-query', params: {} }, sink);
      const error = await waitFor(messages, (m) => m.type === 'error');
      assert.equal((error as { code: string }).code, 'too_many_rows');
      // One row past the cap proves the overflow; the other three never load.
      assert.deepEqual(loaded, [3]);
    } finally {
      builderProto.getMany = realGetMany;
    }

    await service.stop();
    await ds.destroy();
  });

  it('probes a resume replay in one batched query, newest change per row', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const registry = createPublicationRegistry();
    registry.register(
      definePublication({
        name: 'ls.resume-batch',
        collection: 'items',
        fields: ITEM_FIELDS,
        params: z.object({}).strict(),
        authorize: () => true,
        query: () => query(Item),
      }),
    );
    const changeLog = createInMemoryChangeLog();
    const service = createLiveService({ registry, changeLog, flushIntervalMs: 5 });
    await service.start();
    ds.liveCapture.setListener((changes) => service.ingest(changes));

    const first = collector();
    const handle = await service.subscribe(
      { publication: 'ls.resume-batch', params: {} },
      first.sink,
    );
    const snapshot = await waitFor(first.messages, (m) => m.type === 'snapshot');
    const items = [];
    for (let index = 0; index < 5; index += 1) {
      items.push(await Item.create({ name: `item-${index}`, status: 'published' }).save());
      await waitFor(first.messages, () => changesOnly(first.messages).length === index + 1);
    }
    const renamed = items[0]!;
    renamed.name = 'item-0-renamed';
    await renamed.save();
    await waitFor(first.messages, () => changesOnly(first.messages).length === 6);
    await handle.close();

    const builderProto = Object.getPrototypeOf(query(Item).builder);
    const realGetMany = builderProto.getMany;
    let queries = 0;
    builderProto.getMany = async function (this: unknown) {
      queries += 1;
      return realGetMany.call(this);
    };
    try {
      const second = collector();
      await service.subscribe(
        {
          publication: 'ls.resume-batch',
          params: {},
          resumeFrom: (snapshot as { sequence: number }).sequence,
        },
        second.sink,
      );
      // One member load plus one batched probe, not one probe per change.
      assert.equal(queries, 2);
      const replayed = changesOnly(second.messages);
      assert.equal(replayed.length, 5, 'one replayed change per row');
      assert.ok(second.messages.every((m) => m.type !== 'snapshot'));
      const sequences = replayed.map((change) => change.sequence);
      assert.deepEqual(
        sequences,
        [...sequences].sort((a, b) => a - b),
      );
      assert.equal(
        replayed.find((change) => change.id === String(renamed.id))?.row?.['name'],
        'item-0-renamed',
      );
    } finally {
      builderProto.getMany = realGetMany;
    }

    await service.stop();
    await ds.destroy();
  });

  it('bounds how many drivers probe at once', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const registry = createPublicationRegistry();
    registry.register(
      definePublication({
        name: 'ls.per-owner',
        collection: 'items',
        fields: ITEM_FIELDS,
        params: z.object({ owner: z.string() }),
        authorize: () => true,
        query: () => query(Item).where(qEq('status', 'published')).orderBy('id', 'ASC'),
      }),
    );
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 5,
      maxConcurrentProbes: 2,
    });
    await service.start();

    const sinks = Array.from({ length: 6 }, () => collector());
    for (const [index, entry] of sinks.entries()) {
      await service.subscribe(
        { publication: 'ls.per-owner', params: { owner: `owner-${index}` } },
        entry.sink,
      );
    }

    const builderProto = Object.getPrototypeOf(query(Item).builder);
    const realGetMany = builderProto.getMany;
    let inFlight = 0;
    let peak = 0;
    builderProto.getMany = async function (this: unknown) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await Async.sleep(20);
        return await realGetMany.call(this);
      } finally {
        inFlight -= 1;
      }
    };
    try {
      const row = await Item.create({ name: 'fan', status: 'published' }).save();
      await service.ingest([
        {
          sequence: 0,
          collection: Item.getRepository().metadata.name,
          id: String(row.id),
          operation: 'insert',
          row: { id: row.id, name: 'fan', status: 'published', ownerId: null },
          at: Date.now(),
        },
      ]);
      for (const entry of sinks) {
        await waitFor(entry.messages, (m) => m.type === 'change');
      }
      assert.equal(peak, 2, 'six drivers, at most two probes in flight');
    } finally {
      builderProto.getMany = realGetMany;
    }

    await service.stop();
    await ds.destroy();
  });

  it('reports a failed membership probe as a value-free delivery error', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const registry = createPublicationRegistry();
    registry.register(
      definePublication({
        name: 'ls.failing',
        collection: 'items',
        fields: ITEM_FIELDS,
        params: z.object({}).strict(),
        authorize: () => true,
        query: () => query(Item),
      }),
    );
    const errors: unknown[] = [];
    const service = createLiveService({
      registry,
      changeLog: createInMemoryChangeLog(),
      flushIntervalMs: 5,
      onError: (error) => errors.push(error),
    });
    await service.start();
    const { sink } = collector();
    await service.subscribe({ publication: 'ls.failing', params: {} }, sink);

    const builderProto = Object.getPrototypeOf(query(Item).builder);
    const realGetMany = builderProto.getMany;
    builderProto.getMany = async function () {
      throw new Error('pool timeout SELECT secret');
    };
    try {
      await service.ingest([
        {
          sequence: 0,
          collection: Item.getRepository().metadata.name,
          id: '1',
          operation: 'insert',
          row: { id: 1, name: 'x', status: 'published', ownerId: null },
          at: Date.now(),
        },
      ]);
      await waitForCondition(() => errors.length === 1);
    } finally {
      builderProto.getMany = realGetMany;
    }
    const [error] = errors;
    assert.ok(error instanceof LiveDeliveryError);
    assert.equal(error.code, 'io_failed');
    assert.doesNotMatch(error.message, /secret/);

    await service.stop();
    await ds.destroy();
  });
});

/** Extract the `name` column from a change's row, or null. */
function rowName(message: LiveServerMessage): unknown {
  if (message.type !== 'change') {
    return null;
  }
  const row = message.row as { name?: string } | null;
  return row ? row.name : null;
}
