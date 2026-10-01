/**
 * The statement of a relation load, offline: its SQL per relation kind and
 * dialect (the matched column first in the order, a window for a per-parent
 * limit, a `belongsTo` unordered, a through load's link joined and its owner
 * key carried, a polymorphic inverse's type condition), the key identities a
 * load groups by, and how keys are split: one array parameter on
 * PostgreSQL, `bindLimit - residual` keys per statement elsewhere, the
 * residual read off the guarded statement.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BIND_LIMITS,
  compileStatement,
  type Dialect,
  type SqlValue,
} from '../../src/engine/index.js';
import { createStatementCatalog, runWithTenant } from '../../src/index.js';
import { TRUE } from '../../src/statement/builders.js';
import { compileGuarded } from '../../src/statement/guarded-compile.js';
import {
  countStatement,
  keyCapacity,
  keyChunks,
  keyIdentity,
  loadStatement,
  residualParameters,
} from '../../src/relation/load-statement.js';
import { resolveLoadPlan } from '../../src/relation/relation-plan.js';
import {
  Author,
  Comment,
  Note,
  Post,
  RELATION_MODELS,
} from '../conformance/relation/fixtures/relation-models.js';

function planOf(
  dialect: Dialect,
  model: typeof Post | typeof Author | typeof Comment,
  name: string,
) {
  const catalog = createStatementCatalog({ dialect, models: RELATION_MODELS });
  const plan = resolveLoadPlan(catalog, catalog.codecs(model), name);
  assert.ok(plan.kind !== 'polymorphic');
  return { catalog, plan };
}

const NO_SHAPE = { where: TRUE, order: [] } as const;

describe('relation load statements', () => {
  it('orders a to-many load by the matched column, then the primary key', () => {
    const { plan } = planOf('sqlite', Post, 'comments');
    const { sql, params } = compileStatement(loadStatement(plan, [1, 2], NO_SHAPE), 'sqlite');
    assert.match(
      sql,
      /FROM "rl_comments" WHERE "rl_comments"\."post_id" IN \(\?, \?\) ORDER BY "rl_comments"\."post_id" ASC, "rl_comments"\."id" ASC$/,
    );
    assert.deepEqual(params, [1, 2]);
  });

  it('limits rows per parent with a window, and a plain load with a cap', () => {
    const { plan } = planOf('postgres', Post, 'comments');
    const windowed = compileStatement(
      loadStatement(plan, [1, 2], { ...NO_SHAPE, limit: 3 }),
      'postgres',
    );
    assert.match(
      windowed.sql,
      /ROW_NUMBER\(\) OVER \(PARTITION BY "rl_comments"\."post_id" ORDER BY "rl_comments"\."id" ASC\)/,
    );
    assert.match(windowed.sql, /"rl_comments"\."post_id" = ANY\(\$1\)/);
    assert.deepEqual(windowed.params, ['{"1","2"}', 3]);
    const capped = compileStatement(loadStatement(plan, [1], { ...NO_SHAPE, cap: 11 }), 'postgres');
    assert.match(capped.sql, / LIMIT \$2$/);
  });

  it('reads a belongsTo unordered, and a through load with its link owner key', () => {
    const belongs = planOf('sqlite', Comment, 'post');
    const { sql } = compileStatement(loadStatement(belongs.plan, [1], NO_SHAPE), 'sqlite');
    assert.doesNotMatch(sql, /ORDER BY/);
    assert.match(sql, /WHERE "rl_posts"\."id" = \?|WHERE "rl_posts"\."id" IN \(\?\)/);
    const through = planOf('sqlite', Post, 'tags');
    const linked = compileStatement(loadStatement(through.plan, [1], NO_SHAPE), 'sqlite').sql;
    assert.match(linked, /JOIN "rl_post_tags" ON /);
    assert.match(linked, /"rl_post_tags"\."post_id" AS "jsails_owner"/);
  });

  it('matches a polymorphic inverse on its type as well', () => {
    const catalog = createStatementCatalog({ dialect: 'sqlite', models: RELATION_MODELS });
    const plan = resolveLoadPlan(catalog, catalog.codecs(Post), 'notes');
    assert.ok(plan.kind === 'hasMany');
    const { sql, params } = compileStatement(loadStatement(plan, [4], NO_SHAPE), 'sqlite');
    assert.match(sql, /"rl_notes"\."subject_type" = \?/);
    assert.deepEqual(params, [4, 'Post']);
    assert.equal(resolveLoadPlan(catalog, catalog.codecs(Note), 'subject').kind, 'polymorphic');
  });

  it('counts per key with one grouped statement', () => {
    const { plan } = planOf('mariadb', Post, 'comments');
    const { sql } = compileStatement(countStatement(plan, [1, 2], TRUE), 'mariadb');
    assert.match(sql, /COUNT\(\*\) AS `jsails_count`/);
    assert.match(sql, /GROUP BY `rl_comments`\.`post_id`$/);
  });

  it('identifies keys by their stored form', () => {
    assert.equal(keyIdentity(1), keyIdentity(1n));
    assert.notEqual(keyIdentity(1), keyIdentity('1'));
    assert.notEqual(keyIdentity(true), keyIdentity(1));
    assert.equal(keyIdentity(new Uint8Array([1, 255])), 'x01ff');
  });

  it('splits keys at the bind limit less the residual parameters', () => {
    assert.equal(keyCapacity('postgres', 10), Number.POSITIVE_INFINITY);
    assert.equal(keyCapacity('sqlite', 1), BIND_LIMITS.sqlite - 1);
    assert.equal(keyCapacity('mariadb', 70_000), 1);
    const keys = Array.from({ length: 7 }, (_, index) => index);
    assert.deepEqual(keyChunks(keys, 3), [[0, 1, 2], [3, 4, 5], [6]]);
    assert.deepEqual(keyChunks(keys, Number.POSITIVE_INFINITY), [keys]);
    const { catalog, plan } = planOf('sqlite', Post, 'comments');
    const build = (keys: readonly SqlValue[]) =>
      loadStatement(plan, keys, { ...NO_SHAPE, limit: 2 });
    // Under a tenant the guard binds the tenant value; the window binds its limit.
    const residual = runWithTenant(1, () => residualParameters(catalog, build, 1));
    assert.equal(residual, 2);
    const capacity = keyCapacity('sqlite', residual);
    const full = Array.from({ length: capacity }, (_, index) => index);
    runWithTenant(1, () => {
      assert.equal(compileGuarded(catalog, build(full)).params.length, BIND_LIMITS.sqlite);
      assert.throws(() => compileGuarded(catalog, build([...full, capacity])), {
        code: 'too_many_parameters',
      });
    });
  });
});
