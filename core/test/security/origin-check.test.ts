/**
 * The cross-site check (`security/origin-check.ts`): the verdict reads only
 * `Origin`, compared exactly, and `Sec-Fetch-Site` when `Origin` is absent;
 * it applies to an unsafe method on a cookie-accepting surface; a header
 * credential marker is read only from the session's own data.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Session } from '../../src/contracts/http.js';
import {
  crossSiteVerdict,
  isHeaderAuthenticatedSession,
  isUnsafeMethod,
  requiresOriginCheck,
} from '../../src/security/origin-check.js';

const APP = 'https://app.example.com';

function post(headers: Record<string, string>, url = `${APP}/api/posts`): Request {
  return new Request(url, { method: 'POST', headers });
}

describe('crossSiteVerdict', () => {
  it('is same-origin only when Origin equals the expected origin exactly', () => {
    assert.equal(crossSiteVerdict(post({ origin: APP }), APP), 'same-origin');
    for (const origin of [
      'http://app.example.com',
      'https://app.example.com:8443',
      'https://evil.example.com',
      'https://APP.example.com',
      `${APP}/`,
      'null',
      '',
    ]) {
      assert.equal(crossSiteVerdict(post({ origin }), APP), 'cross-site', origin);
    }
  });

  it('lets Origin decide over Sec-Fetch-Site when both are sent', () => {
    const request = post({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' });
    assert.equal(crossSiteVerdict(request, APP), 'cross-site');
  });

  it('falls back to Sec-Fetch-Site: same-origin only when Origin is absent', () => {
    assert.equal(crossSiteVerdict(post({ 'sec-fetch-site': 'same-origin' }), APP), 'same-origin');
    for (const site of ['same-site', 'cross-site', 'none', 'SAME-ORIGIN']) {
      assert.equal(crossSiteVerdict(post({ 'sec-fetch-site': site }), APP), 'cross-site', site);
    }
  });

  it('fails closed for a request naming no site, or naming it only in Referer', () => {
    assert.equal(crossSiteVerdict(post({}), APP), 'cross-site');
    assert.equal(crossSiteVerdict(post({ referer: `${APP}/form` }), APP), 'cross-site');
  });

  it('never derives the expected origin from the request URL', () => {
    // A request addressed over plain HTTP behind a TLS proxy: the caller's
    // expected origin decides, not the URL the proxy forwarded.
    const request = post({ origin: 'http://internal:3000' }, 'http://internal:3000/api/posts');
    assert.equal(crossSiteVerdict(request, APP), 'cross-site');
  });
});

describe('isUnsafeMethod and requiresOriginCheck', () => {
  it('treats everything but GET, HEAD and OPTIONS as unsafe', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      assert.equal(isUnsafeMethod(method), false, method);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND', 'post']) {
      assert.equal(isUnsafeMethod(method), true, method);
    }
  });

  it('applies to an unsafe method on a surface accepting cookies, and only there', () => {
    assert.equal(requiresOriginCheck('POST', ['cookie']), true);
    assert.equal(requiresOriginCheck('DELETE', ['cookie', 'token']), true);
    assert.equal(requiresOriginCheck('GET', ['cookie']), false);
    assert.equal(requiresOriginCheck('POST', ['token']), false);
    assert.equal(requiresOriginCheck('POST', []), false);
  });
});

describe('isHeaderAuthenticatedSession', () => {
  const withData = (data: Session['data']): Session => ({ id: 'a', data, expiresAt: 0 });

  it('is true for the bearer and api-token markers', () => {
    assert.equal(isHeaderAuthenticatedSession(withData({ authMethod: 'bearer' })), true);
    assert.equal(isHeaderAuthenticatedSession(withData({ authMethod: 'api-token' })), true);
  });

  it('is false for a cookie session, an absent marker, or any other value', () => {
    assert.equal(isHeaderAuthenticatedSession(withData({ authMethod: 'cookie' })), false);
    assert.equal(isHeaderAuthenticatedSession(withData({})), false);
    assert.equal(isHeaderAuthenticatedSession(withData({ authMethod: 'BEARER' })), false);
    assert.equal(isHeaderAuthenticatedSession(withData({ authMethod: ['bearer'] })), false);
    assert.equal(isHeaderAuthenticatedSession(withData({ auth: { authMethod: 'bearer' } })), false);
  });

  it('ignores an inherited marker', () => {
    const data = Object.create({ authMethod: 'bearer' }) as Session['data'];
    assert.equal(isHeaderAuthenticatedSession(withData(data)), false);
  });
});
