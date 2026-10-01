/**
 * Which rows a write names, from the shape of its condition: an equality or
 * `IN` on a one-column key among the top-level `AND` terms yields the keys
 * (decoded, intersected, without duplicates), an equality on every column of
 * a composite key yields that key, and anything else (an `OR`, a negated
 * list, a key column of another table, a partial composite key) is not a
 * key lookup.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { predicateKeys } from '../../src/change/statement-keys.js';
import { modelCodecs } from '../../src/codec/index.js';
import { column, defineTable } from '../../src/model/index.js';
import { and, col, eq, inList, not, or, TRUE, FALSE } from '../../src/statement/builders.js';

const Posts = defineTable({ table: 'sk_posts', columns: { title: column.string(40) } });

const Links = defineTable({
  table: 'sk_links',
  primaryKey: ['postId', 'tagId'],
  columns: { postId: column.bigint(), tagId: column.bigint() },
});

const posts = modelCodecs(Posts, 'postgres');
const links = modelCodecs(Links, 'postgres');
const id = col('sk_posts', 'id');
const title = eq(col('sk_posts', 'title'), 'a');

describe('predicateKeys', () => {
  it('reads the keys of a one-column key lookup', () => {
    assert.deepEqual(predicateKeys(posts, eq(id, 3)), [3]);
    assert.deepEqual(predicateKeys(posts, inList(id, [1, 2, 2, 3])), [1, 2, 3]);
    assert.deepEqual(predicateKeys(posts, and(title, inList(id, [1, 2]))), [1, 2]);
    assert.deepEqual(predicateKeys(posts, and(inList(id, [1, 2, 3]), eq(id, 2))), [2]);
    assert.deepEqual(predicateKeys(posts, and(eq(id, 1), FALSE)), []);
    assert.deepEqual(predicateKeys(posts, eq('id', 4)), [4], 'an unqualified column');
  });

  it('answers undefined for a condition that is not a key lookup', () => {
    assert.equal(predicateKeys(posts, TRUE), undefined);
    assert.equal(predicateKeys(posts, title), undefined);
    assert.equal(predicateKeys(posts, or(eq(id, 1), eq(id, 2))), undefined);
    assert.equal(predicateKeys(posts, not(inList(id, [1]))), undefined);
    assert.equal(predicateKeys(posts, eq(col('other', 'id'), 1)), undefined);
  });

  it('reads a composite key only when every column is pinned to one value', () => {
    const postId = col('sk_links', 'post_id');
    const tagId = col('sk_links', 'tag_id');
    assert.deepEqual(predicateKeys(links, and(eq(postId, 1n), eq(tagId, 2n))), [
      { postId: 1n, tagId: 2n },
    ]);
    assert.ok(Object.isFrozen(predicateKeys(links, and(eq(postId, 1n), eq(tagId, 2n)))?.[0]));
    assert.equal(predicateKeys(links, eq(postId, 1n)), undefined);
    assert.equal(predicateKeys(links, and(inList(postId, [1n, 2n]), eq(tagId, 2n))), undefined);
    assert.deepEqual(predicateKeys(links, and(eq(postId, 1n), eq(tagId, 2n), FALSE)), []);
  });
});
