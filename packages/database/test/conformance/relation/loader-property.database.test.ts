/**
 * The loader agrees with the naive load on the run's driver: for random
 * parents, conditions, orders and per-parent limits (seeded, so a failure
 * names the case that reproduces it), loading a relation for all parents at
 * once gives every parent exactly the rows, in exactly the order, of one
 * query per parent with the same condition, order (primary key last) and
 * limit. Both a direct `hasMany` (posts' comments) and a through relation
 * (authors' comments through their posts) are drawn, over data with ties,
 * `null` keys and a second tenant's rows on the first tenant's parents.
 */

import assert from 'node:assert/strict';
import { before, it } from 'node:test';

import {
  insertAll,
  query,
  runWithTenant,
  type OrderBy,
  type WhereInput,
} from '../../../src/index.js';
import { forEachDriver } from '../../../src/testing/index.js';
import { openDataSource, suiteLifecycle } from '../../query/fixtures/open-data-source.js';
import { Author, Comment, Post, RELATION_MODELS } from './fixtures/relation-models.js';

const CASES = 40;
const SEED = 0x5eed_0009;

/** A small seeded generator (mulberry32), so every case is reproducible. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Draw {
  readonly random: () => number;
  int(below: number): number;
  pick<T>(items: readonly T[]): T;
  subset<T>(items: readonly T[]): T[];
}

function draw(seed: number): Draw {
  const random = generator(seed);
  const int = (below: number): number => Math.floor(random() * below);
  return {
    random,
    int,
    pick: (items) => items[int(items.length)] as (typeof items)[number],
    subset: (items) => items.filter(() => random() < 0.5),
  };
}

/** A random condition on comments, or `undefined` for none. */
function whereOf(d: Draw, authorIds: readonly number[]): WhereInput<Comment> | undefined {
  const where: Record<string, unknown> = {};
  if (d.random() < 0.4) {
    where['score'] = d.pick([{ gte: d.int(5) }, { lt: d.int(5) }, [d.int(5), d.int(5)], d.int(5)]);
  }
  if (d.random() < 0.3) where['approved'] = d.random() < 0.5;
  if (d.random() < 0.25) where['authorId'] = d.random() < 0.5 ? null : d.subset(authorIds);
  return Object.keys(where).length === 0 ? undefined : where;
}

/** A random order of zero to two terms. */
function orderOf(d: Draw): OrderBy<Comment>[] {
  const columns = d.subset(['score', 'body', 'authorId'] as const).slice(0, 2);
  return columns.map((column) => ({ column, direction: d.pick(['asc', 'desc'] as const) }));
}

void forEachDriver('relation loader against the naive load', () => {
  const lifecycle = suiteLifecycle();
  let authorIds: number[] = [];
  let postIds: number[] = [];

  before(async () => {
    await openDataSource(lifecycle, RELATION_MODELS);
    const d = draw(SEED);
    await runWithTenant(1, async () => {
      await insertAll(
        Author,
        Array.from({ length: 8 }, (_, index) => ({ name: `author ${index}` })),
      );
      authorIds = await query<Author>(Author).orderBy('id').pluck('id');
      await insertAll(
        Post,
        Array.from({ length: 30 }, (_, index) => ({
          title: `post ${index}`,
          authorId: d.random() < 0.2 ? null : d.pick(authorIds.slice(0, 6)),
        })),
      );
      postIds = await query<Post>(Post).orderBy('id').pluck('id');
      const comments = postIds.flatMap((postId) =>
        Array.from({ length: d.int(13) }, () => ({
          body: d.pick(['a', 'b', 'c', 'B']),
          score: d.int(5),
          approved: d.random() < 0.5,
          postId,
          authorId: d.random() < 0.3 ? null : d.pick(authorIds),
        })),
      );
      await insertAll(Comment, comments);
    });
    await runWithTenant(2, () =>
      insertAll(
        Comment,
        postIds.slice(0, 10).map((postId) => ({ body: 'a', score: 0, postId })),
      ),
    );
  });

  it(`gives every parent the rows of its own query, in ${CASES} seeded cases`, async () => {
    for (let index = 0; index < CASES; index += 1) {
      const seed = SEED + index + 1;
      const d = draw(seed);
      const where = whereOf(d, authorIds);
      const order = orderOf(d);
      const limit = d.random() < 0.5 ? undefined : 1 + d.int(4);
      const options = {
        ...(where === undefined ? {} : { where }),
        ...(order.length === 0 ? {} : { order }),
        ...(limit === undefined ? {} : { limit }),
      };
      const naive = (scope: WhereInput<Comment>): Promise<number[]> => {
        let q = Comment.where(scope);
        if (where !== undefined) q = q.where(where);
        q = q.orderBy([...order, 'id']);
        if (limit !== undefined) q = q.limit(limit);
        return q.pluck('id');
      };
      const label = `case seed ${seed}: ${JSON.stringify(options)}`;
      await runWithTenant(1, async () => {
        if (d.random() < 0.5) {
          const parents = await Post.where({ id: d.subset(postIds) })
            .orderBy('id')
            .includes({ comments: options })
            .getMany();
          for (const post of parents) {
            assert.deepEqual(
              post.comments.map((comment) => comment.id),
              await naive({ postId: post.id }),
              label,
            );
          }
        } else {
          const parents = await Author.where({ id: d.subset(authorIds) })
            .orderBy('id')
            .includes({ comments: options })
            .getMany();
          for (const author of parents) {
            const posts = await Post.where({ authorId: author.id }).pluck('id');
            assert.deepEqual(
              author.comments.map((comment) => comment.id),
              posts.length === 0 ? [] : await naive({ postId: posts }),
              label,
            );
          }
        }
      });
    }
  });
});
