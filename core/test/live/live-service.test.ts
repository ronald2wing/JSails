/**
 * Tests for the live service — the composition point of the live layer.
 *
 * `createLiveService` drives the snapshot (registry + publication query + write
 * fence), assigns publications' client-visible collections, routes the capture
 * flush through the change log, and fan-outs keyed by `publication + params +
 * identity` (LIVE-PLAN.md Phase 5). These tests exercise the behaviour against a
 * real on-disk sql.js database wired to the service's `ingest` entry via
 * `dataSource.liveCapture`:
 *
 * - snapshot then change for insert / update / delete;
 * - a change committing during the snapshot query is delivered after it (fence);
 * - coalescing collapses two rapid writes to one row into one change;
 * - `maxRows` and authorization both gate the snapshot;
 * - resume replays changes when the log still covers the sequence and degrades
 *   to a full snapshot (`resumed: false`) when it does not;
 * - membership is per-row: a row that stops matching a scalar `where` is removed
 *   (`row: null`);
 * - fan-out reaches every matching subscription and is isolated by identity; and
 * - `assertPublicationShape` rejects `limit`/`offset`/relation/`apply` shapes.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { z } from 'zod';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { JsailsDataSource } from '../../src/database/data-source.js';
import { query } from '../../src/database/model-query.js';
import { qEq } from '../../src/database/query-expressions.js';
import { diffSchemaStates } from '../../src/migrations/autodetector.js';
import { executeSchemaPlan } from '../../src/migrations/schema-executor.js';
import type { LiveChange } from '../../src/live/change-record.js';
import { createInMemoryChangeLog } from '../../src/live/change-log.js';
import {
  assertPublicationShape,
  createLiveService,
  PublicationShapeError,
  type LiveServerMessage,
} from '../../src/live/live-service.js';
import { definePublication } from '../../src/live/publication.js';
import { createPublicationRegistry } from '../../src/live/publication-registry.js';
import { Async } from '../../src/support/async.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'jsails-live-service-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeItem() {
  @Entity('ls_items')
  class Item extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;

    @Column({ type: 'varchar', length: 20, nullable: false, default: 'draft' })
    status!: string;

    @Column({ type: 'varchar', length: 40, nullable: true })
    ownerId!: string | null;
  }
  return Item;
}

let locationSeq = 0;

async function createDataSource(Item: ReturnType<typeof makeItem>): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `db-${locationSeq++}.sqlite`);
  const dataSource = new JsailsDataSource({ type: 'sqljs', location, entities: [Item] });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  await executeSchemaPlan(dataSource, diffSchemaStates({ tables: [] }, schema));
  return dataSource;
}

/** Collect messages from a subscription sink. */
function collector() {
  const messages: LiveServerMessage[] = [];
  return { messages, sink: (message: LiveServerMessage) => messages.push(message) };
}

/** Await the first message satisfying `predicate`, or throw after the budget. */
async function waitFor(
  messages: readonly LiveServerMessage[],
  predicate: (message: LiveServerMessage) => boolean,
  budgetMs = 2000,
): Promise<LiveServerMessage> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = messages.find(predicate);
    if (found) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a live message');
    }
    await Async.sleep(5);
  }
}

const changesOnly = (messages: readonly LiveServerMessage[]) =>
  messages.filter((m): m is Extract<LiveServerMessage, { type: 'change' }> => m.type === 'change');

// ---------------------------------------------------------------------------
// assertPublicationShape — the §4.2a shape guard (unit, no database)
// ---------------------------------------------------------------------------

/** A minimal ModelQuery shape sufficient for the guard; the private fields are irrelevant. */
function fakeQuery(
  expressionMap: {
    limit?: number;
    offset?: number;
    wheres?: ReadonlyArray<{ condition: unknown }>;
  },
  applied = false,
): Parameters<typeof assertPublicationShape>[0] {
  return {
    builder: {
      expressionMap: { limit: undefined, offset: undefined, wheres: [], ...expressionMap },
    },
    applied,
  } as unknown as Parameters<typeof assertPublicationShape>[0];
}

describe('assertPublicationShape', () => {
  it('accepts a scalar-where query with no limit/offset/relation/apply', () => {
    assert.doesNotThrow(() =>
      assertPublicationShape(fakeQuery({ wheres: [{ condition: 'entity_.status = ?' }] })),
    );
  });

  it('rejects a limit with unsupported_limit (expressionMap.limit, not take)', () => {
    assert.throws(
      () => assertPublicationShape(fakeQuery({ limit: 20 })),
      (error: unknown) =>
        error instanceof PublicationShapeError && error.code === 'unsupported_limit',
    );
  });

  it('rejects an offset with unsupported_offset (expressionMap.offset, not skip)', () => {
    assert.throws(
      () => assertPublicationShape(fakeQuery({ offset: 10 })),
      (error: unknown) =>
        error instanceof PublicationShapeError && error.code === 'unsupported_offset',
    );
  });

  it('rejects a relation predicate by scanning wheres for EXISTS', () => {
    const relationWhere = { condition: 'EXISTS (SELECT 1 FROM other WHERE other.id = entity_.id)' };
    assert.throws(
      () => assertPublicationShape(fakeQuery({ wheres: [relationWhere] })),
      (error: unknown) =>
        error instanceof PublicationShapeError && error.code === 'unsupported_relation_predicate',
    );
  });

  it('rejects a raw apply via the #applied flag', () => {
    assert.throws(
      () => assertPublicationShape(fakeQuery({}, true)),
      (error: unknown) =>
        error instanceof PublicationShapeError && error.code === 'unsupported_raw_apply',
    );
  });
});

// ---------------------------------------------------------------------------
// createLiveService — snapshot, change, fence, coalescing, resume, membership
// ---------------------------------------------------------------------------

describe('createLiveService', () => {
  it('delivers a snapshot then changes for insert, update, and delete', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.items',
      collection: 'items',
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
    const realGetOne = builderProto.getOne;
    let probes = 0;
    builderProto.getOne = async function (this: unknown) {
      probes += 1;
      if (probes === 1) {
        await Async.sleep(120);
      }
      return realGetOne.call(this);
    };

    try {
      // One ingest call, two rows: `route` hands both changes to the
      // subscription back-to-back, so the slow first probe is overtaken unless
      // deliveries are serialized per subscription.
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
      builderProto.getOne = realGetOne;
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
      params: z.object({}).strict(),
      authorize: () => false,
      query: () => query(Item),
    });
    const open = definePublication({
      name: 'ls.open',
      collection: 'items',
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

  it('fans out to every subscriber and isolates by identity', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const publication = definePublication({
      name: 'ls.scoped',
      collection: 'docs',
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

    const bobChange = await waitFor(bob.messages, (m) => m.type === 'change');
    assert.equal((bobChange as { row: unknown }).row, null, "bob does not see alice's row");

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
