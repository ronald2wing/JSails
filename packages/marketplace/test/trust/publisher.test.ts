import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ceilingCovers, compileCeiling } from '../../src/trust/ceiling.js';
import { compiledPublisher, inNamespace } from '../../src/trust/publisher.js';
import { MarketplaceConfigErrors, publisher, type PublisherInput } from '../../src/trust/index.js';
import { KEYS } from './trust-fixtures.js';

const VALID: PublisherInput = {
  id: 'acme',
  ids: ['acme-*', 'notes'],
  keys: [
    { id: 'root-1', publicKey: KEYS.acmeRoot.publicKey, use: ['root'] },
    { id: 'release-1', publicKey: KEYS.acmeRelease.publicKey, use: ['release', 'catalog'] },
  ],
  ceiling: ['mail.send', 'net.fetch:*', 'data.read:Post'],
};

function invalid(input: unknown, field: string): void {
  assert.throws(
    () => publisher(input as PublisherInput),
    (error: unknown) =>
      MarketplaceConfigErrors.is(error, 'invalid_publisher') && error.context.field === field,
  );
}

describe('publisher()', () => {
  it('returns frozen config data the trust set recognises', () => {
    const declared = publisher(VALID);
    assert.ok(
      Object.isFrozen(declared) &&
        Object.isFrozen(declared.keys) &&
        Object.isFrozen(declared.keys[0]),
    );
    assert.deepEqual(declared.ceiling, VALID.ceiling);
    assert.ok(compiledPublisher(declared) !== undefined);
    assert.equal(compiledPublisher({ ...declared }), undefined, 'a copy was never checked');
  });

  it('matches ids exactly or by a dash-terminated prefix', () => {
    const compiled = compiledPublisher(publisher(VALID))!;
    for (const id of ['acme-notes', 'acme-a.b', 'notes']) assert.ok(inNamespace(compiled, id), id);
    for (const id of ['acme-', 'acme', 'acmecorp-notes', 'notes-extra', 'other']) {
      assert.ok(!inNamespace(compiled, id), id);
    }
  });

  for (const [label, input, field] of [
    ['a non-object', null, 'shape'],
    ['an unknown member', { ...VALID, extra: 1 }, 'shape'],
    ['an uppercase id', { ...VALID, id: 'Acme' }, 'id'],
    ['no ids', { ...VALID, ids: [] }, 'ids'],
    ['a bare wildcard', { ...VALID, ids: ['*'] }, 'ids'],
    ['a wildcard without a dash', { ...VALID, ids: ['acme*'] }, 'ids'],
    ['a wildcard with an empty prefix', { ...VALID, ids: ['-*'] }, 'ids'],
    ['a duplicate id pattern', { ...VALID, ids: ['acme-*', 'acme-*'] }, 'ids'],
    ['an invalid plugin id', { ...VALID, ids: ['Acme'] }, 'ids'],
    ['no keys', { ...VALID, keys: [] }, 'keys'],
    ['a key with an unknown member', { ...VALID, keys: [{ ...VALID.keys[0], x: 1 }] }, 'keys'],
    ['an invalid key id', { ...VALID, keys: [{ ...VALID.keys[0], id: 'Root' }] }, 'key_id'],
    [
      'a duplicate key id',
      { ...VALID, keys: [VALID.keys[0], { ...VALID.keys[1], id: 'root-1' }] },
      'key_id',
    ],
    [
      'a key that is not base64',
      { ...VALID, keys: [{ ...VALID.keys[0], publicKey: 'not a key' }] },
      'public_key',
    ],
    [
      'a key of the wrong length',
      { ...VALID, keys: [{ ...VALID.keys[0], publicKey: 'AAAA' }] },
      'public_key',
    ],
    [
      'a repeated public key',
      { ...VALID, keys: [VALID.keys[0], { ...VALID.keys[0], id: 'root-2' }] },
      'public_key',
    ],
    ['an empty use', { ...VALID, keys: [{ ...VALID.keys[0], use: [] }] }, 'use'],
    ['an unknown use', { ...VALID, keys: [{ ...VALID.keys[0], use: ['sign'] }] }, 'use'],
    ['a repeated use', { ...VALID, keys: [{ ...VALID.keys[0], use: ['root', 'root'] }] }, 'use'],
    ['an unregistered ceiling permission', { ...VALID, ceiling: ['database.read'] }, 'ceiling'],
    ['a missing ceiling', { id: 'acme', ids: VALID.ids, keys: VALID.keys }, 'shape'],
  ] as const) {
    it(`refuses ${label}`, () => {
      invalid(input, field);
    });
  }
});

describe('permission ceilings', () => {
  it('accepts registered permissions and id:* for scoped ones', () => {
    const ceiling = compileCeiling(['mail.send', 'net.fetch:*', 'data.read:Post'])!;
    assert.ok(ceilingCovers(ceiling, 'mail.send'));
    assert.ok(ceilingCovers(ceiling, 'net.fetch:api.example.com'));
    assert.ok(ceilingCovers(ceiling, 'data.read:Post'));
    assert.ok(!ceilingCovers(ceiling, 'data.read:User'));
    assert.ok(!ceilingCovers(ceiling, 'http.routes'));
    assert.ok(!ceilingCovers(ceiling, 'net.fetch'));
  });

  for (const entries of [
    ['mail.send:*'],
    ['unknown.permission'],
    ['net.fetch'],
    ['mail.send', 'mail.send'],
    'mail.send',
    [1],
    Array.from({ length: 201 }, (_, index) => `net.fetch:h${index}.example.com`),
  ]) {
    it(`refuses the ceiling ${JSON.stringify(entries).slice(0, 40)}`, () => {
      assert.equal(compileCeiling(entries), undefined);
    });
  }
});
