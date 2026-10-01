/**
 * Records and set writes on the run's driver: `create`, `build` and `save`
 * (insert with every generated value read back; update of only the changed
 * columns, by the loaded key, with the optimistic lock), `find`, `findBy`,
 * `reload`, `destroy`, `changed` and `was`; the conditional update and the
 * set writes, whose `affected` counts the rows matched on every driver;
 * `insertAll` across bind-limit chunks, atomically; and transactions taken
 * on the data source.
 */

import assert from 'node:assert/strict';
import { before, beforeEach, it } from 'node:test';

import {
  BIND_LIMITS,
  createQueryLedger,
  insertAll,
  query,
  withQueryLedger,
  type JsailsDataSource,
} from '../../src/index.js';
import { forEachDriver } from '../../src/testing/index.js';
import { openDataSource, suiteLifecycle } from '../query/fixtures/open-data-source.js';
import { Author, Comment, MODELS, Post, PostTag, Tag } from '../query/fixtures/query-models.js';

async function statements<T>(body: () => Promise<T>): Promise<string[]> {
  const ledger = createQueryLedger({ detail: true });
  await withQueryLedger(ledger, body);
  return ledger.records.map((record) => record.sql);
}

void forEachDriver('records and set writes', ({ driver }) => {
  const lifecycle = suiteLifecycle();
  let dataSource: JsailsDataSource;

  before(async () => {
    dataSource = await openDataSource(lifecycle, MODELS);
  });

  beforeEach(async () => {
    await query(PostTag).deleteAll();
    await Comment.all().deleteAll();
    await Post.all().deleteAll();
    await query(Tag).deleteAll();
    await Author.all().deleteAll();
  });

  it('creates a record with every generated value read back', async () => {
    const post = await Post.create({ title: 'Hello' });
    assert.ok(post instanceof Post);
    assert.equal(typeof post.id, 'number');
    assert.equal(post.status, 'draft');
    assert.equal(post.views, 0);
    assert.equal(post.lockVersion, 0);
    assert.equal(post.publishedAt, null);
    assert.equal(post.headline(), 'HELLO');
    assert.equal(post.isPersisted(), true);
    assert.deepEqual(post.changed(), []);
    assert.deepEqual(Object.keys(post).toSorted(), [
      'authorId',
      'id',
      'lockVersion',
      'parentId',
      'publishedAt',
      'status',
      'title',
      'views',
    ]);
    const found = await Post.find(post.id);
    assert.deepEqual({ ...found }, { ...post });
  });

  it('builds an unsaved record, then inserts it on save', async () => {
    const post = Post.build({ title: 'Draft', views: 3 });
    assert.equal(post.isPersisted(), false);
    assert.deepEqual(post.changed().toSorted(), ['title', 'views']);
    assert.equal(post.was('title'), undefined);
    assert.equal(await post.save(), post);
    assert.equal(post.isPersisted(), true);
    assert.equal(await Post.where({ title: 'Draft', views: 3 }).count(), 1);
  });

  it('updates only the changed columns, and sends nothing when nothing changed', async () => {
    const post = await Post.create({ title: 'Before', views: 1 });
    post.title = 'After';
    assert.deepEqual(post.changed(), ['title']);
    assert.equal(post.was('title'), 'Before');
    const sent = await statements(() => post.save());
    assert.equal(sent.length, 1);
    assert.match(sent[0] as string, /^UPDATE /);
    assert.match(sent[0] as string, /title/);
    assert.doesNotMatch(sent[0] as string, /views/);
    assert.equal(post.lockVersion, 1);
    assert.deepEqual(post.changed(), []);
    assert.equal(post.was('title'), 'After');
    assert.deepEqual(await statements(() => post.save()), []);
    const fresh = await Post.find(post.id);
    assert.equal(fresh.title, 'After');
    assert.equal(fresh.lockVersion, 1);
  });

  it('treats a date set to the same instant as unchanged', async () => {
    const at = new Date('2024-03-01T10:00:00.123Z');
    const post = await Post.create({ title: 'Dated', publishedAt: at });
    post.publishedAt = new Date(at.getTime());
    assert.deepEqual(post.changed(), []);
    assert.deepEqual((await Post.find(post.id)).publishedAt, at);
  });

  it('refuses a stale update and delete under the optimistic lock', async () => {
    const created = await Post.create({ title: 'Shared' });
    const mine = await Post.find(created.id);
    const theirs = await Post.find(created.id);
    mine.title = 'Mine';
    await mine.save();
    theirs.title = 'Theirs';
    await assert.rejects(() => theirs.save(), { code: 'record.stale_record' });
    await assert.rejects(() => theirs.destroy(), { code: 'record.stale_record' });
    await theirs.reload();
    assert.equal(theirs.title, 'Mine');
    assert.equal(theirs.lockVersion, 1);
    theirs.title = 'Theirs';
    await theirs.save();
    assert.equal((await Post.find(created.id)).title, 'Theirs');
  });

  it('finds by key, and refuses missing rows and malformed keys', async () => {
    const post = await Post.create({ title: 'Keyed' });
    assert.equal((await Post.find(post.id)).title, 'Keyed');
    assert.equal((await Post.findBy({ title: 'Keyed' }))?.id, post.id);
    assert.equal(await Post.findBy({ title: 'none' }), null);
    await assert.rejects(() => Post.find(post.id + 1000), {
      code: 'record.not_found',
      context: { model: 'Post' },
    });
    await assert.rejects(() => Post.find({ id: post.id }), { code: 'record.invalid_key' });
    await assert.rejects(() => Post.find(null as never), { code: 'record.invalid_key' });
  });

  it('destroys a record, leaving it unsaved, and reload fails once its row is gone', async () => {
    const post = await Post.create({ title: 'Gone' });
    await post.destroy();
    assert.equal(post.isPersisted(), false);
    assert.equal(await Post.where({ id: post.id }).exists(), false);
    await assert.rejects(() => post.destroy(), { code: 'record.not_persisted' });
    await assert.rejects(() => post.reload(), { code: 'record.not_persisted' });
    const other = await Post.create({ title: 'Other' });
    await Post.where({ id: other.id }).deleteAll();
    await assert.rejects(() => other.reload(), { code: 'record.not_found' });
    await assert.rejects(() => Post.build({ title: 'x' }).destroy(), {
      code: 'record.not_persisted',
    });
  });

  it('applies the conditional update: matched once, then never again', async () => {
    const post = await Post.create({ title: 'Locked' });
    const cas = (title: string) =>
      Post.where({ id: post.id, lockVersion: 0 }).updateAll({ title, lockVersion: 1 });
    assert.deepEqual(await cas('First'), { affected: 1 });
    assert.deepEqual(await cas('Second'), { affected: 0 });
    assert.equal((await Post.find(post.id)).title, 'First');
  });

  it('counts the rows a set write matched, changed or not, on every driver', async () => {
    await Post.insertAll([
      { title: 'a', status: 'live' },
      { title: 'b', status: 'live' },
      { title: 'c', status: 'draft' },
    ]);
    assert.deepEqual(await Post.where({ status: 'live' }).updateAll({ status: 'live' }), {
      affected: 2,
    });
    assert.deepEqual(await Post.where({ status: 'draft' }).updateAll({ views: 9 }), {
      affected: 1,
    });
    assert.deepEqual(await Post.where({ status: 'live' }).deleteAll(), { affected: 2 });
    assert.deepEqual(await Post.all().pluck('views'), [9]);
  });

  it('refuses set writes shaped by limit, offset, lock or select, and walks with an offset', async () => {
    const all = Post.all();
    await assert.rejects(() => all.limit(1).updateAll({ views: 1 }), {
      code: 'query.invalid_set_write',
    });
    await assert.rejects(() => all.offset(1).deleteAll(), {
      code: 'query.invalid_set_write',
      context: { model: 'Post', part: 'offset' },
    });
    await assert.rejects(() => all.lock().deleteAll(), { code: 'query.invalid_set_write' });
    await assert.rejects(() => all.select('id').updateAll({ views: 1 }), {
      code: 'query.invalid_set_write',
    });
    await assert.rejects(() => all.offset(2).findEach(() => undefined), {
      code: 'query.invalid_batch',
    });
    await assert.rejects(() => all.inBatches(0, () => undefined), {
      code: 'query.invalid_argument',
    });
    assert.throws(() => all.limit(-1), { code: 'query.invalid_argument' });
    assert.throws(() => all.lock('exclusive' as 'update'), { code: 'query.invalid_argument' });
  });

  it('inserts across bind-limit chunks in one transaction', async () => {
    const perChunk = Math.floor(BIND_LIMITS[driver] / 2);
    const rows = Array.from({ length: perChunk + 10 }, (_, index) => ({ name: `tag ${index}` }));
    assert.deepEqual(await insertAll(Tag, rows), { affected: rows.length });
    assert.equal(await query(Tag).count(), rows.length);
    await query(Tag).deleteAll();
    // The duplicate is in the last chunk: the first chunk must roll back with it.
    const failing = [...rows, { name: 'tag 0' }];
    await assert.rejects(() => insertAll(Tag, failing));
    assert.equal(await query(Tag).count(), 0);
  });

  it('runs records in a transaction on the data source, and rolls back on a throw', async () => {
    await assert.rejects(
      () =>
        dataSource.transaction(async () => {
          await Post.create({ title: 'Rolled back' });
          throw new Error('stop');
        }),
      { message: 'stop' },
    );
    assert.equal(await Post.where({ title: 'Rolled back' }).exists(), false);
    await dataSource.transaction(async () => {
      const post = await Post.create({ title: 'Kept' });
      post.views = 4;
      await post.save();
    });
    assert.equal((await Post.findBy({ title: 'Kept' }))?.views, 4);
    await dataSource.withTestTransaction(async () => {
      await Post.create({ title: 'Test only' });
      assert.equal(await Post.where({ title: 'Test only' }).exists(), true);
    });
    assert.equal(await Post.where({ title: 'Test only' }).exists(), false);
  });

  it('reads with a row lock inside a transaction', async () => {
    const post = await Post.create({ title: 'Lock me' });
    await dataSource.transaction(async () => {
      const locked = await Post.where({ id: post.id }).lock('update').getOne();
      assert.equal(locked?.title, 'Lock me');
    });
  });
});
