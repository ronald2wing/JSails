/**
 * Renaming a qualifier for a relation subquery: every reference to the old
 * name is renamed, outside a nested select that reads a table under that
 * name itself (where the name means that table); a fresh alias is one the
 * predicate does not mention anywhere; renaming to the same name is the
 * identity.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileStatement, ir, type Predicate } from '../../src/index.js';
import { freshAlias, namesIn, requalify } from '../../src/query/requalify.js';

const { and, col, eq, exists, select, table, compareColumns } = ir;

function render(predicate: Predicate): string {
  const sql = compileStatement(
    select(table('outer'), {
      columns: [{ column: col('outer', 'id'), as: 'id' }],
      where: predicate,
    }),
    'sqlite',
  ).sql;
  return sql.slice(sql.indexOf('WHERE ') + 6);
}

describe('requalify', () => {
  const nested = exists(
    select(table('q_posts'), {
      columns: [{ column: col('q_posts', 'id'), as: 'id' }],
      where: eq(col('q_posts', 'title'), 'inner'),
    }),
  );
  const other = exists(
    select(table('q_comments'), {
      columns: [{ column: col('q_comments', 'id'), as: 'id' }],
      where: compareColumns(col('q_comments', 'post_id'), '=', col('q_posts', 'id')),
    }),
  );

  it('renames references outside shadowing selects only', () => {
    const renamed = requalify(
      and(eq(col('q_posts', 'title'), 'x'), nested, other),
      'q_posts',
      'q_posts_1',
    );
    assert.equal(
      render(renamed),
      '("q_posts_1"."title" = ?) AND (EXISTS (SELECT "q_posts"."id" AS "id" FROM "q_posts" WHERE "q_posts"."title" = ?)) AND (EXISTS (SELECT "q_comments"."id" AS "id" FROM "q_comments" WHERE "q_comments"."post_id" = "q_posts_1"."id"))',
    );
    assert.equal(Object.isFrozen(renamed), true);
    const same = eq(col('q_posts', 'title'), 'x');
    assert.equal(requalify(same, 'q_posts', 'q_posts'), same);
  });

  it('picks an alias the predicate mentions nowhere', () => {
    const names = namesIn(and(nested, other, eq(col('q_posts_1', 'id'), 1)));
    assert.deepEqual([...names].toSorted(), ['q_comments', 'q_posts', 'q_posts_1']);
    assert.equal(freshAlias('q_posts', names), 'q_posts_2');
    assert.equal(freshAlias('q_tags', names), 'q_tags_1');
  });
});
