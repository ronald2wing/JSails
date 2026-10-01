/**
 * Tests for credentials key rings: parsing from a key file or the variable,
 * key ids derived with HKDF, rotation steps, and that the key material never
 * shows in a serialization.
 */

import assert from 'node:assert/strict';
import { hkdfSync, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';

import { CredentialsErrors } from '../../src/environment/errors.js';
import { KeyRing } from '../../src/environment/key-ring.js';

function key(): string {
  return randomBytes(32).toString('base64url');
}

function expectedId(text: string): string {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(text, 'base64url'),
      Buffer.alloc(0),
      'jsails-credentials-keyid',
      8,
    ),
  ).toString('hex');
}

describe('KeyRing', () => {
  it('derives each key id as the first 8 bytes of HKDF(key, "jsails-credentials-keyid")', () => {
    const [a, b] = [key(), key()];
    const ring = KeyRing.parse(`${a}\n${b}\n`);
    assert.deepEqual(ring.ids, [expectedId(a), expectedId(b)]);
    assert.equal(ring.currentId, expectedId(a));
    assert.equal(ring.size, 2);
    assert.match(ring.currentId, /^[0-9a-f]{16}$/);
  });

  it('reads the variable form, comma- or space-separated, as the key file form', () => {
    const [a, b] = [key(), key()];
    for (const text of [`${a},${b}`, `${a} ${b}`, ` ${a}\r\n${b}\n`]) {
      assert.deepEqual(KeyRing.parse(text).ids, [expectedId(a), expectedId(b)]);
    }
    const ring = KeyRing.parse(`${a},${b}`);
    assert.deepEqual(KeyRing.parse(ring.toKeyFile()).ids, ring.ids);
    assert.deepEqual(KeyRing.parse(ring.toVariable()).ids, ring.ids);
  });

  it('rejects an empty ring, more than two keys, a repeated key, and a malformed key', () => {
    const a = key();
    for (const text of ['', ' \n', `${a},${key()},${key()}`, `${a},${a}`]) {
      assert.throws(
        () => KeyRing.parse(text),
        (error: unknown) =>
          CredentialsErrors.is(error) && error.code === 'credentials.invalid_key_ring',
      );
    }
    for (const text of [
      'short',
      `${a}x`,
      randomBytes(31).toString('base64url'),
      `${a.slice(0, 42)}=`,
    ]) {
      assert.throws(
        () => KeyRing.parse(text),
        (error: unknown) =>
          CredentialsErrors.is(error) &&
          error.code === 'credentials.invalid_key' &&
          !error.message.includes(text),
      );
    }
  });

  it('adds a fresh current key for a rotation and reduces to one key to finish it', () => {
    const ring = KeyRing.generate();
    const rotated = ring.withNewKey();
    assert.equal(rotated.size, 2);
    assert.equal(rotated.ids[1], ring.currentId);
    assert.notEqual(rotated.currentId, ring.currentId);
    assert.deepEqual(rotated.only(ring.currentId).ids, [ring.currentId]);
    assert.throws(() => rotated.withNewKey(), /one or two distinct keys/);
    assert.throws(() => ring.only('0000000000000000'), /one or two distinct keys/);
  });

  it('never shows key material when logged or serialized', () => {
    const a = key();
    const ring = KeyRing.parse(a);
    assert.ok(!JSON.stringify(ring).includes(a));
    assert.ok(!inspect(ring, { showHidden: true, depth: 5 }).includes(a));
    assert.ok(!String(ring).includes(a));
  });
});
