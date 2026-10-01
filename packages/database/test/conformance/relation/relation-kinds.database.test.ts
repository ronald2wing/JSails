/**
 * Relation loading on the run's driver, over every relation kind the
 * fixtures declare: `hasMany`, `hasOne`, `belongsTo` (shared targets),
 * through a link table and through a `hasMany`, a polymorphic `belongsTo`
 * (one statement per type) and its polymorphic inverse. Each load's values,
 * per-parent order, conditions and window limit are checked against the
 * seed, with the statements it cost; and the loaded-versus-unloaded
 * contract: an unloaded relation throws `relation.not_loaded` and is
 * invisible to JSON, a loaded empty one is `[]` or `null`, `reload()`
 * unloads. Also the loaders outside a query (`loadRelation`,
 * `loadRelationMap` on plain rows, `relationCount`), `maxRows`, the
 * refusals, a load inside a transaction, the one lease a query holds, batch
 * walks, and a data handle's grants.
 */

import assert from 'node:assert/strict';
import { before, it } from 'node:test';

import {
  createQueryLedger,
  dataHandle,
  insertAll,
  loadRelation,
  loadRelationMap,
  query,
  relationCount,
  runWithTenant,
  withQueryLedger,
  type Engine,
  type JsailsDataSource,
} from '../../../src/index.js';
import { internalsOf } from '../../../src/record/data-source.js';
import { forEachDriver } from '../../../src/testing/index.js';
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
  type TagRow,
} from './fixtures/relation-models.js';

const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(1, fn);

/** `fn`'s result and the number of statements it ran, under tenant 1. */
async function counted<T>(fn: () => Promise<T>): Promise<{ result: T; statements: number }> {
  const ledger = createQueryLedger({ detail: true });
  const result = await withQueryLedger(ledger, () => asTenant(fn));
  return { result, statements: ledger.count };
}

const ids = (records: readonly { readonly id: number }[]): number[] =>
  records.map((record) => record.id);

const notLoaded = { code: 'relation.not_loaded' };

void forEachDriver('relation loading by kind', () => {
  const lifecycle = suiteLifecycle();
  let dataSource: JsailsDataSource;
  const seed: Record<string, number> = {};
  const id = (name: string): number => seed[name] as number;

  before(async () => {
    dataSource = await openDataSource(lifecycle, RELATION_MODELS);
    await insertAll(Tag, [{ name: 'red' }, { name: 'blue' }, { name: 'green' }]);
    for (const tag of await query<TagRow>(Tag).getMany()) seed[tag.name] = tag.id;
    await asTenant(async () => {
      const ada = await Author.create({ name: 'ada' });
      const bob = await Author.create({ name: 'bob' });
      const cy = await Author.create({ name: 'cy' });
      await Profile.create({ bio: 'ada writes', authorId: ada.id });
      const alpha = await Post.create({ title: 'alpha', rank: 2, authorId: ada.id });
      const beta = await Post.create({ title: 'beta', rank: 1, authorId: ada.id });
      const gamma = await Post.create({ title: 'gamma', rank: 3, authorId: bob.id });
      const delta = await Post.create({ title: 'delta', rank: 0, authorId: null });
      Object.assign(seed, { ada: ada.id, bob: bob.id, cy: cy.id });
      Object.assign(seed, { alpha: alpha.id, beta: beta.id, gamma: gamma.id, delta: delta.id });
      const comments = [
        { body: 'c1', score: 5, approved: true, postId: alpha.id, authorId: bob.id },
        { body: 'c2', score: 1, approved: false, postId: alpha.id, authorId: ada.id },
        { body: 'c3', score: 3, approved: true, postId: alpha.id, authorId: null },
        { body: 'c4', score: 2, approved: false, postId: beta.id, authorId: ada.id },
        { body: 'c5', score: 4, approved: false, postId: delta.id, authorId: null },
      ];
      for (const values of comments) seed[values.body] = (await Comment.create(values)).id;
      await insertAll(PostTag, [
        { postId: alpha.id, tagId: id('blue') },
        { postId: alpha.id, tagId: id('red') },
        { postId: beta.id, tagId: id('blue') },
      ]);
      const notes = [
        { text: 'n1', subjectType: 'Post', subjectId: alpha.id },
        { text: 'n2', subjectType: 'Comment', subjectId: id('c1') },
        { text: 'n3', subjectType: 'Post', subjectId: alpha.id },
        { text: 'n4', subjectType: null, subjectId: null },
        { text: 'n5', subjectType: 'Comment', subjectId: id('c4') },
      ];
      for (const values of notes) seed[values.text] = (await Note.create(values)).id;
    });
  });

  it('loads a hasMany in one statement, every parent holding its list in key order', async () => {
    const { result: posts, statements } = await counted(() =>
      Post.all().orderBy('id').includes('comments').getMany(),
    );
    assert.equal(statements, 2);
    const byTitle = new Map(posts.map((post) => [post.title, post]));
    assert.deepEqual(ids(byTitle.get('alpha')?.comments ?? []), [id('c1'), id('c2'), id('c3')]);
    assert.deepEqual(ids(byTitle.get('beta')?.comments ?? []), [id('c4')]);
    assert.deepEqual(byTitle.get('gamma')?.comments, []);
    for (const post of posts) {
      for (const comment of post.comments) {
        assert.ok(comment instanceof Comment);
        assert.equal(comment.postId, post.id);
        assert.ok(comment.isPersisted());
      }
    }
  });

  it('applies a load condition, an order and a per-parent limit in the database', async () => {
    const { result: posts, statements } = await counted(() =>
      Post.where({ id: [id('alpha'), id('beta'), id('gamma')] })
        .orderBy('id')
        .includes({
          comments: {
            where: { score: { gte: 2 } },
            order: [{ column: 'score', direction: 'desc' }],
            limit: 2,
          },
        })
        .getMany(),
    );
    assert.equal(statements, 2);
    assert.deepEqual(
      posts.map((post) => post.comments.map((comment) => comment.body)),
      [['c1', 'c3'], ['c4'], []],
    );
    const approved = await asTenant(() =>
      Post.where({ id: id('alpha') })
        .includes({ comments: { where: { approved: true } } })
        .getOne(),
    );
    assert.deepEqual(
      approved?.comments.map((comment) => comment.body),
      ['c1', 'c3'],
    );
  });

  it('loads a belongsTo once per distinct key, parents sharing the target record', async () => {
    const { result: comments, statements } = await counted(() =>
      Comment.all().orderBy('id').includes(['post', 'author']).getMany(),
    );
    assert.equal(statements, 3);
    const [c1, c2, c3] = comments;
    assert.ok(c1 !== undefined && c2 !== undefined && c3 !== undefined);
    assert.equal(c1.post.title, 'alpha');
    assert.equal(c1.post, c2.post, 'one row is one record');
    assert.equal(c1.author?.name, 'bob');
    assert.equal(c3.author, null);
  });

  it('loads a hasOne as the record or null', async () => {
    const authors = await asTenant(() => Author.all().orderBy('id').includes('profile').getMany());
    assert.deepEqual(
      authors.map((author) => author.profile?.bio ?? null),
      ['ada writes', null, null],
    );
  });

  it('loads a through relation with one join, over a link table and over a hasMany', async () => {
    const { result: posts, statements } = await counted(() =>
      Post.all().orderBy('id').includes('tags').getMany(),
    );
    assert.equal(statements, 2);
    assert.deepEqual(
      posts.map((post) => post.tags.map((tag) => tag.name)),
      [['red', 'blue'], ['blue'], [], []],
    );
    const authors = await asTenant(() =>
      Author.all()
        .orderBy('id')
        .includes({ comments: { order: [{ column: 'score', direction: 'desc' }] } })
        .getMany(),
    );
    assert.deepEqual(
      authors.map((author) => author.comments.map((comment) => comment.body)),
      [['c1', 'c3', 'c4', 'c2'], [], []],
    );
  });

  it('loads a polymorphic belongsTo with one statement per type, and its inverse', async () => {
    const { result: notes, statements } = await counted(() =>
      Note.all().orderBy('id').includes('subject').getMany(),
    );
    assert.equal(statements, 3);
    const subjects = notes.map((note) => note.subject);
    assert.ok(subjects[0] instanceof Post && subjects[0].id === id('alpha'));
    assert.ok(subjects[1] instanceof Comment && subjects[1].id === id('c1'));
    assert.equal(subjects[2], subjects[0]);
    assert.equal(subjects[3], null);
    assert.ok(subjects[4] instanceof Comment && subjects[4].id === id('c4'));
    const posts = await asTenant(() => Post.all().orderBy('id').includes('notes').getMany());
    assert.deepEqual(
      posts.map((post) => post.notes.map((note) => note.text)),
      [['n1', 'n3'], [], [], []],
    );
  });

  it('loads nested includes level by level, under a polymorphic target as well', async () => {
    const { result: posts, statements } = await counted(() =>
      Post.where({ id: id('alpha') })
        .includes({ comments: { include: { author: { include: ['profile'] } } }, author: true })
        .getMany(),
    );
    assert.equal(statements, 5);
    const [alpha] = posts;
    assert.equal(alpha?.author?.name, 'ada');
    assert.deepEqual(
      alpha?.comments.map((comment) => comment.author?.name ?? null),
      ['bob', 'ada', null],
    );
    assert.equal(alpha?.comments[1]?.author?.profile?.bio, 'ada writes');
    const notes = await asTenant(() =>
      Note.where({ text: ['n1', 'n2'] })
        .orderBy('text')
        .includes({ subject: { include: ['notes'] } })
        .getMany(),
    );
    const notesOf = (subject: unknown): string[] =>
      (subject as { readonly notes: readonly Note[] }).notes.map((note) => note.text);
    assert.deepEqual(notesOf(notes[0]?.subject), ['n1', 'n3']);
    assert.deepEqual(notesOf(notes[1]?.subject), ['n2']);
  });

  it('throws not_loaded for a relation never loaded, which JSON and spreading never see', async () => {
    const post = await asTenant(() => Post.find(id('alpha')));
    assert.throws(() => post.comments, notLoaded);
    assert.throws(() => post.author, notLoaded);
    assert.ok(!('comments' in { ...post }));
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(post)) as object).sort(), [
      'authorId',
      'id',
      'rank',
      'tenantId',
      'title',
    ]);
    const [loaded] = await asTenant(() => loadRelation(Post, [post], 'comments'));
    assert.equal(loaded?.comments.length, 3);
    assert.equal((JSON.parse(JSON.stringify(post)) as { comments: unknown[] }).comments.length, 3);
    assert.throws(() => post.author, notLoaded);
    await asTenant(() => post.reload());
    assert.throws(() => post.comments, notLoaded, 'reload drops the relations it held');
  });

  it('holds an assigned relation as loaded, for autosave and reading alike', async () => {
    const post = await asTenant(() => Post.find(id('gamma')));
    const draft = Comment.build({ body: 'draft', postId: post.id });
    post.comments = [draft];
    assert.deepEqual(post.comments, [draft]);
    assert.ok(Object.keys(post).includes('comments'));
  });

  it('loads onto records in hand and maps plain rows without attaching', async () => {
    const posts = await asTenant(() => Post.all().orderBy('id').getMany());
    const { result: loaded, statements } = await counted(() =>
      loadRelation(Post, posts, 'comments', { limit: 1, include: ['author'] }),
    );
    assert.equal(statements, 2);
    assert.deepEqual(
      loaded.map((post) => post.comments.map((comment) => comment.author?.name ?? null)),
      [['bob'], ['ada'], [], [null]],
    );
    const rows = await asTenant(() => Post.all().orderBy('id').select('id', 'authorId').getMany());
    const authors = await asTenant(() => loadRelationMap(Post, rows, 'author'));
    assert.deepEqual(
      rows.map((row) => authors.get(row)?.name ?? null),
      ['ada', 'ada', 'bob', null],
    );
    assert.ok(Object.isFrozen(rows[0]) && !('author' in (rows[0] as object)));
  });

  it('counts related rows with one grouped statement', async () => {
    const posts = await asTenant(() => Post.all().orderBy('id').getMany());
    const { result: counts, statements } = await counted(() =>
      relationCount(Post, posts, 'comments', { where: { approved: true } }),
    );
    assert.equal(statements, 1);
    assert.deepEqual(
      posts.map((post) => counts.get(post)),
      [2, 0, 0, 0],
    );
    const authors = await asTenant(() => Author.all().orderBy('id').getMany());
    const through = await asTenant(() => relationCount(Author, authors, 'comments'));
    assert.deepEqual(
      authors.map((author) => through.get(author)),
      [4, 0, 0],
    );
    await assert.rejects(() => asTenant(() => relationCount(Comment, [], 'post')), {
      code: 'relation.not_countable',
    });
  });

  it('fails a level past its maxRows instead of cutting it off', async () => {
    await assert.rejects(
      () =>
        asTenant(() =>
          Post.all()
            .includes({ comments: { maxRows: 4 } })
            .getMany(),
        ),
      { code: 'relation.too_many_rows' },
    );
    const posts = await asTenant(() =>
      Post.all()
        .includes({ comments: { maxRows: 5 } })
        .getMany(),
    );
    assert.equal(posts.flatMap((post) => post.comments).length, 5);
    await assert.rejects(
      () =>
        asTenant(() =>
          Note.all()
            .includes({ subject: { maxRows: 2 } })
            .getMany(),
        ),
      { code: 'relation.too_many_rows' },
    );
  });

  it('refuses includes it cannot honour where they are written', () => {
    const refuses = (fn: () => unknown, code: string): void => {
      assert.throws(fn, { code });
    };
    refuses(
      () =>
        Post.all()
          .select('id')
          .includes('comments' as never),
      'relation.plain_rows',
    );
    refuses(() => Post.all().includes('comments').select('id'), 'relation.plain_rows');
    refuses(() => Post.all().includes('comments').includes('comments'), 'relation.invalid_include');
    refuses(() => Post.all().includes([]), 'relation.invalid_include');
    refuses(() => Post.all().includes('nope' as never), 'query.unknown_relation');
    refuses(
      () => Comment.all().includes({ post: { limit: 1 } } as never),
      'relation.invalid_option',
    );
    refuses(
      () => Comment.all().includes({ post: { order: 'id' } } as never),
      'relation.invalid_option',
    );
    refuses(
      () => Author.all().includes({ profile: { limit: 1 } } as never),
      'relation.invalid_option',
    );
    refuses(
      () => Note.all().includes({ subject: { where: {} } } as never),
      'relation.invalid_option',
    );
    refuses(() => Post.all().includes({ comments: { limit: 0 } }), 'relation.invalid_option');
    refuses(() => Post.all().includes({ comments: { maxRows: -1 } }), 'relation.invalid_option');
    refuses(
      () => Post.all().includes({ comments: { first: 1 } } as never),
      'relation.invalid_option',
    );
    refuses(
      () => Post.all().includes({ comments: { where: { nope: 1 } } } as never),
      'statement.unknown_column',
    );
    refuses(
      () => Post.all().whereHas<Comment>('comments', (q) => q.includes('post')),
      'query.invalid_relation_filter',
    );
  });

  it('sees the rows of the transaction it loads in', async () => {
    const counts = await asTenant(() =>
      dataSource.transaction(async () => {
        await Comment.create({ body: 'pending', postId: id('gamma') });
        const gamma = await Post.where({ id: id('gamma') })
          .includes('comments')
          .getOne();
        return gamma?.comments.length;
      }),
    );
    assert.equal(counts, 1);
    await asTenant(() => Comment.where({ body: 'pending' }).deleteAll());
  });

  it('runs a query and every level of its includes on one lease', async () => {
    const engine: Engine = await internalsOf(dataSource).engine();
    const lease = engine.lease.bind(engine);
    let leases = 0;
    Object.defineProperty(engine, 'lease', {
      configurable: true,
      value: () => {
        leases += 1;
        return lease();
      },
    });
    try {
      await asTenant(() =>
        Author.all()
          .includes({ posts: { include: { comments: { include: ['notes'] } } } })
          .getMany(),
      );
    } finally {
      Reflect.deleteProperty(engine, 'lease');
    }
    assert.equal(leases, 1);
  });

  it('loads each batch of a walk with its own statements', async () => {
    const { result: batches, statements } = await counted(async () => {
      const seen: string[][] = [];
      await Post.all()
        .includes('comments')
        .inBatches(2, (posts) => {
          seen.push(posts.map((post) => `${post.title}:${post.comments.length}`));
        });
      return seen;
    });
    assert.deepEqual(batches, [
      ['alpha:3', 'beta:1'],
      ['gamma:0', 'delta:1'],
    ]);
    assert.equal(statements, 5, 'a batch and its load each, and the last batch, empty, alone');
  });

  it("keeps a data handle's grants: no records of a read grant, no includes on plain rows", async () => {
    const owner = dataHandle(dataSource, { models: [Post], read: [Comment] });
    await assert.rejects(() => asTenant(() => owner.query(Post).includes('comments').getMany()), {
      code: 'data_source.not_granted',
    });
    assert.throws(() => owner.read(Post).includes('comments' as never), {
      code: 'relation.plain_rows',
    });
    const both = dataHandle(dataSource, { models: [Post, Comment] });
    const posts = await asTenant(() =>
      both
        .query<Post>(Post)
        .where({ id: id('beta') })
        .includes('comments')
        .getMany(),
    );
    assert.deepEqual(ids(posts[0]?.comments ?? []), [id('c4')]);
    const narrow = dataHandle(dataSource, { models: [Post] });
    assert.throws(() => narrow.query(Post).includes('comments'), {
      code: 'statement.unknown_table',
    });
  });
});
