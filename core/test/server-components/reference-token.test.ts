/**
 * Tests for the shared signed-token encoding in
 * `src/server-components/reference-token.ts`: a token verifies only in the
 * exact spelling `signJson` produced, so a re-spelled base64url segment that
 * decodes to the same bytes is rejected for every surface built on it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { signJson, verifyAndDecode } from '../../src/server-components/reference-token.js';

const KEY = Buffer.alloc(32, 7);
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

class Rejected extends Error {}

function fail(): never {
  throw new Rejected();
}

/** Flip the lowest bit of a segment's final character (an unused padding bit). */
function respell(segment: string): string {
  const index = BASE64URL.indexOf(segment.at(-1)!);
  return segment.slice(0, -1) + BASE64URL[index ^ 1]!;
}

describe('verifyAndDecode canonical spelling', () => {
  // 4 payload bytes leave unused low bits in the final payload character.
  const payload = Buffer.from('{"a"', 'utf8');
  const token = signJson(KEY, payload);
  const [payloadPart, signaturePart] = token.split('.') as [string, string];

  it('accepts the spelling signJson produced', () => {
    assert.deepEqual(verifyAndDecode(token, KEY, 1024, fail), payload);
  });

  it('rejects a re-spelled signature that decodes to the same MAC', () => {
    const respelled = `${payloadPart}.${respell(signaturePart)}`;
    assert.deepEqual(
      Buffer.from(respell(signaturePart), 'base64url'),
      Buffer.from(signaturePart, 'base64url'),
    );
    assert.throws(() => verifyAndDecode(respelled, KEY, 1024, fail), Rejected);
  });

  it('rejects a re-spelled payload that decodes to the same bytes', () => {
    const respelled = `${respell(payloadPart)}.${signaturePart}`;
    assert.deepEqual(Buffer.from(respell(payloadPart), 'base64url'), payload);
    assert.throws(() => verifyAndDecode(respelled, KEY, 1024, fail), Rejected);
  });
});
