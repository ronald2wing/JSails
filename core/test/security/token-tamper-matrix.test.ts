/**
 * Table-driven tamper matrix for the framework's signed-state codecs: signed
 * URLs (`HmacUrlSigner`) and server-component snapshot tokens
 * (`HmacComponentSigner`).
 *
 * Each row derives one hostile input from a genuinely signed value — a
 * duplicated key, a malformed or alternative escape, a moved or re-cased
 * parameter, a swapped MAC, a token under another key or scope — and asserts
 * the codec rejects it: `verify` returns `null` for a signed URL and throws a
 * value-free `SnapshotError` for a snapshot.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { HmacUrlSigner } from '../../src/routing/signed-urls.js';
import {
  DEFAULT_CLOCK_TOLERANCE_MS,
  HmacComponentSigner,
  SnapshotError,
  type SnapshotPayloadWithoutExpiry,
} from '../../src/server-components/snapshot.js';

// ---------------------------------------------------------------------------
// Signed URLs
// ---------------------------------------------------------------------------

const URL_KEY = 'signed-url-tamper-matrix-key-0123456789abcdef';
const NOW = 1_700_000_000_000;

function urlSigner(key = URL_KEY, now = NOW): HmacUrlSigner {
  return new HmacUrlSigner({ key, now: () => now });
}

/** A genuine signed URL every row mutates. */
const SIGNED = urlSigner().sign('/files/report', { user: '42', name: 'a b/c' }, 60_000);

/** Replace the first occurrence of `search` in the signed URL, asserting it was present. */
function replaceOnce(url: string, search: string, replacement: string): string {
  assert.ok(url.includes(search), `fixture must contain ${search}`);
  return url.replace(search, replacement);
}

function signatureOf(url: string): string {
  const match = /[?&]signature=([^&]*)/.exec(url);
  assert.ok(match);
  return match[1]!;
}

interface UrlRow {
  readonly name: string;
  readonly url: () => string;
}

const URL_ROWS: readonly UrlRow[] = [
  { name: 'duplicate caller key, injected first', url: () => replaceOnce(SIGNED, '?', '?user=1&') },
  { name: 'duplicate caller key, appended last', url: () => `${SIGNED}&user=1` },
  { name: 'duplicate signature key', url: () => `${SIGNED}&signature=${signatureOf(SIGNED)}` },
  { name: 'duplicate expires key', url: () => `${SIGNED}&expires=0` },
  { name: 'changed caller value', url: () => replaceOnce(SIGNED, 'user=42', 'user=43') },
  { name: 'added caller key', url: () => `${SIGNED}&admin=1` },
  { name: 'removed caller key', url: () => replaceOnce(SIGNED, 'user=42&', '') },
  { name: 'empty duplicate key', url: () => `${SIGNED}&user=` },
  { name: 'malformed percent escape in a value', url: () => replaceOnce(SIGNED, 'a%20b', 'a%2') },
  { name: 'malformed percent escape in a key', url: () => `${SIGNED}&%zz=1` },
  { name: 'lone surrogate escape', url: () => replaceOnce(SIGNED, 'a%20b', 'a%ED%A0%80b') },
  { name: 'double-encoded value', url: () => replaceOnce(SIGNED, 'a%20b', 'a%2520b') },
  { name: 'escape decoding to a different byte', url: () => replaceOnce(SIGNED, '%2F', '%5C') },
  { name: 'key with different case', url: () => replaceOnce(SIGNED, 'user=', 'USER=') },
  { name: 'changed path', url: () => replaceOnce(SIGNED, '/files/report', '/files/secret') },
  {
    name: 'path with dot segment',
    url: () => replaceOnce(SIGNED, '/files/report', '/files/../report'),
  },
  {
    name: 'path with trailing slash',
    url: () => replaceOnce(SIGNED, '/files/report', '/files/report/'),
  },
  {
    name: 'percent-encoded path',
    url: () => replaceOnce(SIGNED, '/files/report', '/files/%72eport'),
  },
  { name: 'fragment appended', url: () => `${SIGNED}#x` },
  {
    name: 'signature truncated',
    url: () => replaceOnce(SIGNED, signatureOf(SIGNED), signatureOf(SIGNED).slice(0, -1)),
  },
  { name: 'signature emptied', url: () => replaceOnce(SIGNED, signatureOf(SIGNED), '') },
  {
    name: 'signature re-encoded as padded base64',
    url: () =>
      replaceOnce(
        SIGNED,
        signatureOf(SIGNED),
        encodeURIComponent(Buffer.from(signatureOf(SIGNED), 'base64url').toString('base64')),
      ),
  },
  { name: 'signature removed', url: () => SIGNED.replace(/signature=[^&]*&?/, '') },
  { name: 'expires removed', url: () => SIGNED.replace(/&?expires=\d+/, '') },
  {
    name: 'expires extended',
    url: () => SIGNED.replace(/expires=\d+/, `expires=${NOW + 3_600_000}`),
  },
  { name: 'expires set to never', url: () => SIGNED.replace(/expires=\d+/, 'expires=0') },
  { name: 'expires with leading zero', url: () => SIGNED.replace(/expires=(\d+)/, 'expires=0$1') },
  { name: 'expires in exponent form', url: () => SIGNED.replace(/expires=\d+/, 'expires=1.7e12') },
  { name: 'expires negative', url: () => SIGNED.replace(/expires=\d+/, 'expires=-1') },
  { name: 'no query string', url: () => SIGNED.slice(0, SIGNED.indexOf('?')) },
  { name: 'absolute URL prefix', url: () => `https://evil.example${SIGNED}` },
];

describe('tamper matrix: signed URLs', () => {
  it('the untampered fixture verifies', () => {
    assert.deepEqual(urlSigner().verify(SIGNED), {
      path: '/files/report',
      params: { user: '42', name: 'a b/c' },
    });
  });

  for (const row of URL_ROWS) {
    it(`rejects ${row.name}`, () => {
      const tampered = row.url();
      assert.notEqual(tampered, SIGNED);
      assert.equal(urlSigner().verify(tampered), null);
    });
  }

  // The signature covers decoded values, so an alternative spelling of the
  // same value verifies and returns exactly the signed params; it can never
  // smuggle a different value past the MAC.
  for (const [name, search, replacement] of [
    ['a plus for a space', 'a%20b', 'a+b'],
    ['a lower-case escape', '%2F', '%2f'],
  ] as const) {
    it(`accepts ${name} only as the identical signed value`, () => {
      assert.deepEqual(urlSigner().verify(replaceOnce(SIGNED, search, replacement)), {
        path: '/files/report',
        params: { user: '42', name: 'a b/c' },
      });
    });
  }

  it('rejects a URL signed under another key', () => {
    const other = urlSigner('another-signing-key-of-sufficient-length-0123');
    assert.equal(urlSigner().verify(other.sign('/files/report', { user: '42' })), null);
  });

  it('rejects the fixture after it expires', () => {
    assert.equal(urlSigner(URL_KEY, NOW + 60_001).verify(SIGNED), null);
  });

  for (const value of [undefined, null, 42, {}, [], ''] as readonly unknown[]) {
    it(`never throws for the non-URL input ${JSON.stringify(value) ?? 'undefined'}`, () => {
      assert.equal(urlSigner().verify(value as string), null);
    });
  }
});

// ---------------------------------------------------------------------------
// Snapshot tokens
// ---------------------------------------------------------------------------

const SNAPSHOT_KEY = 'snapshot-tamper-matrix-key-0123456789abcdef';

function snapshotSigner(key = SNAPSHOT_KEY, now = NOW): HmacComponentSigner {
  return new HmacComponentSigner({ key, now: () => now, ttlMs: 60_000 });
}

const SUBJECT = snapshotSigner().subjectFor('session-owner');

const PAYLOAD: SnapshotPayloadWithoutExpiry = {
  v: 1,
  component: 'Counter',
  id: 'instance-1',
  state: { count: 1, owner: 'u1' },
  page: { path: '/counter', params: {} },
  origin: 'https://app.example',
  subject: SUBJECT,
};

const TOKEN = snapshotSigner().sign(PAYLOAD);

/** Sign arbitrary JSON with the snapshot key, bypassing the signer's own payload checks. */
function craft(json: string, key = SNAPSHOT_KEY): string {
  const signKey = createHmac('sha256', Buffer.from(key, 'utf8'))
    .update('jsails.snapshot.sign.v1')
    .digest();
  const payload = Buffer.from(json, 'utf8');
  return `${payload.toString('base64url')}.${createHmac('sha256', signKey).update(payload).digest('base64url')}`;
}

function decoded(): Record<string, unknown> {
  return JSON.parse(Buffer.from(TOKEN.split('.')[0]!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function withField(field: string, value: unknown): string {
  return craft(JSON.stringify({ ...decoded(), [field]: value }));
}

interface SnapshotRow {
  readonly name: string;
  readonly token: () => string;
  readonly expect?: {
    readonly component?: string;
    readonly origin?: string;
    readonly subjectId?: string | null;
  };
}

const DEFAULT_EXPECT = {
  component: 'Counter',
  origin: 'https://app.example',
  subjectId: 'session-owner',
};

const SNAPSHOT_ROWS: readonly SnapshotRow[] = [
  {
    name: 'a forged payload under the original MAC',
    token: () => {
      const forged = Buffer.from(
        JSON.stringify({ ...decoded(), state: { count: 999, owner: 'u1' } }),
      );
      return `${forged.toString('base64url')}.${TOKEN.split('.')[1]!}`;
    },
  },
  { name: 'a truncated MAC', token: () => TOKEN.slice(0, -1) },
  { name: 'an extended MAC', token: () => `${TOKEN}A` },
  { name: 'a missing MAC', token: () => TOKEN.split('.')[0]! },
  { name: 'an empty MAC', token: () => `${TOKEN.split('.')[0]!}.` },
  { name: 'an extra segment', token: () => `${TOKEN}.AAAA` },
  { name: 'a padded base64 MAC', token: () => `${TOKEN}=` },
  { name: 'standard base64 alphabet', token: () => TOKEN.replace(/-/g, '+').replace(/_/g, '/') },
  { name: 'whitespace around the token', token: () => ` ${TOKEN} ` },
  {
    name: 'a token signed under another key',
    token: () => snapshotSigner('another-snapshot-key-0123456789abcdef').sign(PAYLOAD),
  },
  {
    name: 'a wrong component scope',
    token: () => TOKEN,
    expect: { ...DEFAULT_EXPECT, component: 'Other' },
  },
  {
    name: 'a wrong origin scope',
    token: () => TOKEN,
    expect: { ...DEFAULT_EXPECT, origin: 'https://evil.example' },
  },
  {
    name: 'another session',
    token: () => TOKEN,
    expect: { ...DEFAULT_EXPECT, subjectId: 'session-other' },
  },
  {
    name: 'an anonymous replay',
    token: () => TOKEN,
    expect: { ...DEFAULT_EXPECT, subjectId: null },
  },
  { name: 'an unsupported version', token: () => withField('v', 2) },
  {
    name: 'a __proto__ key in state',
    token: () =>
      craft(JSON.stringify(decoded()).replace('"count"', '"__proto__":{"admin":true},"count"')),
  },
  {
    name: 'a constructor key in state',
    token: () => withField('state', { constructor: { prototype: {} } }),
  },
  {
    name: 'a traversal page path',
    token: () => withField('page', { path: '/../admin', params: {} }),
  },
  {
    name: 'an expiry extended without re-signing',
    token: () => {
      const redated = Buffer.from(JSON.stringify({ ...decoded(), expiresAt: NOW + 10 ** 9 }));
      return `${redated.toString('base64url')}.${TOKEN.split('.')[1]!}`;
    },
  },
  { name: 'non-JSON payload', token: () => craft('not json') },
  { name: 'a JSON array payload', token: () => craft('[]') },
  {
    name: 'deeply nested state',
    token: () => withField('state', JSON.parse(`${'{"a":'.repeat(200)}1${'}'.repeat(200)}`)),
  },
  { name: 'an empty token', token: () => '' },
];

describe('tamper matrix: snapshot tokens', () => {
  it('the untampered fixture verifies under its scope', () => {
    const verified = snapshotSigner().verify(TOKEN, DEFAULT_EXPECT);
    assert.deepEqual(verified.state, PAYLOAD.state);
  });

  // The post-MAC rows only test their check while craft() matches the signer's key derivation.
  it('craft() produces a token the signer accepts', () => {
    const verified = snapshotSigner().verify(craft(JSON.stringify(decoded())), DEFAULT_EXPECT);
    assert.deepEqual(verified.state, PAYLOAD.state);
  });

  for (const row of SNAPSHOT_ROWS) {
    it(`rejects ${row.name} with a value-free SnapshotError`, () => {
      const token = row.token();
      assert.throws(
        () => snapshotSigner().verify(token, row.expect ?? DEFAULT_EXPECT),
        (error: unknown) => {
          assert.ok(error instanceof SnapshotError, String(error));
          assert.ok(!error.message.includes(SNAPSHOT_KEY));
          assert.ok(token.length < 8 || !error.message.includes(token));
          assert.ok(!error.message.includes('session-owner'));
          return true;
        },
      );
      assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'admin'), false);
    });
  }

  it('rejects the fixture after its sliding lifetime and the clock tolerance', () => {
    assert.ok(
      snapshotSigner(SNAPSHOT_KEY, NOW + 60_000 + DEFAULT_CLOCK_TOLERANCE_MS - 1).verify(
        TOKEN,
        DEFAULT_EXPECT,
      ),
    );
    assert.throws(
      () =>
        snapshotSigner(SNAPSHOT_KEY, NOW + 60_000 + DEFAULT_CLOCK_TOLERANCE_MS).verify(
          TOKEN,
          DEFAULT_EXPECT,
        ),
      SnapshotError,
    );
  });

  for (const value of [undefined, null, 42, {}, []] as readonly unknown[]) {
    it(`throws SnapshotError, not TypeError, for the non-string token ${JSON.stringify(value) ?? 'undefined'}`, () => {
      assert.throws(() => snapshotSigner().verify(value as string), SnapshotError);
    });
  }
});
