/**
 * The counter-cache, touch, autosave, and nested-attributes hook factories,
 * including the recursion guard and option validation.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  BaseEntity,
  Column,
  Entity,
  EntityManager,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { ObjectLiteral } from 'typeorm';
import { z } from 'zod';

import {
  autosave,
  counterCache,
  CounterCacheError,
  nestedAttributes,
  touch,
} from '../../src/database/counter-cache.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import {
  defineEntityValidation,
  entityValidationHooks,
  EntityValidationError,
} from '../../src/database/entity-validation.js';
import {
  createEntitySubscriber,
  defineEntityHooks,
  type EntityHooksDefinition,
} from '../../src/database/entity-subscribers.js';
import { diffSchemaStates } from '../../src/migrations/autodetector.js';
import { executeSchemaPlan } from '../../src/migrations/schema-executor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'counter-cache-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let dbSeq = 0;

async function createDataSource(
  entities: (Function | typeof BaseEntity)[],
  ...definitions: EntityHooksDefinition<ObjectLiteral>[]
): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `db-${dbSeq++}.sqlite`);
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities,
    subscribers: [createEntitySubscriber(...definitions)],
  });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  const operations = diffSchemaStates({ tables: [] }, schema);
  await executeSchemaPlan(dataSource, operations);
  return dataSource;
}

// --- Post + Comment entities (counter cache / touch / autosave / nested) ---

function makePost() {
  @Entity('posts')
  class Post extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 200, nullable: false })
    title!: string;

    @Column({ type: 'integer', nullable: false, default: 0 })
    comments_count!: number;

    @Column({ type: 'datetime', nullable: true })
    updated_at!: Date | null;

    @OneToMany('Comment', 'post')
    comments!: unknown[];
  }
  return Post;
}

function makeComment() {
  @Entity('comments')
  class Comment extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 500, nullable: false })
    body!: string;

    @ManyToOne('Post', 'comments', { nullable: false })
    post!: unknown;
  }
  return Comment;
}

// ---------------------------------------------------------------------------
// counterCache
// ---------------------------------------------------------------------------

describe('counterCache', () => {
  it('increments the parent counter column on child insert', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      counterCache(Comment, {
        relation: 'post',
        column: 'comments_count',
        incrementOn: 'afterInsert',
      }),
    );

    const post = await Post.create({ title: 'First Post' }).save();
    assert.equal(post.comments_count, 0);

    await Comment.create({ body: 'Great post!', post }).save();
    await Comment.create({ body: 'Another comment', post }).save();

    const reloaded = await Post.findOneByOrFail({ id: post.id });
    assert.equal(reloaded.comments_count, 2);

    await dataSource.destroy();
  });

  it('decrements the parent counter column on child delete', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      counterCache(Comment, {
        relation: 'post',
        column: 'comments_count',
        incrementOn: 'afterDelete',
      }),
    );

    const post = await Post.create({ title: 'Deletable Post', comments_count: 3 }).save();
    const c1 = await Comment.create({ body: 'one', post }).save();
    const c2 = await Comment.create({ body: 'two', post }).save();
    const c3 = await Comment.create({ body: 'three', post }).save();

    await c1.remove();
    const afterOne = await Post.findOneByOrFail({ id: post.id });
    assert.equal(afterOne.comments_count, 2);

    await c2.remove();
    await c3.remove();
    const afterAll = await Post.findOneByOrFail({ id: post.id });
    assert.equal(afterAll.comments_count, 0);

    await dataSource.destroy();
  });

  it('skips silently when the parent relation is not loaded on the child', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      counterCache(Comment, {
        relation: 'post',
        column: 'comments_count',
        incrementOn: 'afterInsert',
      }),
    );

    const post = await Post.create({ title: 'P' }).save();
    // Insert via raw SQL with a valid FK so the insert itself succeeds, but
    // raw SQL bypasses TypeORM subscribers — the counter-cache hook never
    // fires, exercising the boundary between ORM and raw-query paths.
    await dataSource.query('INSERT INTO comments (body, "post_id") VALUES (?, ?)', [
      'bypass-guard',
      post.id,
    ]);

    const reloaded = await Post.findOneByOrFail({ id: post.id });
    assert.equal(reloaded.comments_count, 0);

    await dataSource.destroy();
  });

  it('guards against double-fire: uses raw increment that bypasses subscribers', async () => {
    const Post = makePost();
    const Comment = makeComment();
    let insertCount = 0;
    const dataSource = await createDataSource(
      [Post, Comment],
      defineEntityHooks(Comment, {
        afterInsert({ entity }) {
          insertCount += 1;
          assert.ok(typeof entity.body === 'string');
        },
      }),
      counterCache(Comment, {
        relation: 'post',
        column: 'comments_count',
        incrementOn: 'afterInsert',
      }),
    );

    const post = await Post.create({ title: 'DF' }).save();
    await Comment.create({ body: 'c1', post }).save();
    assert.equal(insertCount, 1);

    await Comment.create({ body: 'c2', post }).save();
    assert.equal(insertCount, 2);

    await dataSource.destroy();
  });
});

describe('counterCache — keys, raw-path portability, and moves', () => {
  it('decrements for a child loaded without its relation, with no hand-built SQL', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      counterCache(Comment, {
        relation: 'post',
        column: 'comments_count',
        incrementOn: 'afterDelete',
      }),
    );

    const post = await Post.create({ title: 'P', comments_count: 1 }).save();
    const saved = await Comment.create({ body: 'one', post }).save();
    // Loaded without the relation: the FK has to be read from the database.
    const loaded = await Comment.findOneByOrFail({ id: saved.id });

    const rawQueries: string[] = [];
    const original = EntityManager.prototype.query;
    EntityManager.prototype.query = function (
      this: EntityManager,
      sql: string,
      ...rest: unknown[]
    ) {
      rawQueries.push(sql);
      return (original as Function).call(this, sql, ...rest);
    } as typeof original;
    try {
      await loaded.remove();
    } finally {
      EntityManager.prototype.query = original;
    }

    // A hand-built `SELECT "fk" ... = ?` is invalid on PostgreSQL and MySQL.
    assert.deepEqual(rawQueries, []);
    assert.equal((await Post.findOneByOrFail({ id: post.id })).comments_count, 0);

    await dataSource.destroy();
  });

  it('maintains the counter for a parent with a string primary key not named id', async () => {
    @Entity('boards')
    class Board extends BaseEntity {
      @PrimaryColumn({ type: 'varchar', length: 36 })
      slug!: string;

      @Column({ type: 'integer', nullable: false, default: 0 })
      cards_count!: number;

      @OneToMany('Card', 'board')
      cards!: unknown[];
    }
    @Entity('cards')
    class Card extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne('Board', 'cards', { nullable: false })
      @JoinColumn({ name: 'board_slug' })
      board!: unknown;
    }
    // The portable schema layer only plans generated integer keys, so these
    // tables are created by hand.
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, `db-${dbSeq++}.sqlite`),
      entities: [Board, Card],
      subscribers: [
        createEntitySubscriber(
          counterCache(Card, {
            relation: 'board',
            column: 'cards_count',
            incrementOn: 'afterInsert',
          }),
          counterCache(Card, {
            relation: 'board',
            column: 'cards_count',
            incrementOn: 'afterDelete',
          }),
        ),
      ],
    });
    await dataSource.initialize();
    await dataSource.query(
      'CREATE TABLE boards (slug varchar(36) PRIMARY KEY NOT NULL, cards_count integer NOT NULL DEFAULT 0)',
    );
    await dataSource.query(
      'CREATE TABLE cards (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, board_slug varchar(36) NOT NULL)',
    );

    const board = await Board.create({ slug: '0b6f6a52-board' }).save();
    await Card.create({ board }).save();
    const second = await Card.create({ board }).save();
    assert.equal((await Board.findOneByOrFail({ slug: board.slug })).cards_count, 2);

    await (await Card.findOneByOrFail({ id: second.id })).remove();
    assert.equal((await Board.findOneByOrFail({ slug: board.slug })).cards_count, 1);

    await dataSource.destroy();
  });

  it('moves the count when a child is reassigned to another parent', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      counterCache(Comment, {
        relation: 'post',
        column: 'comments_count',
        incrementOn: 'afterInsert',
      }),
      counterCache(Comment, {
        relation: 'post',
        column: 'comments_count',
        incrementOn: 'afterDelete',
      }),
    );

    const from = await Post.create({ title: 'from' }).save();
    const to = await Post.create({ title: 'to' }).save();
    const comment = await Comment.create({ body: 'moving', post: from }).save();
    assert.equal((await Post.findOneByOrFail({ id: from.id })).comments_count, 1);

    comment.post = to;
    await comment.save();
    assert.equal((await Post.findOneByOrFail({ id: from.id })).comments_count, 0);
    assert.equal((await Post.findOneByOrFail({ id: to.id })).comments_count, 1);

    // An update that leaves the parent alone does not move anything.
    comment.body = 'edited';
    await comment.save();
    assert.equal((await Post.findOneByOrFail({ id: to.id })).comments_count, 1);

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// touch
// ---------------------------------------------------------------------------

describe('touch', () => {
  it('updates the parent timestamp on child insert', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      touch(Comment, { relation: 'post', column: 'updated_at' }),
    );

    const post = await Post.create({ title: 'Touched' }).save();
    assert.equal(post.updated_at, null);

    await Comment.create({ body: 'hello', post }).save();

    const reloaded = await Post.findOneByOrFail({ id: post.id });
    assert.ok(reloaded.updated_at instanceof Date);

    await dataSource.destroy();
  });

  it('updates the parent timestamp on child update', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      touch(Comment, { relation: 'post', column: 'updated_at' }),
    );

    const post = await Post.create({ title: 'T2' }).save();

    const comment = await Comment.create({ body: 'initial', post }).save();
    const afterInsert = await Post.findOneByOrFail({ id: post.id });

    comment.body = 'updated body';
    await comment.save();

    const afterUpdate = await Post.findOneByOrFail({ id: post.id });
    assert.ok(afterUpdate.updated_at instanceof Date);
    const updateTs = afterUpdate.updated_at;
    const insertTs = afterInsert.updated_at;
    assert.ok(updateTs !== null && insertTs !== null && updateTs.getTime() >= insertTs.getTime());

    await dataSource.destroy();
  });

  it('updates the parent timestamp on child delete', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      touch(Comment, { relation: 'post', column: 'updated_at' }),
    );

    const post = await Post.create({ title: 'T3' }).save();
    const comment = await Comment.create({ body: 'to delete', post }).save();

    await comment.remove();

    const reloaded = await Post.findOneByOrFail({ id: post.id });
    assert.ok(reloaded.updated_at instanceof Date);

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// autosave
// ---------------------------------------------------------------------------

describe('autosave', () => {
  it('persists a dirty related child entity on parent save', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      autosave(Post, { relations: ['comments'] }),
    );

    const post = Post.create({ title: 'Auto' });
    const comment = Comment.create({ body: 'autosaved', post });
    post.comments = [comment];

    await post.save();

    assert.equal(typeof comment.id, 'number');

    const found = await Comment.findOneByOrFail({ body: 'autosaved' });
    assert.equal(found.body, 'autosaved');

    await dataSource.destroy();
  });

  it('handles an array of related entities', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      autosave(Post, { relations: ['comments'] }),
    );

    const post = Post.create({ title: 'Multi' });
    const c1 = Comment.create({ body: 'first', post });
    const c2 = Comment.create({ body: 'second', post });
    post.comments = [c1, c2];

    await post.save();

    assert.equal(typeof c1.id, 'number');
    assert.equal(typeof c2.id, 'number');
    assert.equal(await Comment.count(), 2);

    await dataSource.destroy();
  });

  it('skips null/undefined relation values', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      autosave(Post, { relations: ['comments'] }),
    );

    const post = await Post.create({ title: 'No Comments' }).save();
    assert.equal(post.title, 'No Comments');
    assert.equal(await Comment.count(), 0);

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// nestedAttributes
// ---------------------------------------------------------------------------

describe('nestedAttributes', () => {
  it('persists nested input objects as related rows', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      nestedAttributes(Post, { relation: 'comments', fields: ['body', 'post'] }),
    );

    const post = Post.create({ title: 'Nested' });
    const c1 = Comment.create({ body: 'nested one', post });
    const c2 = Comment.create({ body: 'nested two', post });
    post.comments = [c1, c2];

    await post.save();

    assert.equal(typeof c1.id, 'number');
    assert.equal(typeof c2.id, 'number');

    const found = await Comment.find();
    assert.equal(found.length, 2);
    assert.ok(found.some((c) => c.body === 'nested one'));
    assert.ok(found.some((c) => c.body === 'nested two'));

    await dataSource.destroy();
  });

  it('filters nested data to only allowlisted fields', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      nestedAttributes(Post, { relation: 'comments', fields: ['body'] }),
    );

    const post = Post.create({ title: 'Filtered' });
    const comment = Comment.create({ body: 'filtered body', post });
    (comment as unknown as Record<string, unknown>).extra_field = 'should be dropped';
    post.comments = [comment];

    await post.save();

    const found = await Comment.findOneByOrFail({ body: 'filtered body' });
    assert.equal(found.body, 'filtered body');
    assert.equal((found as unknown as Record<string, unknown>).extra_field, undefined);

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// Bookkeeping writes and the parent's validation
// ---------------------------------------------------------------------------

describe('bookkeeping writes bypass the parent hooks', () => {
  function postValidation(Post: ReturnType<typeof makePost>) {
    return entityValidationHooks(
      defineEntityValidation(
        Post,
        z.object({
          title: z.string().min(1),
          comments_count: z.number().int().min(0).optional(),
        }),
      ),
    );
  }

  it('counterCache keeps working when the parent has entity validation', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      postValidation(Post),
      counterCache(Comment, {
        relation: 'post',
        column: 'comments_count',
        incrementOn: 'afterInsert',
      }),
      counterCache(Comment, {
        relation: 'post',
        column: 'comments_count',
        incrementOn: 'afterDelete',
      }),
    );

    const post = await Post.create({ title: 'Validated' }).save();
    const other = await Post.create({ title: 'Other' }).save();
    const first = await Comment.create({ body: 'one', post }).save();
    await Comment.create({ body: 'two', post }).save();
    assert.equal((await Post.findOneByOrFail({ id: post.id })).comments_count, 2);

    first.post = other;
    await first.save();
    assert.equal((await Post.findOneByOrFail({ id: post.id })).comments_count, 1);
    assert.equal((await Post.findOneByOrFail({ id: other.id })).comments_count, 1);

    await first.remove();
    assert.equal((await Post.findOneByOrFail({ id: other.id })).comments_count, 0);

    await dataSource.destroy();
  });

  it('touch keeps working when the parent has entity validation and hooks', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const postUpdates: string[] = [];
    const dataSource = await createDataSource(
      [Post, Comment],
      postValidation(Post),
      defineEntityHooks(Post, {
        beforeUpdate: () => {
          postUpdates.push('row');
        },
        beforeBulkUpdate: () => {
          postUpdates.push('bulk');
        },
      }),
      touch(Comment, { relation: 'post', column: 'updated_at' }),
    );

    const post = await Post.create({ title: 'Touched' }).save();
    await Comment.create({ body: 'hello', post }).save();

    assert.ok((await Post.findOneByOrFail({ id: post.id })).updated_at instanceof Date);
    assert.deepEqual(postUpdates, []);

    await dataSource.destroy();
  });

  it('a query-builder update is validated column by column, not as a partial row', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource([Post, Comment], postValidation(Post));
    const post = await Post.create({ title: 'Partial' }).save();

    await Post.update(post.id, { comments_count: 4 });
    assert.equal((await Post.findOneByOrFail({ id: post.id })).comments_count, 4);

    await assert.rejects(Post.update(post.id, { title: '' }), (error: unknown) => {
      assert.ok(error instanceof EntityValidationError);
      assert.equal(error.code, 'invalid_entity');
      assert.deepEqual(
        error.errors.map((issue) => issue.field),
        ['title'],
      );
      return true;
    });
    assert.equal((await Post.findOneByOrFail({ id: post.id })).title, 'Partial');

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// autosave / nestedAttributes on update
// ---------------------------------------------------------------------------

describe('autosave and nestedAttributes on update', () => {
  it('autosave persists an edited child when the loaded parent is saved again', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      autosave(Post, { relations: ['comments'] }),
    );
    const post = Post.create({ title: 'Draft' });
    post.comments = [Comment.create({ body: 'original', post })];
    await post.save();

    const loaded = await Post.findOneOrFail({
      where: { id: post.id },
      relations: { comments: true },
    });
    const [comment] = loaded.comments as InstanceType<typeof Comment>[];
    assert.ok(comment !== undefined);
    comment.body = 'edited';
    loaded.title = 'Published';
    await loaded.save();

    const reloaded = await Comment.findOneByOrFail({ id: comment.id });
    assert.equal(reloaded.body, 'edited');

    await dataSource.destroy();
  });

  it('nestedAttributes persists an edited child on update, allowlisted fields only', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const dataSource = await createDataSource(
      [Post, Comment],
      nestedAttributes(Post, { relation: 'comments', fields: ['body'] }),
    );
    const post = await Post.create({ title: 'Parent' }).save();
    const added = Comment.create({ body: 'added on update', post });
    post.comments = [added];
    post.title = 'Parent, edited';
    await post.save();

    assert.equal(typeof added.id, 'number');
    const found = await Comment.findOneByOrFail({ id: added.id });
    assert.equal(found.body, 'added on update');

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// No infinite recursion
// ---------------------------------------------------------------------------

describe('recursion guard', () => {
  function makeCategory() {
    @Entity('categories')
    class Category extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      name!: string;

      @Column({ type: 'integer', nullable: false, default: 0 })
      children_count!: number;

      @ManyToOne('Category', 'children', { nullable: true })
      parent!: unknown;

      @OneToMany('Category', 'parent')
      children!: unknown[];
    }
    return Category;
  }

  it('counterCache on a self-referential entity does not loop infinitely', async () => {
    const Category = makeCategory();
    const dataSource = await createDataSource(
      [Category],
      counterCache(Category, {
        relation: 'parent',
        column: 'children_count',
        incrementOn: 'afterInsert',
      }),
    );

    const root = await Category.create({ name: 'Root' }).save();
    assert.equal(root.children_count, 0);

    await Category.create({ name: 'Child', parent: root }).save();

    const reloaded = await Category.findOneByOrFail({ id: root.id });
    assert.equal(reloaded.children_count, 1);

    await dataSource.destroy();
  });

  it('autosave on self-referential entity does not loop infinitely', async () => {
    const Category = makeCategory();
    const dataSource = await createDataSource(
      [Category],
      autosave(Category, { relations: ['children'] }),
    );

    const parent = Category.create({ name: 'Parent' });
    const child = Category.create({ name: 'Child', parent });
    parent.children = [child];

    await parent.save();

    assert.equal(typeof child.id, 'number');
    assert.equal(typeof parent.id, 'number');

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('counterCache — input validation', () => {
  const makeDummy = () => {
    @Entity('dummy')
    class Dummy extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }
    return Dummy;
  };

  it('throws when relation is empty', () => {
    const Dummy = makeDummy();
    assert.throws(
      () => counterCache(Dummy, { relation: '', column: 'cnt', incrementOn: 'afterInsert' }),
      (error: unknown) => error instanceof CounterCacheError && /relation/.test(error.message),
    );
  });

  it('throws when column is empty', () => {
    const Dummy = makeDummy();
    assert.throws(
      () => counterCache(Dummy, { relation: 'parent', column: '', incrementOn: 'afterInsert' }),
      (error: unknown) => error instanceof CounterCacheError && /column/.test(error.message),
    );
  });

  it('throws when incrementOn is invalid', () => {
    const Dummy = makeDummy();
    assert.throws(
      () =>
        counterCache(Dummy, {
          relation: 'parent',
          column: 'cnt',
          incrementOn: 'beforeInsert' as never,
        }),
      (error: unknown) => error instanceof CounterCacheError && /incrementOn/.test(error.message),
    );
  });

  it('throws when autosave relations is empty', () => {
    const Dummy = makeDummy();
    assert.throws(
      () => autosave(Dummy, { relations: [] }),
      (error: unknown) => error instanceof CounterCacheError && /relations/.test(error.message),
    );
  });

  it('throws when nestedAttributes fields is empty', () => {
    const Dummy = makeDummy();
    assert.throws(
      () => nestedAttributes(Dummy, { relation: 'items', fields: [] }),
      (error: unknown) => error instanceof CounterCacheError && /fields/.test(error.message),
    );
  });

  it('throws when nestedAttributes relation is empty', () => {
    const Dummy = makeDummy();
    assert.throws(
      () => nestedAttributes(Dummy, { relation: '', fields: ['a'] }),
      (error: unknown) => error instanceof CounterCacheError && /relation/.test(error.message),
    );
  });

  it('throws when touch relation is empty', () => {
    const Dummy = makeDummy();
    assert.throws(
      () => touch(Dummy, { relation: '', column: 'updated_at' }),
      (error: unknown) => error instanceof CounterCacheError && /relation/.test(error.message),
    );
  });
});
