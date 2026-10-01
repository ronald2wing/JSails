/**
 * Tests for the login handler of the `auth` plugin.
 *
 * `handleLogin` enforces the same-origin boundary before touching Better Auth
 * and forwards the session cookie on success. Its `next` validation is the
 * only gate between a hostile `next` form field and the `Location` header, so
 * these cases pin every off-origin shape a browser would normalize
 * (backslashes, protocol-relative, absolute) to the `/dashboard` fallback, and
 * prove a legitimate path survives byte-for-byte.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleLogin } from '../src/routes.js';
import { fakeAuth, formRequest, ORIGIN } from './fixtures.js';

/** A fake Better Auth instance whose sign-in always succeeds with no cookies. */
const auth = fakeAuth({ signInEmail: async () => ({ headers: new Headers() }) });

/** Log in with the given `next` value and return the redirect target. */
async function redirectFor(next: string): Promise<string | null> {
  const request = formRequest('/api/login', {
    email: 'user@example.com',
    password: 'secret',
    next,
  });
  const response = await handleLogin(request, { auth });
  assert.equal(response.status, 303);
  return response.headers.get('location');
}

describe('handleLogin', () => {
  it('rejects a cross-origin request before touching Better Auth', async () => {
    let called = false;
    const recording = fakeAuth({
      signInEmail: async () => {
        called = true;
        return { headers: new Headers() };
      },
    });
    const request = formRequest(
      '/api/login',
      { email: 'a@b.co', password: 'pw' },
      'http://evil.example',
    );
    const response = await handleLogin(request, { auth: recording, publicOrigin: ORIGIN });
    assert.equal(response.status, 403);
    assert.equal(called, false);
  });

  it('redirects to the dashboard and forwards the session cookie on success', async () => {
    const signingIn = fakeAuth({
      signInEmail: async () => ({ headers: new Headers({ 'set-cookie': 'session=abc' }) }),
    });
    const request = formRequest('/api/login', { email: 'a@b.co', password: 'pw' });
    const response = await handleLogin(request, { auth: signingIn, publicOrigin: ORIGIN });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/dashboard');
    assert.equal(response.headers.get('set-cookie'), 'session=abc');
  });

  it('answers a generic 429 when the rate-limit hook denies', async () => {
    const request = formRequest('/api/login', { email: 'a@b.co', password: 'pw' });
    const response = await handleLogin(request, { auth, rateLimit: () => false });
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), {
      error: { status: 429, code: 'rate_limited', message: 'too many requests' },
    });
  });
});

describe('handleLogin post-login redirect', () => {
  it('rejects a backslash that browsers normalize to a slash', async () => {
    assert.equal(await redirectFor('/\\outside.example'), '/dashboard');
  });

  it('rejects a protocol-relative path', async () => {
    assert.equal(await redirectFor('//evil.example'), '/dashboard');
  });

  it('rejects an absolute URL', async () => {
    assert.equal(await redirectFor('https://evil.example'), '/dashboard');
  });

  it('rejects a percent-encoded backslash', async () => {
    assert.equal(await redirectFor('/%5Cevil.example'), '/dashboard');
  });

  it('rejects an absent value', async () => {
    assert.equal(await redirectFor(''), '/dashboard');
  });

  it('preserves a query string exactly', async () => {
    assert.equal(await redirectFor('/settings?tab=1'), '/settings?tab=1');
  });

  it('preserves a fragment exactly', async () => {
    assert.equal(await redirectFor('/settings#section'), '/settings#section');
  });
});
