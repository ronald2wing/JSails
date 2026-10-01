/**
 * Post-login redirect tests for the first-party `auth` plugin.
 *
 * `safeNextPath` is the only gate between a hostile `next` form field and the
 * `Location` header, so these cases pin every off-origin shape a browser would
 * normalize (backslashes, protocol-relative, absolute) to the `/dashboard`
 * fallback, and prove a legitimate path survives byte-for-byte.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Auth } from '../src/instance.js';
import { handleLogin, safeNextPath } from '../src/routes.js';

/** A fake Better Auth instance whose sign-in always succeeds with no cookies. */
function fakeAuth(): Auth {
  return {
    api: {
      signInEmail: async () => ({ headers: new Headers() }),
    },
  } as unknown as Auth;
}

/** Build a same-origin login POST carrying the given `next` value. */
function loginRequest(next: string): Request {
  const body = new URLSearchParams({ email: 'user@example.com', password: 'secret', next });
  return new Request('https://app.example/api/login', {
    method: 'POST',
    headers: {
      origin: 'https://app.example',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
}

describe('safeNextPath', () => {
  it('rejects a backslash that browsers normalize to a slash', () => {
    assert.equal(safeNextPath('/\\outside.example'), '/dashboard');
  });

  it('rejects a protocol-relative path', () => {
    assert.equal(safeNextPath('//evil.example'), '/dashboard');
  });

  it('rejects an absolute URL', () => {
    assert.equal(safeNextPath('https://evil.example'), '/dashboard');
  });

  it('rejects a percent-encoded backslash', () => {
    assert.equal(safeNextPath('/%5Cevil.example'), '/dashboard');
  });

  it('rejects an absent value', () => {
    assert.equal(safeNextPath(''), '/dashboard');
  });

  it('preserves a query string exactly', () => {
    assert.equal(safeNextPath('/settings?tab=1'), '/settings?tab=1');
  });

  it('preserves a fragment exactly', () => {
    assert.equal(safeNextPath('/settings#section'), '/settings#section');
  });
});

describe('handleLogin redirect', () => {
  it('falls back to /dashboard for a backslash next value', async () => {
    const response = await handleLogin(loginRequest('/\\outside.example'), fakeAuth());
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/dashboard');
  });
});
