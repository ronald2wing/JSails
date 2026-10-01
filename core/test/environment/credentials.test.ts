/**
 * Tests for sealed credentials format v2: the header, AES-256-GCM with the
 * header as authenticated data, key selection by key id in either ring
 * order, and value-free failures. The last case is the structural gate that
 * nothing seals the process environment.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  credentialsPaths,
  documentDigest,
  openCredentials,
  parseCredentials,
  sealCredentials,
  sealedKeyId,
} from '../../src/environment/credentials.js';
import { CredentialsErrors } from '../../src/environment/errors.js';
import { KeyRing } from '../../src/environment/key-ring.js';

const PLAINTEXT = 'API_TOKEN=hunter2-secret\nDATABASE_PASSWORD="p w"\n';

function failsWith(code: string, ...secrets: string[]) {
  return (error: unknown): boolean =>
    CredentialsErrors.is(error) &&
    error.code === `credentials.${code}` &&
    secrets.every((secret) => !error.message.includes(secret));
}

describe('sealed credentials v2', () => {
  it('writes a header naming the format, the environment and the sealing key', () => {
    const ring = KeyRing.generate();
    const sealed = sealCredentials(PLAINTEXT, ring, 'production');
    const [header, body, end] = sealed.split('\n');
    assert.equal(header, `jsails-credentials v2 production ${ring.currentId}`);
    assert.match(body ?? '', /^[A-Za-z0-9_-]+$/);
    assert.equal(end, '');
    assert.ok(!sealed.includes('hunter2'));
    assert.equal(sealedKeyId(Buffer.from(sealed), 'production'), ring.currentId);
  });

  it('opens with whichever ring key the document names, in either ring order', () => {
    const old = KeyRing.generate();
    const rotated = old.withNewKey();
    const reversed = KeyRing.parse(rotated.toVariable().split(',').reverse().join(','));
    const underOld = Buffer.from(sealCredentials(PLAINTEXT, old, 'production'));
    const underNew = Buffer.from(sealCredentials(PLAINTEXT, rotated, 'production'));
    for (const ring of [rotated, reversed]) {
      assert.deepEqual(openCredentials(underOld, ring, 'production'), {
        plaintext: PLAINTEXT,
        keyId: old.currentId,
      });
      assert.deepEqual(openCredentials(underNew, ring, 'production'), {
        plaintext: PLAINTEXT,
        keyId: rotated.currentId,
      });
    }
    assert.throws(() => openCredentials(underNew, old, 'production'), failsWith('unknown_key'));
  });

  it('binds the header: another environment, an edited key id, or a tampered body fail', () => {
    const ring = KeyRing.generate();
    const other = KeyRing.generate();
    const both = KeyRing.parse(`${ring.toVariable()},${other.toVariable()}`);
    const sealed = sealCredentials(PLAINTEXT, both, 'production');
    assert.throws(
      () => openCredentials(Buffer.from(sealed), both, 'staging'),
      failsWith('environment_mismatch'),
    );
    const swapped = sealed.replace(ring.currentId, other.currentId);
    assert.throws(
      () => openCredentials(Buffer.from(swapped), both, 'production'),
      failsWith('decryption_failed', 'hunter2'),
    );
    const [header, body] = sealed.split('\n') as [string, string];
    const flipped = `${header}\n${body.slice(0, 10)}${body[10] === 'A' ? 'B' : 'A'}${body.slice(11)}\n`;
    assert.throws(
      () => openCredentials(Buffer.from(flipped), both, 'production'),
      failsWith('decryption_failed'),
    );
    assert.throws(
      () => openCredentials(Buffer.from(`${header}\nAAAA\n`), both, 'production'),
      failsWith('decryption_failed'),
    );
  });

  it('rejects a document without a v2 header, value-free', () => {
    const ring = KeyRing.generate();
    for (const text of ['eyJpdiI6ImFhYSJ9\n', '', 'jsails-credentials v2 production\nabc\n']) {
      assert.throws(
        () => openCredentials(Buffer.from(text), ring, 'production'),
        failsWith('invalid_document'),
      );
    }
    assert.throws(
      () =>
        openCredentials(
          Buffer.from(`jsails-credentials v3 production ${ring.currentId}\nabc\n`),
          ring,
          'production',
        ),
      failsWith('unsupported_version'),
    );
  });

  it('refuses to seal or open a document that defines a reserved key', () => {
    const ring = KeyRing.generate();
    for (const reserved of [
      'NODE_ENV',
      'JSAILS_ENV',
      'JSAILS_CREDENTIALS_KEY',
      'JSAILS_SECRETS_FILE',
      'JSAILS_ENV_RESOLVED',
    ]) {
      assert.throws(
        () => sealCredentials(`${reserved}=x-secret\n`, ring, 'production'),
        failsWith('reserved_key', 'x-secret'),
      );
      assert.throws(
        () => parseCredentials(`${reserved}=x\n`, 'production'),
        failsWith('reserved_key'),
      );
    }
  });

  it('refuses to seal or open a name that is not a plain variable name, value-free', () => {
    const ring = KeyRing.generate();
    for (const name of ['A.B', '__proto__', 'constructor']) {
      assert.throws(
        () => sealCredentials(`${name}=x-secret\n`, ring, 'production'),
        failsWith('invalid_name', 'x-secret', name),
      );
    }
    assert.deepEqual({ ...parseCredentials('A_B=1\n', 'production') }, { A_B: '1' });
  });

  it('names the files of an environment and rejects a name that is not a file name', () => {
    assert.deepEqual(credentialsPaths('staging'), {
      file: 'config/credentials/staging.enc',
      keyFile: 'config/credentials/staging.key',
    });
    for (const name of ['../x', 'a/b', '', '.hidden']) {
      assert.throws(() => credentialsPaths(name), failsWith('invalid_environment'));
    }
  });

  it('digests the document bytes as hex SHA-256', () => {
    assert.equal(
      documentDigest(Buffer.from('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('gate: no credentials module reads or spreads process.env into what it seals', () => {
    for (const relative of [
      '../../../src/environment/credentials.ts',
      '../../../src/cli/commands/credentials.ts',
    ]) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      assert.doesNotMatch(source, /\.\.\.\s*(process\.env|deps\.env|env)\b/, relative);
    }
  });
});
