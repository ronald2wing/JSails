/**
 * The read path of `ModelQuery` on the run's driver (SQLite in the default
 * suite, MariaDB and PostgreSQL in the database legs): conditions, order,
 * limit and offset, `exists`, `count` (locked as well), `pluck`, `select`, scopes, and the
 * relation filters `whereHas` and `has` over every relation shape the
 * fixtures declare (belongs-to, has-many through an inverse, a self
 * relation, a link table, a polymorphic inverse). The same seed answers on
 * every driver, so a dialect difference shows as a failing assertion here.
 */

import assert from 'node:assert/strict';
import { before, it } from 'node:test';

import {
  createQueryLedger,
  defineScope,
  insertAll,
  ModelQuery,
  Q,
  query,
  transaction,
  withQueryLedger,
  type JsailsDataSource,
} from '../../src/index.js';
import { forEachDriver } from '../../src/testing/index.js';
import { openDataSource, suiteLifecycle } from './fixtures/open-data-source.js';
import {
  Attachment,
  Author,
  Comment,
  MODELS,
  Post,
  PostTag,
  Tag,
} from './fixtures/query-models.js';

const live = defineScope<Post>((q) => q.where({ status: 'live' }));
const viewedAtLeast = defineScope<Post, [number]>((q, views) => q.where({ views: { gte: views } }));

const titles = async (q: ModelQuery<Post>): Promise<string[]> =>
  (await q.orderBy('title').getMany()).map((post) => post.title);

void forEachDriver('ModelQuery read path', () => {
  const lifecycle = suiteLifecycle();
  const ids: Record<string, number> = {};
  let dataSource: JsailsDataSource;

  before(async () => {
    dataSource = await openDataSource(lifecycle, MODELS);
    const ada = await Author.create({ name: 'ada' });
    const bob = await Author.create({ name: 'bob' });
    await Author.create({ name: 'cy' });
    const alpha = await Post.create({
      title: 'Alpha',
      status: 'live',
      views: 10,
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
      authorId: ada.id,
    });
    const beta = await Post.create({
      title: 'Beta',
      views: 5,
      authorId: ada.id,
      parentId: alpha.id,
    });
    const gamma = await Post.create({
      title: 'Gamma',
      status: 'live',
      views: 20,
      publishedAt: new Date('2024-02-01T00:00:00.000Z'),
      authorId: bob.id,
      parentId: alpha.id,
    });
    const delta = await Post.create({ title: 'Delta' });
    Object.assign(ids, { ada: ada.id, bob: bob.id, alpha: alpha.id, beta: beta.id });
    Object.assign(ids, { gamma: gamma.id, delta: delta.id });
    await Comment.insertAll([
      { body: 'a1', approved: true, postId: alpha.id },
      { body: 'a2', approved: true, postId: alpha.id },
      { body: 'a3', approved: false, postId: alpha.id },
      { body: 'b1', approved: false, postId: beta.id },
      { body: 'g1', approved: true, postId: gamma.id },
      { body: 'g2', approved: false, postId: gamma.id },
    ]);
    await insertAll(Tag, [{ name: 'red' }, { name: 'blue' }]);
    const tags = await query<{ id: number; name: string }>(Tag).getMany();
    const tag = (name: string) => tags.find((row) => row.name === name)?.id as number;
    await insertAll(PostTag, [
      { postId: alpha.id, tagId: tag('red') },
      { postId: alpha.id, tagId: tag('blue') },
      { postId: gamma.id, tagId: tag('red') },
    ]);
    // An attachment of the author whose key equals Alpha's must not count as Alpha's.
    await Attachment.insertAll([
      { label: 'beta file', ownerType: 'Post', ownerId: beta.id },
      { label: 'ada file', ownerType: 'Author', ownerId: ada.id },
      { label: 'alpha-key file', ownerType: 'Author', ownerId: alpha.id },
    ]);
  });

  it('filters by equality, null, lists, operators and Q combinators', async () => {
    assert.deepEqual(await titles(Post.where({ status: 'live' })), ['Alpha', 'Gamma']);
    assert.deepEqual(await titles(Post.where({ publishedAt: null })), ['Beta', 'Delta']);
    assert.deepEqual(await titles(Post.where({ views: [5, 20] })), ['Beta', 'Gamma']);
    assert.deepEqual(await titles(Post.where({ views: { gt: 5, lte: 20 } })), ['Alpha', 'Gamma']);
    assert.deepEqual(await titles(Post.where({ title: { like: '%ta' } })), ['Beta', 'Delta']);
    assert.deepEqual(
      await titles(Post.where(Q.or<Post>({ views: 0 }, { status: 'live', views: { gte: 15 } }))),
      ['Delta', 'Gamma'],
    );
    assert.deepEqual(
      await titles(Post.where({ status: 'draft' }).where({ authorId: ids['ada'] as number })),
      ['Beta'],
    );
    assert.deepEqual(
      await titles(Post.where({ publishedAt: { gte: new Date('2024-01-15T00:00:00.000Z') } })),
      ['Gamma'],
    );
  });

  it('orders, limits and offsets', async () => {
    const byViews = await Post.all().orderBy({ column: 'views', direction: 'desc' }).getMany();
    assert.deepEqual(
      byViews.map((post) => post.title),
      ['Gamma', 'Alpha', 'Beta', 'Delta'],
    );
    const page = await Post.all().orderBy('title').limit(2).offset(1).getMany();
    assert.deepEqual(
      page.map((post) => post.title),
      ['Beta', 'Delta'],
    );
    const nullsLast = await Post.all()
      .orderBy([{ column: 'publishedAt', direction: 'asc', nulls: 'last' }, 'title'])
      .pluck('title');
    assert.deepEqual(nullsLast, ['Alpha', 'Gamma', 'Beta', 'Delta']);
    assert.deepEqual(await Post.all().orderBy('title').limit(0).getMany(), []);
  });

  it('answers getOne, exists and count, honouring limit and offset', async () => {
    assert.equal((await Post.where({ views: 20 }).getOne())?.title, 'Gamma');
    assert.equal(await Post.where({ views: 999 }).getOne(), null);
    assert.equal(await Post.where({ status: 'live' }).exists(), true);
    assert.equal(await Post.where({ views: 999 }).exists(), false);
    assert.equal(await Post.all().offset(4).exists(), false);
    assert.equal(await Post.all().offset(3).exists(), true);
    assert.equal(await Post.all().count(), 4);
    assert.equal(await Post.where({ status: 'draft' }).count(), 2);
    assert.equal(await Post.all().limit(3).count(), 3);
    assert.equal(await Post.all().offset(3).limit(5).count(), 1);
    assert.equal(await Post.all().offset(9).count(), 0);
    assert.equal(await Post.all().limit(0).count(), 0);
  });

  it('counts a locked query by locking the rows getMany() would lock', async () => {
    const ledger = createQueryLedger({ detail: true });
    await withQueryLedger(ledger, () =>
      transaction(dataSource, async () => {
        assert.equal(await Post.all().lock().count(), 4);
        assert.equal(await Post.where({ status: 'draft' }).lock('share').count(), 2);
        assert.equal(await Post.all().lock('update', 'nowait').limit(3).count(), 3);
        assert.equal(await Post.all().lock().offset(3).limit(5).count(), 1);
        assert.equal(await Post.all().lock().offset(9).count(), 0);
        assert.equal(await Post.all().lock().limit(0).count(), 0);
      }),
    );
    const counted = ledger.records.filter((record) => record.sql.includes('q_posts'));
    assert.equal(counted.length, 5);
    for (const record of counted) {
      assert.doesNotMatch(record.sql, /COUNT\(/i);
      if (dataSource.dialect !== 'sqlite') assert.match(record.sql, /\b(FOR|LOCK IN)\b/);
    }
  });

  it('plucks one column as values and several as tuples, in order', async () => {
    assert.deepEqual(await Post.all().orderBy('views').pluck('views'), [0, 5, 10, 20]);
    const pairs = await Post.where({ status: 'live' })
      .orderBy('title')
      .pluck('title', 'publishedAt');
    assert.deepEqual(pairs, [
      ['Alpha', new Date('2024-01-01T00:00:00.000Z')],
      ['Gamma', new Date('2024-02-01T00:00:00.000Z')],
    ]);
  });

  it('selects frozen plain rows of only the chosen columns, never records', async () => {
    const rows = await Post.where({ status: 'live' })
      .orderBy('title')
      .select('id', 'title')
      .getMany();
    assert.deepEqual(rows, [
      { id: ids['alpha'], title: 'Alpha' },
      { id: ids['gamma'], title: 'Gamma' },
    ]);
    for (const row of rows) {
      assert.equal(Object.isFrozen(row), true);
      assert.equal(Object.getPrototypeOf(row), Object.prototype);
      assert.equal('save' in row, false);
      assert.equal(row instanceof Post, false);
    }
    const one = await Post.all().select('title').orderBy('title').getOne();
    assert.deepEqual(one, { title: 'Alpha' });
  });

  it('applies scopes as plain functions, with arguments, composably', async () => {
    assert.deepEqual(await titles(Post.all().scope(live)), ['Alpha', 'Gamma']);
    assert.deepEqual(await titles(Post.all().scope(live).scope(viewedAtLeast, 15)), ['Gamma']);
    assert.deepEqual(await Post.all().select('title').scope(live).orderBy('title').getMany(), [
      { title: 'Alpha' },
      { title: 'Gamma' },
    ]);
  });

  it('filters by a belongs-to relation, with and without conditions', async () => {
    assert.deepEqual(await titles(Post.all().whereHas('author')), ['Alpha', 'Beta', 'Gamma']);
    assert.deepEqual(await titles(Post.all().whereHas<Author>('author', { name: 'bob' })), [
      'Gamma',
    ]);
    assert.deepEqual(
      await titles(
        Post.all().whereHas<Author>('author', (q) => q.whereHas('posts', { views: 20 })),
      ),
      ['Gamma'],
    );
  });

  it('filters by a has-many relation and by counts of it', async () => {
    assert.deepEqual(await titles(Post.all().whereHas('comments')), ['Alpha', 'Beta', 'Gamma']);
    assert.deepEqual(await titles(Post.all().whereHas<Comment>('comments', { approved: true })), [
      'Alpha',
      'Gamma',
    ]);
    assert.deepEqual(await titles(Post.all().has('comments', '>=', 2)), ['Alpha', 'Gamma']);
    assert.deepEqual(await titles(Post.all().has('comments', '>', 2)), ['Alpha']);
    assert.deepEqual(await titles(Post.all().has('comments', '=', 1)), ['Beta']);
    assert.deepEqual(await titles(Post.all().has('comments', '<', 1)), ['Delta']);
    assert.deepEqual(await titles(Post.all().has('comments', '<=', 1)), ['Beta', 'Delta']);
    assert.deepEqual(await titles(Post.all().has('comments', '>=', 0)), [
      'Alpha',
      'Beta',
      'Delta',
      'Gamma',
    ]);
    assert.deepEqual(
      await titles(Post.all().has<Comment>('comments', '=', 2, { approved: true })),
      ['Alpha'],
    );
    assert.deepEqual(await Author.all().whereHas('posts').orderBy('name').pluck('name'), [
      'ada',
      'bob',
    ]);
  });

  it('filters by a self relation under an alias', async () => {
    assert.deepEqual(await titles(Post.all().whereHas('children')), ['Alpha']);
    assert.deepEqual(await titles(Post.all().whereHas<Post>('parent', { title: 'Alpha' })), [
      'Beta',
      'Gamma',
    ]);
    assert.deepEqual(await titles(Post.all().whereHas<Post>('children', { status: 'live' })), [
      'Alpha',
    ]);
    assert.deepEqual(
      await titles(Post.all().whereHas<Post>('children', (q) => q.whereHas('children'))),
      [],
    );
    assert.deepEqual(await titles(Post.all().has('children', '=', 2)), ['Alpha']);
  });

  it('filters through a link table', async () => {
    assert.deepEqual(await titles(Post.all().whereHas('tags')), ['Alpha', 'Gamma']);
    assert.deepEqual(await titles(Post.all().whereHas('tags', { name: 'blue' })), ['Alpha']);
    assert.deepEqual(await titles(Post.all().has('tags', '>=', 2)), ['Alpha']);
    assert.deepEqual(await titles(Post.all().has('tags', '=', 0)), ['Beta', 'Delta']);
  });

  it('filters by a polymorphic inverse on its type as well as its key', async () => {
    assert.deepEqual(await titles(Post.all().whereHas('attachments')), ['Beta']);
    assert.deepEqual(
      await titles(Post.all().whereHas<Attachment>('attachments', { label: 'alpha-key file' })),
      [],
    );
  });

  it('refuses unknown relations, polymorphic owners and shaped relation filters', async () => {
    assert.throws(() => Post.all().whereHas('nope'), { code: 'query.unknown_relation' });
    assert.throws(() => Attachment.all().whereHas('owner'), {
      code: 'query.unsupported_relation',
    });
    assert.throws(() => Post.all().whereHas<Comment>('comments', (q) => q.limit(1)), {
      code: 'query.invalid_relation_filter',
    });
    assert.throws(() => Post.all().has('comments', '>=', -1), { code: 'query.invalid_argument' });
    assert.throws(() => Post.all().has('comments', '!=' as '=', 1), {
      code: 'query.invalid_argument',
    });
  });

  it('keeps every query immutable: a narrowed query leaves its base as it was', async () => {
    const base = Post.all().orderBy('title');
    const narrowed = base.where({ status: 'live' }).limit(1);
    assert.equal(Object.isFrozen(base), true);
    assert.notEqual(narrowed, base);
    assert.deepEqual(await narrowed.pluck('title'), ['Alpha']);
    assert.deepEqual(await base.pluck('title'), ['Alpha', 'Beta', 'Delta', 'Gamma']);
    assert.equal(await base.count(), 4);
  });

  it('compiles conditions where they are written', () => {
    const input: { status: 'live' | 'draft' } = { status: 'live' };
    const q = Post.where(input);
    input.status = 'draft';
    assert.throws(() => Post.where(JSON.parse('{"nope":1}')), {
      code: 'statement.unknown_column',
    });
    assert.throws(() => Post.where({ title: undefined }), {
      code: 'statement.invalid_where',
    });
    assert.throws(() => Post.all().orderBy('nope' as never), { code: 'statement.unknown_column' });
    return q.count().then((count) => assert.equal(count, 2));
  });
});
