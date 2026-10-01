/**
 * Column codecs: the layered chain (order on the way in and out, queryable as
 * the weakest layer, lookups fanned out through every stored form), the enum
 * and data-contract layers (with a real `jsails/data` contract), a model's
 * codecs per dialect with `NULL` handled once, and the refusal to build an
 * encrypted column without a seal provider.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineData } from 'jsails/data';
import { z } from 'jsails/zod';

import type { SqlValue } from '../../src/engine/index.js';
import {
  ColumnValueError,
  column,
  defineTable,
  ModelSpecError,
  type ModelSpec,
} from '../../src/model/index.js';
import {
  chainCodecs,
  CodecErrors,
  dataContractCodec,
  decodeColumn,
  encodeColumn,
  enumCodec,
  modelCodecs,
  supports,
  type CodecColumn,
  type CodecLayer,
} from '../../src/index.js';
import { Post } from '../statement/fixtures/tenant-models.js';

const INTEGER = Object.freeze({ kind: 'integer' }) as { readonly kind: 'integer' };

function layer(name: string, trace: string[], queryable: CodecLayer['queryable']): CodecLayer {
  return {
    queryable,
    encode: (value) => {
      trace.push(`encode ${name}`);
      return value;
    },
    decode: (value) => {
      trace.push(`decode ${name}`);
      return value;
    },
  };
}

function valueError(code: string, field?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ColumnValueError, String(error));
    assert.equal(error.code, code);
    if (field !== undefined) assert.equal(error.field, field);
    return true;
  };
}

describe('chainCodecs', () => {
  it('encodes outermost first, decodes innermost first, and is as queryable as its weakest layer', () => {
    const trace: string[] = [];
    const codec = chainCodecs(INTEGER, [
      layer('contract', trace, 'full'),
      layer('portable', trace, 'equality'),
      layer('seal', trace, 'full'),
    ]);
    codec.encode(1);
    codec.decode(1);
    assert.deepEqual(trace, [
      'encode contract',
      'encode portable',
      'encode seal',
      'decode seal',
      'decode portable',
      'decode contract',
    ]);
    assert.equal(codec.queryable, 'equality');
    assert.equal(codec.encodeForLookup, undefined, 'no layer fans out');
    assert.ok(Object.isFrozen(codec));
    assert.throws(
      () => chainCodecs(INTEGER, []),
      (error: unknown) => CodecErrors.is(error, 'invalid_chain'),
    );
  });

  it('fans a lookup out through every layer that states several stored forms', () => {
    const codec = chainCodecs(INTEGER, [
      { queryable: 'full', encode: (v) => (v as number) + 1, decode: (v) => (v as number) - 1 },
      {
        queryable: 'equality',
        encode: (v) => `a${String(v)}`,
        decode: (v) => Number(String(v).slice(1)),
        encodeForLookup: (v) => [`a${String(v)}`, `b${String(v)}`],
      },
      {
        queryable: 'full',
        encode: (v) => `${String(v)}!`,
        decode: (v) => String(v).slice(0, -1),
        encodeForLookup: (v) => [`${String(v)}!`, `${String(v)}?`],
      },
    ]);
    assert.deepEqual(codec.encodeForLookup?.(1), ['a2!', 'a2?', 'b2!', 'b2?']);
    assert.equal(codec.encode(1), 'a2!');
  });

  it('ranks queryable levels', () => {
    assert.ok(supports('full', 'equality'));
    assert.ok(supports('equality', 'equality'));
    assert.ok(!supports('equality', 'full'));
    assert.ok(!supports('none', 'equality'));
  });
});

describe('the enum and data-contract layers', () => {
  it('lets only enum members in and out', () => {
    const codec = enumCodec(['draft', 'live'], 'status');
    assert.equal(codec.encode('live'), 'live');
    assert.throws(() => codec.encode('gone'), valueError('invalid_value', 'status'));
    assert.throws(() => codec.encode(1), valueError('invalid_value'));
    assert.throws(() => codec.decode('gone'), valueError('invalid_stored_value', 'status'));
    assert.equal(codec.queryable, 'full');
  });

  it('parses through a jsails/data contract both ways, writing its output', () => {
    const Settings = defineData({
      name: 'Settings',
      properties: { theme: z.enum(['light', 'dark']), size: z.number().int().default(12) },
    });
    const codec = dataContractCodec(Settings, 'settings');
    assert.deepEqual(codec.encode({ theme: 'dark' }), { theme: 'dark', size: 12 });
    assert.throws(() => codec.encode({ theme: 'blue' }), valueError('invalid_value', 'settings'));
    assert.throws(
      () => codec.encode({ theme: 'dark', extra: true }),
      valueError('invalid_value'),
      'a strict contract refuses unknown keys',
    );
    assert.throws(() => codec.decode({ size: 1 }), valueError('invalid_stored_value'));
    assert.equal(codec.queryable, 'none');
  });

  it('declares a data contract on a json column of a model', () => {
    const Settings = defineData({ name: 'Settings', properties: { on: z.boolean() } });
    const Table = defineTable({
      table: 'cc_settings',
      columns: { prefs: column.json({ data: Settings }) },
    });
    const prefs = modelCodecs(Table, 'postgres').property('prefs') as CodecColumn;
    assert.equal(encodeColumn(prefs, { on: true }), '{"on":true}');
    assert.deepEqual(decodeColumn(prefs, '{"on":false}'), { on: false });
    assert.throws(() => decodeColumn(prefs, '{"on":1}'), valueError('invalid_stored_value'));
  });
});

describe('modelCodecs', () => {
  it('chains each column from its declaration on each dialect', () => {
    const sqlite = modelCodecs(Post, 'sqlite');
    const mariadb = modelCodecs(Post, 'mariadb');
    const at = new Date('2026-05-06T07:08:09.010Z');
    const published = (codecs: typeof sqlite) => codecs.property('publishedAt') as CodecColumn;
    assert.equal(encodeColumn(published(sqlite), at), '2026-05-06T07:08:09.010Z');
    assert.equal(encodeColumn(published(mariadb), at), '2026-05-06 07:08:09.010');
    assert.deepEqual(decodeColumn(published(mariadb), '2026-05-06 07:08:09.010'), at);
    const status = sqlite.property('status') as CodecColumn;
    assert.equal(status.codec.queryable, 'full');
    assert.throws(() => encodeColumn(status, 'archived'), valueError('invalid_value'));
    const preferences = sqlite.property('preferences') as CodecColumn;
    assert.equal(preferences.codec.queryable, 'none');
    assert.equal(
      encodeColumn(preferences, { theme: 'light', size: 3 }),
      '{"theme":"light","size":3}',
    );
    assert.deepEqual(
      sqlite.columns.map((entry) => entry.property),
      sqlite.spec.columns.map((entry) => entry.property),
    );
    assert.equal(sqlite.property('nope'), undefined);
  });

  it('handles NULL once, before any layer', () => {
    const codecs = modelCodecs(Post, 'sqlite');
    const author = codecs.property('authorId') as CodecColumn;
    const title = codecs.property('title') as CodecColumn;
    assert.equal(encodeColumn(author, null), null);
    assert.equal(decodeColumn(author, null), null);
    assert.throws(() => encodeColumn(title, null), valueError('invalid_value', 'title'));
    assert.throws(() => encodeColumn(title, undefined), valueError('invalid_value'));
    assert.throws(() => decodeColumn(title, null), valueError('invalid_stored_value', 'title'));
    assert.throws(() => decodeColumn(title, undefined), valueError('invalid_stored_value'));
  });

  it('refuses an encrypted column without a seal provider, and seals with one', () => {
    const Secret = defineTable({
      table: 'cc_secrets',
      columns: { token: column.string(64, { encrypted: { mode: 'random' } }) },
    });
    assert.throws(
      () => modelCodecs(Secret, 'sqlite'),
      (error: unknown) => CodecErrors.is(error, 'missing_seal') && error.context.field === 'token',
    );
    const seen: string[] = [];
    const codecs = modelCodecs(Secret, 'mariadb', {
      seal: (target) => {
        seen.push(`${target.table}.${target.column.column}:${target.dialect}`);
        return {
          queryable: 'none',
          encode: (value: SqlValue) => new TextEncoder().encode(`sealed:${String(value)}`),
          decode: (value: Uint8Array) => new TextDecoder().decode(value).slice(7),
        };
      },
    });
    assert.deepEqual(seen, ['cc_secrets.token:mariadb']);
    const token = codecs.property('token') as CodecColumn;
    assert.equal(token.codec.dbType.kind, 'binary');
    assert.equal(token.codec.queryable, 'none');
    const stored = encodeColumn(token, 'abc');
    assert.ok(stored instanceof Uint8Array);
    assert.equal(decodeColumn(token, Buffer.from(stored)), 'abc');
    assert.throws(() => encodeColumn(token, 'x'.repeat(65)), valueError('too_long', 'token'));
  });

  it('refuses a target that is not a model', () => {
    assert.throws(
      () => modelCodecs({}, 'sqlite'),
      (error: unknown) => CodecErrors.is(error, 'not_a_model'),
    );
  });
});

describe('enum and data in the spec validator', () => {
  const rejects = (columns: ModelSpec['columns']) =>
    assert.throws(
      () => defineTable({ table: 'cc_bad', columns }),
      (error: unknown) =>
        error instanceof ModelSpecError &&
        (error.code === 'invalid_spec' || error.code === 'invalid_default'),
    );

  it('accepts an enum on a string column only, with distinct storable members and a member default', () => {
    rejects({ s: column.string(5, { enum: [] }) });
    rejects({ s: column.string(5, { enum: ['a', 'a'] }) });
    rejects({ s: column.string(2, { enum: ['abc'] }) });
    rejects({ s: column.string(5, { enum: ['a\u0000'] }) });
    rejects({ s: column.text({ enum: ['a'] }) });
    rejects({ s: column.string(5, { enum: ['a'], default: 'b' }) });
    const ok = defineTable({
      table: 'cc_ok',
      columns: { s: column.string(5, { enum: ['a', 'b'], default: 'b' }) },
    });
    assert.ok(Object.isFrozen(ok.spec.columns[1]?.enum));
  });

  it('accepts a data contract on a json column only', () => {
    const contract = { name: 'C', schema: { safeParse: () => ({ success: true }) } };
    rejects({ s: column.text({ data: contract }) });
    rejects({ s: column.json({ data: { name: '', schema: contract.schema } }) });
    rejects({ s: column.json({ data: { name: 'C', schema: {} } as never }) });
    defineTable({ table: 'cc_ok2', columns: { s: column.json({ data: contract }) } });
  });
});
