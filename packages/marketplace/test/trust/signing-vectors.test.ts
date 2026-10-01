/**
 * The checked-in signing vectors (`signing-vectors.json`): the canonical text,
 * the signed message and the Ed25519 signature of one record of each kind, so
 * a publisher's tooling in any language can check its output against them and
 * a change to the canonical form or the message framing fails here first.
 */

import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { canonicalJson, signingMessage, type SignedRecordKind } from '../../src/trust/index.js';
import { fixtureKey, signature } from './trust-fixtures.js';

interface Vector {
  readonly name: string;
  readonly kind: SignedRecordKind;
  readonly key: { readonly id: string; readonly seedByte: number; readonly publicKey: string };
  readonly record: unknown;
  readonly canonical: string;
  readonly messageSha256: string;
  readonly signature: string;
}

const FILE = new URL('../../../test/trust/signing-vectors.json', import.meta.url);
const { vectors } = JSON.parse(readFileSync(FILE, 'utf8')) as { vectors: readonly Vector[] };

describe('signing vectors', () => {
  it('cover every signed record kind', () => {
    assert.deepEqual(vectors.map((vector) => vector.kind).sort(), [
      'catalog',
      'delegation',
      'release',
    ]);
  });

  for (const vector of vectors) {
    describe(vector.name, () => {
      it('serialises to the recorded canonical text', () => {
        assert.equal(canonicalJson(vector.record), vector.canonical);
        assert.deepEqual(JSON.parse(vector.canonical), vector.record);
      });

      it('frames the message as the domain tag, a newline and the canonical text', () => {
        const message = signingMessage(vector.kind, vector.record);
        const expected = `jsails.marketplace.${vector.kind}.v1\n${vector.canonical}`;
        assert.equal(Buffer.from(message).toString('utf8'), expected);
        assert.equal(createHash('sha256').update(message).digest('hex'), vector.messageSha256);
      });

      it('carries a signature that verifies under the recorded public key', () => {
        const key = createPublicKey({
          key: {
            kty: 'OKP',
            crv: 'Ed25519',
            x: Buffer.from(vector.key.publicKey, 'base64').toString('base64url'),
          },
          format: 'jwk',
        });
        const message = Buffer.from(
          `jsails.marketplace.${vector.kind}.v1\n${vector.canonical}`,
          'utf8',
        );
        assert.ok(verify(null, message, key, Buffer.from(vector.signature, 'base64')));
      });

      it('is reproduced exactly from its seed', () => {
        const key = fixtureKey(vector.key.id, vector.key.seedByte);
        assert.equal(key.publicKey, vector.key.publicKey);
        assert.equal(signature(vector.kind, vector.record, key).sig, vector.signature);
      });
    });
  }
});
