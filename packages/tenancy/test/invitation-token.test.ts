/**
 * Tests for invitation tokens: format and entropy, SHA-256 known-answer
 * vectors, strict parsing (malformed tokens yield null without throwing),
 * canonical encoding, constant-time digest comparison, and a uniqueness smoke
 * test.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hashInvitationToken,
  issueInvitationToken,
  sameInvitationTokenHash,
} from '../src/invitation-token.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const ZERO_TOKEN = `jsinv_${'A'.repeat(43)}`;
const ONES_TOKEN = `jsinv_${'_'.repeat(42)}8`;

describe('issueInvitationToken', () => {
  it('issues jsinv_ plus base64url of 32 bytes, with its digest', () => {
    const issued = issueInvitationToken();
    assert.match(issued.token, /^jsinv_[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(issued.token.slice(6), 'base64url').byteLength, 32);
    assert.ok(issued.hash instanceof Uint8Array);
    assert.equal(issued.hash.byteLength, 32);
    assert.deepEqual(hashInvitationToken(issued.token), issued.hash);
    assert.ok(Object.isFrozen(issued));
  });

  it('never repeats over 10k tokens and spreads its bits', () => {
    const tokens = new Set<string>();
    let ones = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const { token } = issueInvitationToken();
      tokens.add(token);
      for (const byte of Buffer.from(token.slice(6), 'base64url')) {
        ones += byte.toString(2).replace(/0/g, '').length;
      }
    }
    assert.equal(tokens.size, 10_000);
    const ratio = ones / (10_000 * 256);
    assert.ok(ratio > 0.49 && ratio < 0.51, `bit ratio ${ratio}`);
  });
});

describe('hashInvitationToken', () => {
  it('matches SHA-256 known answers over the token text', () => {
    assert.equal(
      hex(hashInvitationToken(ZERO_TOKEN) ?? new Uint8Array()),
      'd1794e7c01f89a483ebb42d4230f8296ac6d813ad7fd73800cf45caff21233e3',
    );
    assert.equal(
      hex(hashInvitationToken(ONES_TOKEN) ?? new Uint8Array()),
      'a7c80622e45650bf0bca48f8d9eee9ec94da7265fe20a3b14e041b32e4a65988',
    );
  });

  const malformed: readonly (readonly [string, unknown])[] = [
    ['empty', ''],
    ['no prefix', 'A'.repeat(43)],
    ['wrong prefix', `jsinx_${'A'.repeat(43)}`],
    ['upper-case prefix', `JSINV_${'A'.repeat(43)}`],
    ['too short', `jsinv_${'A'.repeat(42)}`],
    ['too long', `jsinv_${'A'.repeat(44)}`],
    ['padding', `jsinv_${'A'.repeat(42)}=`],
    ['standard base64 alphabet', `jsinv_${'+'.repeat(42)}A`],
    ['non-canonical last character', `jsinv_${'A'.repeat(42)}B`],
    ['surrounding whitespace', ` ${ZERO_TOKEN}`],
    ['trailing newline', `${ZERO_TOKEN}\n`],
    ['not a string', 42],
    ['null', null],
  ];
  for (const [why, value] of malformed) {
    it(`returns null for ${why}`, () => {
      assert.equal(hashInvitationToken(value as string), null);
    });
  }
});

describe('sameInvitationTokenHash', () => {
  it('compares digests by value and refuses differing lengths', () => {
    const a = hashInvitationToken(ZERO_TOKEN) ?? new Uint8Array();
    const b = hashInvitationToken(ONES_TOKEN) ?? new Uint8Array();
    assert.equal(sameInvitationTokenHash(a, new Uint8Array(a)), true);
    assert.equal(sameInvitationTokenHash(a, b), false);
    assert.equal(sameInvitationTokenHash(a, a.subarray(0, 31)), false);
  });
});
