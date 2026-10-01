/**
 * What relation loading costs on the run's driver, counted on the wire: 100
 * parents with 200 children each load in two statements; a three-level
 * include costs four; 5,000 parents still cost two; a per-parent limit of 3
 * brings at most 300 child rows back from the driver; 33,000 parents cost
 * one statement per bind chunk beyond the root (one on PostgreSQL, which
 * binds the keys as one array), every parent still holding its own rows.
 * The has-many load reads through the foreign-key index (EXPLAIN on every
 * driver), and under a second tenant whose rows point at the first tenant's
 * (comments on its posts, notes on its comments, links to its posts, a
 * profile of its author) and the reverse, no loader returns a foreign row.
 */

import assert from 'node:assert/strict';
import { before, it } from 'node:test';

import {
  createQueryLedger,
  insertAll,
  loadRelation,
  loadRelationMap,
  query,
  relationCount,
  runWithTenant,
  withQueryLedger,
  type JsailsDataSource,
  type Row,
} from '../../../src/index.js';
import { BIND_LIMITS } from '../../../src/engine/index.js';
import { forEachDriver } from '../../../src/testing/index.js';
import { unguarded } from '../../../src/unguarded/index.js';
import { openDataSource, suiteLifecycle } from '../../query/fixtures/open-data-source.js';
import {
  Author,
  Comment,
  Note,
  Post,
  PostTag,
  Profile,
  RELATION_MODELS,
  Tag,
} from './fixtures/relation-models.js';
import { spyStatements } from './fixtures/statement-spy.js';

const AUTHORS = 33_000;
const POSTS = 100;
const COMMENTS_PER_POST = 200;

const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(1, fn);

/** `fn`'s result under tenant 1, and the statements it ran by the ledger. */
async function counted<T>(fn: () => Promise<T>): Promise<{ result: T; statements: number }> {
  const ledger = createQueryLedger();
  const result = await withQueryLedger(ledger, () => asTenant(fn));
  return { result, statements: ledger.count };
}

void forEachDriver('relation load plan', ({ driver }) => {
  const lifecycle = suiteLifecycle();
  let dataSource: JsailsDataSource;
  let authorIds: readonly number[] = [];
  let postIds: readonly number[] = [];
  const foreign: Record<string, number> = {};

  before(async () => {
    dataSource = await openDataSource(lifecycle, RELATION_MODELS);
    await insertAll(Tag, [{ name: 'red' }, { name: 'blue' }]);
    const tagIds = await query(Tag).orderBy('id').pluck('id');
    await asTenant(async () => {
      await insertAll(
        Author,
        Array.from({ length: AUTHORS }, (_, index) => ({ name: `author ${index}` })),
      );
      authorIds = await query<Author>(Author).orderBy('id').pluck('id');
      // Posts belong to authors spread over the whole key range, the last one included.
      const step = Math.floor(AUTHORS / POSTS);
      await insertAll(
        Post,
        Array.from({ length: POSTS }, (_, index) => ({
          title: `post ${index}`,
          rank: index % 7,
          authorId: authorIds[Math.min(AUTHORS - 1, (index + 1) * step - 1)],
        })),
      );
      postIds = await query<Post>(Post).orderBy('id').pluck('id');
      await insertAll(
        Comment,
        postIds.flatMap((postId, post) =>
          Array.from({ length: COMMENTS_PER_POST }, (_, index) => ({
            body: `comment ${post}.${index}`,
            score: (index * 7) % 11,
            approved: index % 3 === 0,
            postId,
            authorId: index % 4 === 0 ? null : authorIds[index],
          })),
        ),
      );
      const commentIds = await query<Comment>(Comment).orderBy('id').pluck('id');
      await insertAll(
        Note,
        commentIds
          .filter((_, index) => index % 10 === 0)
          .map((subjectId) => ({ text: 'note', subjectType: 'Comment', subjectId })),
      );
      await insertAll(PostTag, [{ postId: postIds[0], tagId: tagIds[0] }]);
    });
    // The second tenant: rows pointing at the first tenant's, and one of the first tenant's
    // pointing at it.
    const first = { post: postIds[0] as number, author: authorIds[0] as number };
    await runWithTenant(2, async () => {
      const author = await Author.create({ name: 'foreign author' });
      const post = await Post.create({ title: 'foreign post', authorId: first.author });
      const comment = await Comment.create({ body: 'foreign comment', postId: first.post });
      await Profile.create({ bio: 'foreign profile', authorId: first.author });
      await insertAll(PostTag, [{ postId: first.post, tagId: tagIds[1] }]);
      await Note.create({ text: 'foreign note', subjectType: 'Post', subjectId: first.post });
      Object.assign(foreign, { author: author.id, post: post.id, comment: comment.id });
    });
    await asTenant(async () => {
      const comment = await Comment.create({ body: 'pointing out', postId: foreign['post'] });
      foreign['pointing'] = comment.id;
    });
    const raw = unguarded(dataSource);
    if (driver === 'postgres') await raw.sql`ANALYZE`;
    else if (driver === 'mariadb') await raw.sql`ANALYZE TABLE rl_comments, rl_posts, rl_authors`;
    else await raw.sql`ANALYZE`;
  });

  it('loads 100 parents with 200 children each in two statements', async () => {
    const { result: posts, statements } = await counted(() =>
      Post.where({ id: [...postIds] })
        .includes('comments')
        .getMany(),
    );
    assert.equal(statements, 2);
    assert.equal(posts.length, POSTS);
    for (const post of posts) {
      assert.equal(post.comments.length, COMMENTS_PER_POST);
      assert.ok(post.comments.every((comment) => comment.postId === post.id));
    }
  });

  it('loads a three-level include in four statements', async () => {
    const { result: authors, statements } = await counted(() =>
      Author.where({ id: authorIds.slice(0, 1000) })
        .includes({ posts: { include: { comments: { include: ['notes'] } } } })
        .getMany(),
    );
    assert.equal(statements, 4);
    const comments = authors.flatMap((author) => author.posts.flatMap((post) => post.comments));
    assert.ok(comments.length > 0);
    const notes = await asTenant(() =>
      Note.where({
        subjectType: 'Comment',
        subjectId: comments.map((comment) => comment.id),
      }).count(),
    );
    assert.ok(notes > 0);
    assert.equal(
      comments.reduce((sum, comment) => sum + comment.notes.length, 0),
      notes,
    );
  });

  it('loads 5,000 parents in exactly two statements', async () => {
    const { result: authors, statements } = await counted(() =>
      Author.all().orderBy('id').limit(5000).includes('posts').getMany(),
    );
    assert.equal(statements, 2);
    assert.equal(authors.length, 5000);
    const both = await counted(() =>
      Author.all().orderBy('id').limit(5000).includes(['posts', 'profile']).getMany(),
    );
    assert.equal(both.statements, 3, 'the root and one statement per relation');
  });

  it('brings at most limit rows per parent back from the driver', async () => {
    const { result: posts, spy } = await spyStatements(dataSource, () =>
      asTenant(() =>
        Post.where({ id: [...postIds] })
          .includes({ comments: { limit: 3, order: [{ column: 'score', direction: 'desc' }] } })
          .getMany(),
      ),
    );
    assert.equal(spy.statements.length, 2);
    assert.ok((spy.statements[1]?.rows ?? Infinity) <= 300);
    for (const post of posts) {
      assert.equal(post.comments.length, 3);
      const scores = post.comments.map((comment) => comment.score);
      assert.deepEqual(
        scores,
        [...scores].sort((a, b) => b - a),
      );
    }
  });

  it('splits 33,000 parents into bind chunks only where the driver needs them', async () => {
    const { result: authors, spy } = await spyStatements(dataSource, () =>
      asTenant(() => Author.all().orderBy('id').includes('posts').getMany()),
    );
    assert.equal(authors.length, AUTHORS);
    // The load binds one tenant value besides its keys.
    const chunks = driver === 'postgres' ? 1 : Math.ceil(AUTHORS / (BIND_LIMITS[driver] - 1));
    assert.equal(spy.statements.length, 1 + chunks);
    assert.equal(spy.leases, 1);
    const withPosts = authors.filter((author) => author.posts.length > 0);
    assert.equal(withPosts.length, POSTS);
    assert.ok(
      withPosts.every((author) => author.posts.every((post) => post.authorId === author.id)),
    );
    assert.equal(authors.at(-1)?.posts.length, 1, 'the last chunk is loaded too');
  });

  it('reads the has-many load through the foreign-key index', async () => {
    const { spy } = await spyStatements(dataSource, () =>
      asTenant(() =>
        Post.where({ id: postIds.slice(0, 3) })
          .includes('comments')
          .getMany(),
      ),
    );
    const load = spy.statements[1];
    assert.ok(load !== undefined);
    const conn = await unguarded(dataSource).lease();
    let plan: readonly Row[];
    try {
      const prefix = driver === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ';
      plan = (await conn.query(prefix + load.sql, load.params)).rows;
    } finally {
      await conn.release();
    }
    const text = plan.map((row) => String(row['detail'] ?? row['QUERY PLAN'] ?? '')).join('\n');
    if (driver === 'sqlite') {
      assert.match(text, /SEARCH rl_comments USING INDEX \w*post_id\w* \(post_id=\?\)/);
    } else if (driver === 'postgres') {
      assert.match(text, /(Index Scan using|Bitmap Index Scan on) \w*post_id\w*/);
      assert.doesNotMatch(text, /Seq Scan/);
    } else {
      const [access] = plan;
      assert.match(String(access?.['key']), /post_id/);
    }
  });

  it('returns no row of another tenant through any loader', async () => {
    const first = postIds[0] as number;
    const isOwn = (record: unknown): boolean =>
      (record as { readonly tenantId?: number }).tenantId === 1;
    await asTenant(async () => {
      const [post] = await Post.where({ id: first })
        .includes({
          comments: true,
          tags: true,
          notes: true,
          author: { include: ['profile', 'posts'] },
        })
        .getMany();
      assert.ok(post !== undefined);
      assert.equal(post.comments.length, COMMENTS_PER_POST);
      assert.ok(post.comments.every(isOwn));
      assert.deepEqual(
        post.tags.map((tag) => tag.name),
        ['red'],
      );
      assert.deepEqual(post.notes, []);
      assert.equal(post.author?.profile, null);
      assert.ok(post.author?.posts.every(isOwn));
      const pointing = await Comment.where({ id: foreign['pointing'] as number })
        .includes('post')
        .getOne();
      assert.equal(pointing?.post, null, 'a key naming a foreign row loads nothing');
      const [mapped] = [
        ...(
          await loadRelationMap(
            Author,
            await Author.where({ id: authorIds[0] as number }).getMany(),
            'posts',
          )
        ).values(),
      ];
      assert.ok(mapped?.every(isOwn));
      const loaded = await loadRelation(Post, [post], 'comments', { maxRows: COMMENTS_PER_POST });
      assert.ok(loaded[0]?.comments.every(isOwn));
      const counts = await relationCount(Post, [post], 'comments');
      assert.equal(counts.get(post), COMMENTS_PER_POST);
    });
    await runWithTenant(2, async () => {
      const comment = await Comment.where({ id: foreign['comment'] as number })
        .includes(['post', 'notes'])
        .getOne();
      assert.equal(comment?.post, null);
      const post = await Post.where({ id: foreign['post'] as number })
        .includes('author')
        .getOne();
      assert.equal(post?.author, null);
    });
  });
});
