/**
 * The public surface of records and queries matches its frozen lists
 * (`fixtures/public-surface.ts`): nothing reaches the engine, the statement
 * IR or a TypeORM object (no `apply`, `builder`, `repository`, `manager` or
 * `engine`), a data source does not extend a TypeORM `DataSource`, and the
 * types reject what the runtime refuses: an unknown column in `Where<T>`, an
 * order on a method, and `save` on a selected row.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ApplicationRecord,
  dataHandle,
  JsailsDataSource,
  ModelQuery,
  query,
  resolveDatabaseConfig,
  type Where,
} from '../../src/index.js';
import { unguarded } from '../../src/unguarded/index.js';
import {
  DATA_HANDLE_MEMBERS,
  DATA_SOURCE_MEMBERS,
  MODEL_QUERY_METHODS,
  RECORD_METHODS,
  RECORD_STATICS,
  UNGUARDED_MEMBERS,
} from './fixtures/public-surface.js';
import { MODELS, Post } from './fixtures/query-models.js';

const FORBIDDEN = ['apply', 'builder', 'repository', 'manager', 'engine', 'getRepository'];

function members(prototype: object): string[] {
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .toSorted();
}

describe('records and queries public surface', () => {
  it('matches the frozen lists', async () => {
    assert.deepEqual(members(ModelQuery.prototype), MODEL_QUERY_METHODS);
    assert.deepEqual(
      Object.getOwnPropertyNames(ApplicationRecord)
        .filter((name) => !['length', 'name', 'prototype'].includes(name))
        .toSorted(),
      RECORD_STATICS,
    );
    assert.deepEqual(members(ApplicationRecord.prototype), RECORD_METHODS);
    assert.equal(Object.getPrototypeOf(ApplicationRecord.prototype), Object.prototype);
    assert.equal(Object.getPrototypeOf(JsailsDataSource.prototype), Object.prototype);

    const dataSource = new JsailsDataSource({
      config: resolveDatabaseConfig({ file: ':memory:' }, { env: {} }),
      models: MODELS,
    });
    try {
      assert.deepEqual(
        [
          ...new Set([...Object.keys(dataSource), ...members(JsailsDataSource.prototype)]),
        ].toSorted(),
        DATA_SOURCE_MEMBERS,
      );
      assert.deepEqual(Object.keys(unguarded(dataSource)).toSorted(), UNGUARDED_MEMBERS);
      assert.deepEqual(
        Object.keys(dataHandle(dataSource, { models: [Post] })).toSorted(),
        DATA_HANDLE_MEMBERS,
      );
      const q = query(Post);
      for (const name of FORBIDDEN) {
        assert.equal(name in q, false, `a query has no ${name}`);
        assert.equal(name in dataSource, false, `a data source has no ${name}`);
        // `in` would find Function.prototype.apply: a model's own statics are what count.
        assert.equal(Object.hasOwn(Post, name), false, `a model has no ${name}`);
        assert.equal(Object.hasOwn(ApplicationRecord, name), false, `a record has no ${name}`);
      }
      assert.equal(Object.isFrozen(q), true);
    } finally {
      await dataSource.close();
    }
  });

  it('rejects unknown columns, methods and record writes in the types', () => {
    const ok: Where<Post> = { title: 'x', views: { gte: 1 }, publishedAt: null };
    // @ts-expect-error `Where<Post>` has no column `nope`.
    const unknown: Where<Post> = { nope: 1 };
    // @ts-expect-error A method is not a column.
    const method: Where<Post> = { headline: 'x' };
    // @ts-expect-error `views` holds numbers.
    const mistyped: Where<Post> = { views: 'many' };
    assert.equal([ok, unknown, method, mistyped].length, 4);

    const typed = (q: ModelQuery<Post>): void => {
      // @ts-expect-error `orderBy` takes columns only.
      q.orderBy('nope');
      // @ts-expect-error `pluck` takes columns only.
      void q.pluck('headline');
      const rows = q.select('id', 'title');
      void rows.getMany().then((selected) => {
        const [first] = selected;
        // @ts-expect-error A selected row is a plain row: it has no `save`.
        void first?.save();
        // @ts-expect-error A selected row has only the selected columns.
        void first?.views;
        return first?.title;
      });
    };
    assert.equal(typeof typed, 'function');
  });
});
