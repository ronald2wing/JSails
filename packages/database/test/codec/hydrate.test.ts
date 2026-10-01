/**
 * The owned hydrator: a row becomes an instance of the model class (without
 * running its constructor) or a plain object for a table, every column
 * decoded through its codec, with a hidden state slot holding `persisted`, a
 * frozen deep-copied baseline and the foreign key of each owning relation,
 * polymorphic ones included. Projections decode to frozen plain objects with
 * no slot, and a row missing a column is refused.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Row } from '../../src/engine/index.js';
import { ColumnValueError, column, defineModel } from '../../src/model/index.js';
import {
  CodecErrors,
  decodeRow,
  hydrate,
  modelCodecs,
  RECORD_STATE,
  recordState,
  setRecordState,
} from '../../src/index.js';
import { Note, Post, PostTag } from '../statement/fixtures/tenant-models.js';

const POST_ROW: Row = Object.freeze({
  id: 5,
  title: 'Hello',
  slug: 'hello',
  status: 'live',
  views: 3,
  tenant_id: 7,
  published_at: '2026-02-03T04:05:06.007Z',
  preferences: '{"theme":"dark","size":9}',
  body: null,
  author_id: 11,
});

describe('hydrate', () => {
  it('makes an instance of the model class without running its constructor', () => {
    let constructed = 0;
    class Counted {
      declare id: number;
      declare name: string;
      constructor() {
        constructed += 1;
      }
      greet(): string {
        return `hi ${this.name}`;
      }
    }
    defineModel(Counted, { table: 'hy_counted', columns: { name: column.string(20) } });
    const record = hydrate<Counted>(modelCodecs(Counted, 'sqlite'), { id: 1, name: 'Ada' });
    assert.equal(constructed, 0);
    assert.ok(record instanceof Counted);
    assert.equal(record.greet(), 'hi Ada');
  });

  it('decodes every column and hides the state slot from JSON and enumeration', () => {
    const record = hydrate<Post>(modelCodecs(Post, 'sqlite'), POST_ROW);
    assert.ok(record instanceof Post);
    assert.equal(record.title, 'Hello');
    assert.deepEqual(record.publishedAt, new Date('2026-02-03T04:05:06.007Z'));
    assert.deepEqual(record.preferences, { theme: 'dark', size: 9 });
    assert.equal(record.body, null);
    assert.deepEqual(Object.keys(record), [
      'id',
      'title',
      'slug',
      'status',
      'views',
      'tenantId',
      'publishedAt',
      'preferences',
      'body',
      'authorId',
    ]);
    assert.equal(JSON.stringify(record).includes('persisted'), false);
    assert.equal(RECORD_STATE, Symbol.for('jsails.record.state'));
    const state = recordState(record);
    assert.ok(state !== undefined);
    assert.equal(state.persisted, true);
    assert.deepEqual(state.fks, { author: 11 });
    assert.deepEqual(state.baseline, { ...record });
  });

  it('keeps a baseline that changing the record in place cannot reach', () => {
    const record = hydrate<Post>(modelCodecs(Post, 'sqlite'), POST_ROW);
    const state = recordState(record);
    assert.ok(state !== undefined);
    assert.ok(Object.isFrozen(state) && Object.isFrozen(state.baseline));
    record.publishedAt?.setUTCFullYear(2000);
    (record.preferences as { theme: string }).theme = 'light';
    record.title = 'Changed';
    assert.deepEqual(state.baseline.publishedAt, new Date('2026-02-03T04:05:06.007Z'));
    assert.deepEqual(state.baseline.preferences, { theme: 'dark', size: 9 });
    assert.ok(Object.isFrozen(state.baseline.preferences));
    assert.equal(state.baseline.title, 'Hello');
  });

  it('records each owning foreign key, polymorphic ones as a type and id', () => {
    class Holder {}
    defineModel(Holder, {
      table: 'hy_holders',
      columns: {},
      relations: {
        post: { kind: 'belongsTo', target: () => Post, nullable: true },
        subject: { kind: 'belongsTo', polymorphic: true, nullable: true },
      },
    });
    const codecs = modelCodecs(Holder, 'sqlite');
    const state = recordState(
      hydrate(codecs, { id: 1, post_id: null, subject_type: 'Post', subject_id: 9 }),
    );
    assert.deepEqual(state?.fks, { post: null, subject: { type: 'Post', id: 9 } });
  });

  it('makes a plain object for a table, keyed by a string tenant', () => {
    const record = hydrate(modelCodecs(Note, 'postgres'), { id: 1, org: 'acme', text: 'x' });
    assert.equal(Object.getPrototypeOf(record), Object.prototype);
    assert.deepEqual({ ...record }, { id: 1, org: 'acme', text: 'x' });
    const link = recordState(
      hydrate(modelCodecs(PostTag, 'sqlite'), { id: 1, tenant_id: 7, post_id: 2, tag_id: 3 }),
    );
    assert.deepEqual(link?.fks, { post: 2, tag: 3 });
  });

  it('refuses a row that lacks a column or holds a value the codec refuses', () => {
    const { body: _body, ...partial } = POST_ROW;
    assert.throws(
      () => hydrate(modelCodecs(Post, 'sqlite'), partial),
      (error: unknown) =>
        CodecErrors.is(error, 'incomplete_row') && error.context.column === 'body',
    );
    assert.throws(
      () => hydrate(modelCodecs(Post, 'sqlite'), { ...POST_ROW, status: 'gone' }),
      (error: unknown) =>
        error instanceof ColumnValueError &&
        error.code === 'invalid_stored_value' &&
        error.field === 'status',
    );
    assert.throws(
      () => hydrate(modelCodecs(Post, 'sqlite'), { ...POST_ROW, title: null }),
      (error: unknown) => error instanceof ColumnValueError && error.field === 'title',
    );
  });
});

describe('record state and projections', () => {
  it('lets the write pipeline replace the state slot, still hidden', () => {
    const record = hydrate<Post>(modelCodecs(Post, 'sqlite'), POST_ROW);
    setRecordState(record, { persisted: false, baseline: { title: 'x' }, fks: {} });
    assert.deepEqual(recordState(record), { persisted: false, baseline: { title: 'x' }, fks: {} });
    assert.equal(Object.keys(record).includes(String(RECORD_STATE)), false);
    assert.equal(recordState({}), undefined);
    assert.equal(recordState(Object.create(record) as object), undefined, 'only an own slot');
  });

  it('decodes a projection to a frozen plain object with no state slot', () => {
    const codecs = modelCodecs(Post, 'sqlite');
    const row = decodeRow(codecs, { title: 'T', published_at: null }, ['title', 'publishedAt']);
    assert.deepEqual(row, { title: 'T', publishedAt: null });
    assert.ok(Object.isFrozen(row));
    assert.equal(recordState(row), undefined);
    assert.equal(Object.keys(decodeRow(codecs, POST_ROW)).length, codecs.columns.length);
    assert.throws(
      () => decodeRow(codecs, POST_ROW, ['nope']),
      (error: unknown) =>
        CodecErrors.is(error, 'unknown_property') && error.context.field === 'nope',
    );
    for (const property of ['a b', 'title desc', '', 'x'.repeat(200)]) {
      assert.throws(
        () => decodeRow(codecs, POST_ROW, [property]),
        (error: unknown) =>
          CodecErrors.is(error, 'unknown_property') && error.context.field !== property,
        `${JSON.stringify(property)} is reported, not echoed`,
      );
    }
    assert.throws(
      () => decodeRow(codecs, {}, ['title']),
      (error: unknown) => CodecErrors.is(error, 'incomplete_row'),
    );
  });
});
