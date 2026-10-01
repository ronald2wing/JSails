/**
 * Tests for the pure signature half: the header parser, the signed payload
 * format, and the HMAC check against a fixed vector.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkSignature,
  computeSignature,
  parseSignatureHeader,
  signedPayload,
} from '../src/signature.js';

describe('signedPayload', () => {
  it('joins the id, timestamp, and body with dots', () => {
    assert.equal(signedPayload('stripe', 1700000000, '{"a":1}'), 'stripe.1700000000.{"a":1}');
  });
});

describe('computeSignature', () => {
  it('matches a known HMAC-SHA256 vector', () => {
    // Independently computed: HMAC-SHA256(key="secret", msg="stripe.1700000000.{}")
    assert.equal(
      computeSignature('stripe', 1700000000, '{}', 'secret'),
      'bfd9e626e5871f3f2b1a0113b846b483f753df0ffda3d01efe628c424545b834',
    );
  });

  it('is deterministic and lowercase hex', () => {
    const first = computeSignature('a', 1, 'body', 'k');
    assert.equal(first, computeSignature('a', 1, 'body', 'k'));
    assert.match(first, /^[0-9a-f]{64}$/);
  });

  it('changes when the id, timestamp, body, or secret changes', () => {
    const base = computeSignature('a', 1, 'body', 'k');
    assert.notEqual(computeSignature('b', 1, 'body', 'k'), base);
    assert.notEqual(computeSignature('a', 2, 'body', 'k'), base);
    assert.notEqual(computeSignature('a', 1, 'other', 'k'), base);
    assert.notEqual(computeSignature('a', 1, 'body', 'other'), base);
  });
});

describe('parseSignatureHeader', () => {
  it('parses t and v1', () => {
    const parsed = parseSignatureHeader(`t=1700000000,v1=${'a'.repeat(64)}`);
    assert.deepEqual(parsed, { timestamp: 1700000000, signature: 'a'.repeat(64) });
  });

  it('lowercases the signature', () => {
    assert.equal(parseSignatureHeader(`t=1,v1=${'A'.repeat(64)}`)?.signature, 'a'.repeat(64));
  });

  it('accepts the parts in either order', () => {
    assert.deepEqual(parseSignatureHeader(`v1=${'b'.repeat(64)},t=5`), {
      timestamp: 5,
      signature: 'b'.repeat(64),
    });
  });

  it('rejects a missing, empty, or malformed header', () => {
    assert.equal(parseSignatureHeader(null), null);
    assert.equal(parseSignatureHeader(undefined), null);
    assert.equal(parseSignatureHeader(''), null);
    assert.equal(parseSignatureHeader('garbage'), null);
    assert.equal(parseSignatureHeader(`t=1`), null);
    assert.equal(parseSignatureHeader(`v1=${'a'.repeat(64)}`), null);
    assert.equal(parseSignatureHeader(`t=abc,v1=${'a'.repeat(64)}`), null);
    assert.equal(parseSignatureHeader('t=1,v1=nothex'), null);
    assert.equal(parseSignatureHeader('t=1,v1=abc'), null);
  });
});

describe('checkSignature', () => {
  const secret = 'shhh';
  const id = 'stripe';
  const body = '{"event":"paid"}';
  const timestamp = 1_700_000_000;
  const signature = computeSignature(id, timestamp, body, secret);

  it('accepts a correct signature inside the tolerance', () => {
    assert.equal(
      checkSignature({ timestamp, signature }, id, body, secret, timestamp + 10, 300),
      null,
    );
  });

  it('accepts exactly at the tolerance boundary', () => {
    assert.equal(
      checkSignature({ timestamp, signature }, id, body, secret, timestamp + 300, 300),
      null,
    );
  });

  it('rejects one second past the tolerance', () => {
    assert.equal(
      checkSignature({ timestamp, signature }, id, body, secret, timestamp + 301, 300),
      'timestamp_out_of_tolerance',
    );
  });

  it('rejects a timestamp in the future beyond the tolerance', () => {
    assert.equal(
      checkSignature({ timestamp, signature }, id, body, secret, timestamp - 301, 300),
      'timestamp_out_of_tolerance',
    );
  });

  it('rejects a wrong signature', () => {
    assert.equal(
      checkSignature({ timestamp, signature: 'f'.repeat(64) }, id, body, secret, timestamp, 300),
      'invalid_signature',
    );
  });

  it('rejects a signature computed for a different id', () => {
    const other = computeSignature('github', timestamp, body, secret);
    assert.equal(
      checkSignature({ timestamp, signature: other }, id, body, secret, timestamp, 300),
      'invalid_signature',
    );
  });

  it('rejects a signature computed over a different body', () => {
    const other = computeSignature(id, timestamp, '{"event":"refunded"}', secret);
    assert.equal(
      checkSignature({ timestamp, signature: other }, id, body, secret, timestamp, 300),
      'invalid_signature',
    );
  });

  it('checks the timestamp before the HMAC', () => {
    // A stale request with a garbage signature reports the timestamp failure.
    assert.equal(
      checkSignature(
        { timestamp, signature: 'f'.repeat(64) },
        id,
        body,
        secret,
        timestamp + 999,
        300,
      ),
      'timestamp_out_of_tolerance',
    );
  });
});
