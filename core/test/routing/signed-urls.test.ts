/**
 * Tests for `HmacUrlSigner`: round trips, tamper detection, expiry, key
 * isolation, and the injectable clock.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HmacUrlSigner, SignedUrlError } from '../../src/routing/signed-urls.js';

// A 64-byte key for signing (well above the 32-byte minimum).
const KEY = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('HmacUrlSigner', () => {
  it('returns an object with sign and verify methods', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    assert.equal(typeof signer.sign, 'function');
    assert.equal(typeof signer.verify, 'function');
  });

  it('throws SignedUrlError for a key shorter than 32 bytes', () => {
    assert.throws(
      () => new HmacUrlSigner({ key: 'short' }),
      (err: unknown) => {
        assert.ok(err instanceof SignedUrlError);
        assert.ok(err.message.includes('32'));
        return true;
      },
    );
  });

  it('throws SignedUrlError for an empty key', () => {
    assert.throws(() => new HmacUrlSigner({ key: '' }), SignedUrlError);
  });

  it('error message never echoes the key', () => {
    try {
      new HmacUrlSigner({ key: 'short' });
    } catch (err) {
      assert.ok(err instanceof SignedUrlError);
      assert.ok(!err.message.includes('short'), 'error message must not echo the key');
    }
  });
});

// ---------------------------------------------------------------------------
// sign → verify round-trip
// ---------------------------------------------------------------------------

describe('signed URLs round-trip', () => {
  it('signs a path and verifies it back (no params)', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/api/users/1');
    assert.ok(url.startsWith('/api/users/1?signature='));
    assert.ok(url.includes('expires='));

    const result = signer.verify(url);
    assert.equal(result?.path, '/api/users/1');
  });

  it('signs a path with params and verifies it back', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/reset', { token: 'abc', id: '42' });
    assert.ok(url.startsWith('/reset?'));
    assert.ok(url.includes('token=abc'));
    assert.ok(url.includes('id=42'));

    const result = signer.verify(url);
    assert.equal(result?.path, '/reset');
  });

  it('signs a path with numeric and boolean params', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/a', { n: 42, b: true });
    assert.ok(url.includes('n=42'));
    assert.ok(url.includes('b=true'));

    const result = signer.verify(url);
    assert.equal(result?.path, '/a');
  });

  it('verifies the path is returned without the signature query', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/long/path/to/resource', { x: '1' });
    const result = signer.verify(url);
    assert.equal(result?.path, '/long/path/to/resource');
    assert.deepEqual(result?.params, { x: '1' });
  });
});

// ---------------------------------------------------------------------------
// Tampered signatures
// ---------------------------------------------------------------------------

describe('signed URLs tamper detection', () => {
  it('returns null when the signature is tampered', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/api/data');
    // Flip one character in the signature.
    const tampered = url.replace(/signature=[^&]+/, (m) => m + 'x');

    const result = signer.verify(tampered);
    assert.equal(result, null);
  });

  it('returns null when the path is modified', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/api/data');
    const tampered = url.replace('/api/data', '/api/evil');

    const result = signer.verify(tampered);
    assert.equal(result, null);
  });

  it('returns null when a param value is modified', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/a', { id: '1' });
    const tampered = url.replace('id=1', 'id=2');

    const result = signer.verify(tampered);
    assert.equal(result, null);
  });

  it('returns null when the signature query parameter is missing', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/a');
    const noSig = url.replace(/&?signature=[^&]*/, '');
    // Still has expires but no signature.
    const result = signer.verify(noSig);
    assert.equal(result, null);
  });

  it('returns null for an empty string', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    assert.equal(signer.verify(''), null);
  });

  it('returns null for a URL with no query string', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    assert.equal(signer.verify('/foo'), null);
  });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

describe('signed URLs expiry', () => {
  it('returns the path when the signature has not expired', () => {
    let now = 1_000_000_000_000;
    const signer = new HmacUrlSigner({ key: KEY, now: () => now });
    const url = signer.sign('/api/data', undefined, 60_000); // 60s lifetime

    // Advance 30 seconds — still valid.
    now += 30_000;
    const result = signer.verify(url);
    assert.equal(result?.path, '/api/data');
  });

  it('returns null when the signature has expired', () => {
    let now = 1_000_000_000_000;
    const signer = new HmacUrlSigner({ key: KEY, now: () => now });
    const url = signer.sign('/api/data', undefined, 60_000);

    // Advance past expiry.
    now += 90_000;
    const result = signer.verify(url);
    assert.equal(result, null);
  });

  it('returns null immediately at the expiry boundary', () => {
    let now = 1_000_000_000_000;
    const signer = new HmacUrlSigner({ key: KEY, now: () => now });
    const url = signer.sign('/api/data', undefined, 60_000);

    // Exactly at expiry — `clock() > expiresMs` → false, so we need to be
    // just past it.
    now += 60_001;
    const result = signer.verify(url);
    assert.equal(result, null);
  });

  it('verifies even at the last valid millisecond', () => {
    let now = 1_000_000_000_000;
    const signer = new HmacUrlSigner({ key: KEY, now: () => now });
    const url = signer.sign('/api/data', undefined, 60_000);

    // At the exact expiry timestamp (inclusive — clock() must be > expiry).
    now += 60_000;
    const result = signer.verify(url);
    assert.equal(result?.path, '/api/data');
  });

  it('never-expiring signature (expiresInMs = 0) is always valid', () => {
    let now = 1_000_000_000_000;
    const signer = new HmacUrlSigner({ key: KEY, now: () => now });
    const url = signer.sign('/perm', undefined, 0);

    // Advance far into the future.
    now += 1_000_000_000_000_000;
    const result = signer.verify(url);
    assert.equal(result?.path, '/perm');
  });

  it('returns null for a non-integer expires parameter', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/a');
    const tampered = url.replace(/expires=\d+/, 'expires=abc');

    const result = signer.verify(tampered);
    assert.equal(result, null);
  });

  it('returns null for a negative expires parameter', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/a');
    const tampered = url.replace(/expires=\d+/, 'expires=-1');

    const result = signer.verify(tampered);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Key isolation
// ---------------------------------------------------------------------------

describe('signed URLs key isolation', () => {
  it('returns null when verified with a different key', () => {
    const s1 = new HmacUrlSigner({ key: KEY });
    const s2 = new HmacUrlSigner({ key: 'b'.repeat(64) });

    const url = s1.sign('/data');
    const result = s2.verify(url);
    assert.equal(result, null);
  });

  it('same path signed by different signers yields different signatures', () => {
    const s1 = new HmacUrlSigner({ key: KEY });
    const s2 = new HmacUrlSigner({ key: 'c'.repeat(64) });

    const url1 = s1.sign('/data');
    const url2 = s2.sign('/data');

    const sig1 = url1.match(/signature=([^&]+)/)?.[1];
    const sig2 = url2.match(/signature=([^&]+)/)?.[1];
    assert.ok(sig1);
    assert.ok(sig2);
    assert.notEqual(sig1, sig2);
  });
});

// ---------------------------------------------------------------------------
// Injectible clock
// ---------------------------------------------------------------------------

describe('signed URLs injectible clock', () => {
  it('uses the injected now() for expiry computation', () => {
    const fixedNow = () => 500_000;
    const signer = new HmacUrlSigner({ key: KEY, now: fixedNow });
    const url = signer.sign('/a', undefined, 100_000);

    // Verify against the same fixed clock (still valid).
    const signer2 = new HmacUrlSigner({ key: KEY, now: fixedNow });
    const result = signer2.verify(url);
    assert.equal(result?.path, '/a');
  });
});

// ---------------------------------------------------------------------------
// Verified payload and malformed input
// ---------------------------------------------------------------------------

describe('signed URLs verified payload', () => {
  it('returns the verified params alongside the path', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/reset', { token: 'a b+c', id: 42 });
    const result = signer.verify(url);
    assert.deepEqual(result, { path: '/reset', params: { id: '42', token: 'a b+c' } });
    assert.ok(Object.isFrozen(result?.params));
  });

  it('rejects a URL that repeats a signed param in front of the signed value', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/download', { file: 'a' });
    const smuggled = url.replace('/download?', '/download?file=secret&');
    assert.equal(signer.verify(smuggled), null);
  });

  it('rejects a URL that repeats signature or expires', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const url = signer.sign('/a');
    assert.equal(signer.verify(`${url}&signature=x`), null);
    assert.equal(signer.verify(`${url}&expires=0`), null);
  });

  it('returns null instead of throwing for a malformed escape', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    assert.equal(signer.verify('/a?signature=%E0%A4%A&expires=0'), null);
    assert.equal(signer.verify('/a?%E0%A4%A=1&signature=x&expires=0'), null);
  });

  it('returns null for a non-string input', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    assert.equal(signer.verify(undefined as unknown as string), null);
  });

  it('rejects reserved param names at sign time', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    assert.throws(
      () => signer.sign('/a', { signature: 'x' }),
      (err: unknown) => err instanceof SignedUrlError && err.code === 'invalid_param',
    );
    assert.throws(
      () => signer.sign('/a', { expires: 1 }),
      (err: unknown) => err instanceof SignedUrlError && err.code === 'invalid_param',
    );
  });

  it('rejects a path containing a query or fragment at sign time', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    for (const path of ['/a?b=1', '/a#top', '']) {
      assert.throws(
        () => signer.sign(path),
        (err: unknown) => err instanceof SignedUrlError && err.code === 'invalid_path',
      );
    }
  });

  it('rejects a negative or non-integer lifetime at sign time', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    for (const lifetime of [-1, 1.5, Number.NaN]) {
      assert.throws(
        () => signer.sign('/a', undefined, lifetime),
        (err: unknown) => err instanceof SignedUrlError && err.code === 'invalid_expiry',
      );
    }
  });

  it('keeps a param named __proto__ as an ordinary signed value', () => {
    const signer = new HmacUrlSigner({ key: KEY });
    const params = JSON.parse('{"__proto__":"x"}') as Record<string, string>;
    const result = signer.verify(signer.sign('/a', params));
    assert.ok(result);
    assert.equal(Object.getOwnPropertyDescriptor(result.params, '__proto__')?.value, 'x');
  });
});
