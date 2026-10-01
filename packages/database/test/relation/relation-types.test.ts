/**
 * Loaded versus not loaded, in the types and at run time together: each
 * `@ts-expect-error` below marks a read the compiler refuses, and the same
 * read throws `relation.not_loaded` when it runs. A relation declared as
 * `Relation<V>` reads as `V` only on a `Loaded<T, S>` record (what
 * `includes` and `loadRelation` return), nested includes type their records
 * the same way, a relation is no column (`where`, `select`, `pluck` refuse
 * it), and include specs and their options are checked against the target.
 * A scope that includes relations loads them and types them as loaded.
 * Also the accessors `defineModel` installs: a relation named like a member
 * of the class is refused, an assigned value reads back as loaded, and a
 * subclass of a model is a model of its own (it may repeat a relation of its
 * parent, and a parent's relation it does not declare is none of its own).
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  ApplicationRecord,
  defineScope,
  loadRelation,
  runWithTenant,
  type Loaded,
  type ModelQuery,
  type Relation,
  type RelationKey,
  type RelationTarget,
  type RelationValue,
} from '../../src/index.js';
import { column, defineModel } from '../../src/model/index.js';
import {
  Author,
  Comment,
  Post,
  RELATION_MODELS,
} from '../conformance/relation/fixtures/relation-models.js';
import { openDataSource, suiteLifecycle } from '../query/fixtures/open-data-source.js';

const notLoaded = { code: 'relation.not_loaded' };
const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(1, fn);

/** Compile-time equality of two types. */
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
/**
 * Mutual assignability: a loaded relation's type is `Relation<V> & V`, which
 * reads and assigns exactly as `V` does.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const isTrue = <T extends true>(value: T): T => value;

describe('loaded relation types', () => {
  const lifecycle = suiteLifecycle();
  let postId = 0;

  before(async () => {
    await openDataSource(lifecycle, RELATION_MODELS);
    await asTenant(async () => {
      const author = await Author.create({ name: 'ada' });
      const post = await Post.create({ title: 'alpha', authorId: author.id });
      postId = post.id;
      await Comment.create({ body: 'c1', postId: post.id, authorId: author.id });
    });
  });

  it('refuses a relation read without includes, in the types and when it runs', async () => {
    const post = await asTenant(() => Post.find(postId));
    assert.throws(() => {
      // @ts-expect-error -- comments was not loaded
      return post.comments.length;
    }, notLoaded);
    assert.throws(() => {
      // @ts-expect-error -- author was not loaded
      return post.author?.name;
    }, notLoaded);
  });

  it('types the relations includes named as loaded, and only those', async () => {
    const [post] = await asTenant(() =>
      Post.where({ id: postId })
        .includes({ comments: { include: ['author'] } })
        .getMany(),
    );
    assert.ok(post !== undefined);
    const [comment] = post.comments;
    assert.equal(comment?.author?.name, 'ada');
    assert.throws(() => {
      // @ts-expect-error -- the comments' post was not loaded
      return comment?.post.title;
    }, notLoaded);
    assert.throws(() => {
      // @ts-expect-error -- the post's author was not loaded
      return post.author?.name;
    }, notLoaded);
    const records = await asTenant(() => loadRelation(Post, [post], 'author'));
    assert.equal(records[0]?.author?.name, 'ada');
    assert.equal(records[0]?.comments.length, 1);
  });

  it('loads and types the relations a scope includes, after those of the query', async () => {
    const withComments = (query: ModelQuery<Post>) => query.includes('comments');
    const [post] = await asTenant(() => Post.where({ id: postId }).scope(withComments).getMany());
    assert.ok(post !== undefined);
    assert.equal(post.comments.length, 1);

    const withAuthor = defineScope<Post, [], Loaded<Post, 'author'>>((query) =>
      query.includes('author'),
    );
    const [both] = await asTenant(() =>
      Post.where({ id: postId }).includes('comments').scope(withAuthor).getMany(),
    );
    assert.ok(both !== undefined);
    assert.equal(both.comments.length, 1);
    assert.equal(both.author?.name, 'ada');

    const [plain] = await asTenant(() =>
      Post.where({ id: postId })
        .scope((query) => query.where({ title: 'alpha' }))
        .getMany(),
    );
    assert.throws(() => {
      // @ts-expect-error -- a scope that includes nothing loads nothing
      return plain?.comments.length;
    }, notLoaded);

    assert.throws(() => Post.all().includes('comments').scope(withComments), {
      code: 'relation.invalid_include',
    });
    assert.throws(
      () =>
        Post.all()
          .select('title')
          .scope(() => Post.all().includes('comments')),
      {
        code: 'relation.plain_rows',
      },
    );
  });

  it('keeps relations out of columns and include specs to relations', () => {
    assert.throws(
      // @ts-expect-error -- a relation is not a column
      () => Post.where({ comments: [] }),
      { code: 'statement.unknown_column' },
    );
    assert.throws(
      // @ts-expect-error -- a relation is not a column
      () => Post.all().select('comments'),
      { code: 'query.invalid_argument' },
    );
    assert.throws(
      // @ts-expect-error -- title is not a relation
      () => Post.all().includes('title'),
      { code: 'query.unknown_relation' },
    );
    assert.throws(
      // @ts-expect-error -- nope is not a column of Comment
      () => Post.all().includes({ comments: { where: { nope: 1 } } }),
      { code: 'statement.unknown_column' },
    );
    assert.throws(
      // @ts-expect-error -- title is not a relation of Comment
      () => Post.all().includes({ comments: { include: 'title' } }),
      { code: 'query.unknown_relation' },
    );
  });

  it('derives relation keys, values and targets', () => {
    isTrue<Equal<RelationKey<Post>, 'author' | 'comments' | 'tags' | 'notes'>>(true);
    isTrue<Equal<RelationValue<Post['comments']>, Comment[]>>(true);
    isTrue<Equal<RelationTarget<Post['comments']>, Comment>>(true);
    isTrue<Equal<RelationTarget<Post['author']>, Author>>(true);
    isTrue<Same<Loaded<Post, 'author'>['author'], Author | null>>(true);
    isTrue<Same<Loaded<Post, ['author', 'comments']>['comments'], Comment[]>>(true);
    isTrue<Same<Loaded<Post, { comments: { include: 'post' } }>['comments'][number]['post'], Post>>(
      true,
    );
    isTrue<Same<Loaded<Post, 'author'>['comments'], Post['comments']>>(true);
    const loaded: Post = {} as Loaded<Post, { comments: true }>;
    assert.ok(loaded !== undefined);
    assert.ok(true);
  });

  it('refuses a relation named like a member of its class', () => {
    class Shadowed extends ApplicationRecord {
      declare id: number;
      declare title: string;
      author(): string {
        return 'a method';
      }
    }
    assert.throws(
      () =>
        defineModel(Shadowed, {
          table: 'rl_shadowed',
          columns: { title: column.string(20) },
          relations: { author: { kind: 'belongsTo', target: () => Author } },
        }),
      { code: 'invalid_relation', field: 'relations.author' },
    );
  });

  it('refuses a relation named like a method of a class between the model and its parent', () => {
    class Middle extends Post {
      highlights(): string {
        return 'a method';
      }
    }
    class Leaf extends Middle {}
    assert.throws(
      () =>
        defineModel(Leaf, {
          table: 'rl_leaf',
          columns: { title: column.string(20) },
          relations: { highlights: { kind: 'hasMany', target: () => Comment, inverse: 'post' } },
        }),
      { code: 'invalid_relation', field: 'relations.highlights' },
    );
  });

  it('defines a subclass of a model that repeats a relation of its parent', () => {
    class Featured extends Post {}
    defineModel(Featured, {
      table: 'rl_featured',
      columns: { title: column.string(20) },
      relations: { author: { kind: 'belongsTo', target: () => Author, nullable: true } },
    });
    const featured = new Featured();
    assert.throws(() => featured.author, {
      code: 'relation.not_loaded',
      context: { model: 'Featured', relation: 'author' },
    });
    const author = new Author();
    featured.author = author;
    assert.equal(featured.author, author);
    assert.throws(() => new Post().author, {
      code: 'relation.not_loaded',
      context: { model: 'Post', relation: 'author' },
    });
  });

  it('reads a relation of the parent model as none of a subclass that does not declare it', () => {
    class Plain extends Post {}
    defineModel(Plain, { table: 'rl_plain', columns: { title: column.string(20) } });
    assert.throws(() => new Plain().comments, {
      code: 'query.unknown_relation',
      context: { model: 'Plain', relation: 'comments' },
    });

    class Renamed extends Post {}
    defineModel(Renamed, {
      table: 'rl_renamed',
      columns: { title: column.string(20), comments: column.string(20, { nullable: true }) },
    });
    const renamed = new Renamed();
    assert.equal(renamed.comments, undefined, 'a column of the subclass reads as a column');
  });

  it('resolves the model when the relation is read, whatever the order of definition', () => {
    class Base extends ApplicationRecord {
      declare author: Relation<Author | null>;
    }
    class Early extends Base {}
    defineModel(Early, { table: 'rl_early', columns: {} });
    defineModel(Base, {
      table: 'rl_base',
      columns: {},
      relations: { author: { kind: 'belongsTo', target: () => Author, nullable: true } },
    });
    assert.throws(() => new Early().author, {
      code: 'query.unknown_relation',
      context: { model: 'Early', relation: 'author' },
    });
    assert.throws(() => new Base().author, {
      code: 'relation.not_loaded',
      context: { model: 'Base', relation: 'author' },
    });
  });

  it('reads an assigned relation back as loaded, as an own enumerable property', () => {
    const post: { comments: Relation<Comment[]> } = Post.build({ title: 'draft' });
    assert.throws(() => post.comments, notLoaded);
    post.comments = [];
    assert.deepEqual(post.comments, []);
    assert.deepEqual(Object.getOwnPropertyDescriptor(post, 'comments')?.enumerable, true);
  });
});
