/**
 * Trusted-mutation checks: `isSameOriginRequest`, `csrfTokenValid`, and the
 * combined `checkTrustedMutation` result codes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Session } from '../../src/contracts/http.js';
import {
  checkTrustedMutation,
  csrfTokenValid,
  isHeaderAuthenticatedSession,
  isSameOriginRequest,
  isUnsafeMethod,
  requestSite,
} from '../../src/security/trusted-mutation.js';

/**
 * Tests for the trusted-mutation guard. No I/O — same-origin is a pure string
 * comparison and CSRF delegates to the constant-time `safeEqualStrings`.
 */

const SESSION: Session = { id: 'a', csrfToken: 'secret-abc', data: {}, expiresAt: 0 };

function requestWithOrigin(origin: string, url = 'https://app.example.com/foo'): Request {
  return new Request(url, { headers: { origin } });
}

function requestWithoutOrigin(url = 'https://app.example.com/foo'): Request {
  return new Request(url);
}

describe('isSameOriginRequest', () => {
  it('matches when Origin equals the expected origin', () => {
    const req = requestWithOrigin('https://app.example.com');
    assert.equal(isSameOriginRequest(req, 'https://app.example.com'), true);
  });

  it('rejects when Origin differs in scheme', () => {
    const req = requestWithOrigin('http://app.example.com');
    assert.equal(isSameOriginRequest(req, 'https://app.example.com'), false);
  });

  it('rejects when Origin differs in host', () => {
    const req = requestWithOrigin('https://evil.example.com');
    assert.equal(isSameOriginRequest(req, 'https://app.example.com'), false);
  });

  it('rejects when Origin differs in port', () => {
    const req = requestWithOrigin('https://app.example.com:8080');
    assert.equal(isSameOriginRequest(req, 'https://app.example.com'), false);
  });

  it('rejects when Origin header is absent', () => {
    const req = requestWithoutOrigin();
    assert.equal(isSameOriginRequest(req, 'https://app.example.com'), false);
  });

  it('falls back to the request URL origin when no expectedOrigin is given', () => {
    const req = requestWithOrigin('https://app.example.com', 'https://app.example.com/page');
    assert.equal(isSameOriginRequest(req), true);
  });

  it('rejects against fallback when Origin differs', () => {
    const req = requestWithOrigin('https://evil.example.com', 'https://app.example.com/page');
    assert.equal(isSameOriginRequest(req), false);
  });
});

describe('requestSite', () => {
  const site = (headers: Record<string, string>): string =>
    requestSite(new Request('https://app.example.com/foo', { headers }), 'https://app.example.com');

  it('lets Origin decide when present', () => {
    assert.equal(site({ origin: 'https://app.example.com' }), 'same-origin');
    assert.equal(
      site({ origin: 'https://evil.example.com', 'sec-fetch-site': 'same-origin' }),
      'cross-site',
    );
    assert.equal(site({ origin: 'null' }), 'cross-site');
  });

  it('falls back to Sec-Fetch-Site, then the Referer origin', () => {
    assert.equal(site({ 'sec-fetch-site': 'same-origin' }), 'same-origin');
    assert.equal(site({ 'sec-fetch-site': 'same-site' }), 'cross-site');
    assert.equal(
      site({ 'sec-fetch-site': 'cross-site', referer: 'https://app.example.com/a' }),
      'cross-site',
    );
    assert.equal(site({ referer: 'https://app.example.com/login?next=1' }), 'same-origin');
    assert.equal(site({ referer: 'https://app.example.com.evil.example/' }), 'cross-site');
    assert.equal(site({ referer: '::not a url' }), 'cross-site');
  });

  it('is unknown when no site header is sent', () => {
    assert.equal(site({}), 'unknown');
  });
});

describe('isUnsafeMethod', () => {
  it('treats everything but GET, HEAD, and OPTIONS as unsafe', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      assert.equal(isUnsafeMethod(method), false, method);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND']) {
      assert.equal(isUnsafeMethod(method), true, method);
    }
  });
});

describe('csrfTokenValid', () => {
  it('matches when the supplied token equals the session token', () => {
    assert.equal(csrfTokenValid(SESSION, 'secret-abc'), true);
  });

  it('rejects a mismatched token', () => {
    assert.equal(csrfTokenValid(SESSION, 'wrong-token'), false);
  });

  it('rejects an undefined value', () => {
    assert.equal(csrfTokenValid(SESSION, undefined), false);
  });

  it('rejects a null value', () => {
    assert.equal(csrfTokenValid(SESSION, null), false);
  });

  it('rejects an empty string', () => {
    assert.equal(csrfTokenValid(SESSION, ''), false);
  });

  it('rejects a non-string value', () => {
    assert.equal(csrfTokenValid(SESSION, 123), false);
  });
});

describe('checkTrustedMutation', () => {
  it('allows when same-origin and CSRF both pass', () => {
    const req = requestWithOrigin('https://app.example.com');
    const result = checkTrustedMutation(req, SESSION, {
      expectedOrigin: 'https://app.example.com',
      csrfValue: SESSION.csrfToken,
    });
    assert.deepEqual(result, { allowed: true });
  });

  it('denies with origin_mismatch when Origin differs', () => {
    const req = requestWithOrigin('https://evil.example.com');
    const result = checkTrustedMutation(req, SESSION, {
      expectedOrigin: 'https://app.example.com',
      csrfValue: SESSION.csrfToken,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'origin_mismatch');
    assert.equal(result.status, 403);
    assert.equal(typeof result.message, 'string');
    // The message must not echo the submitted origin.
    assert.equal(result.message.includes('evil.example.com'), false);
  });

  it('denies with csrf_mismatch when CSRF token is wrong', () => {
    const req = requestWithOrigin('https://app.example.com');
    const result = checkTrustedMutation(req, SESSION, {
      expectedOrigin: 'https://app.example.com',
      csrfValue: 'wrong-token',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'csrf_mismatch');
    assert.equal(result.status, 403);
    // The message must not echo the submitted token.
    assert.equal(result.message.includes('wrong-token'), false);
  });

  it('denies a cross-origin request without a session', () => {
    const req = requestWithOrigin('https://evil.example.com');
    const result = checkTrustedMutation(req, null, { expectedOrigin: 'https://app.example.com' });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'origin_mismatch');
  });

  it('allows a same-origin request without a session and needs no token for it', () => {
    const req = requestWithOrigin('https://app.example.com');
    const result = checkTrustedMutation(req, null, { expectedOrigin: 'https://app.example.com' });
    assert.deepEqual(result, { allowed: true });
  });

  it('allows a site-less request only without a session and without cookies', () => {
    assert.deepEqual(checkTrustedMutation(requestWithoutOrigin(), null), { allowed: true });
    const withCookie = new Request('https://app.example.com/foo', {
      headers: { cookie: 'session=stale' },
    });
    assert.equal(checkTrustedMutation(withCookie, null).allowed, false);
    assert.equal(
      checkTrustedMutation(requestWithoutOrigin(), SESSION, { csrfValue: SESSION.csrfToken })
        .allowed,
      false,
    );
  });

  it('denies with origin_mismatch when csrfValue is not provided and Origin mismatches', () => {
    const req = requestWithOrigin('https://evil.example.com');
    const result = checkTrustedMutation(req, SESSION, {
      expectedOrigin: 'https://app.example.com',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'origin_mismatch');
  });

  it('denies with csrf_mismatch when csrfValue is absent but Origin matches', () => {
    const req = requestWithOrigin('https://app.example.com');
    const result = checkTrustedMutation(req, SESSION, {
      expectedOrigin: 'https://app.example.com',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'csrf_mismatch');
  });
});

describe('isHeaderAuthenticatedSession', () => {
  const withData = (data: Session['data']): Session => ({ ...SESSION, data });

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
