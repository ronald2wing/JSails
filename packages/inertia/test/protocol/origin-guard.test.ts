/**
 * The Origin check (Inertia's CSRF defence): safe methods pass, an unsafe
 * request passes only from the trusted origin by `Origin`, then
 * `Sec-Fetch-Site`, then `Referer`, a header-less request passes only
 * without a cookie, and the refusal is a value-free `403`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InertiaError, originGuard, outcomeToResponse } from '../../src/index.js';
import { facts, header, inertiaHeaders } from './engine-fixture.js';

const ORIGIN = 'https://example.test';

function post(headers: Readonly<Record<string, string>>, method = 'POST') {
  return facts('/tasks', inertiaHeaders(headers), { method });
}

describe('originGuard', () => {
  it('lets safe methods through whatever their origin', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      assert.equal(
        originGuard(post({ Origin: 'https://evil.example', Cookie: 'a=1' }, method)),
        null,
      );
    }
  });

  it('lets an unsafe request from the request origin through', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'QUERY']) {
      assert.equal(originGuard(post({ Origin: ORIGIN, Cookie: 'a=1' }, method)), null);
    }
  });

  it('refuses an unsafe request from another origin with a value-free 403', async () => {
    for (const origin of ['https://evil.example', 'http://example.test', 'null']) {
      const outcome = originGuard(post({ Origin: origin, Cookie: 'a=1' }, 'PUT'));
      assert.ok(outcome !== null);
      assert.equal(outcome.kind, 'forbidden');
      assert.equal(outcome.status, 403);
      assert.equal(outcome.code, 'origin_mismatch');
      assert.equal(header(outcome, 'cache-control'), 'private, no-store');
      assert.equal(header(outcome, 'vary'), 'X-Inertia, Precognition');
      assert.equal(header(outcome, 'x-inertia'), null);
      const response = outcomeToResponse(outcome);
      assert.equal(response.headers.get('content-type'), 'application/problem+json');
      assert.deepEqual(await response.json(), {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Cross-origin request rejected',
        code: 'origin_mismatch',
      });
      assert.ok(!outcome.body?.includes(origin));
    }
  });

  it('decides by Origin first, then Sec-Fetch-Site, then Referer', () => {
    const cookie = { Cookie: 'a=1' };
    assert.notEqual(
      originGuard(
        post({ ...cookie, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' }),
      ),
      null,
    );
    assert.equal(
      originGuard(post({ ...cookie, Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' })),
      null,
    );
    assert.equal(originGuard(post({ ...cookie, 'Sec-Fetch-Site': 'same-origin' })), null);
    for (const site of ['same-site', 'cross-site', 'none']) {
      assert.notEqual(originGuard(post({ ...cookie, 'Sec-Fetch-Site': site })), null);
    }
    assert.equal(originGuard(post({ ...cookie, Referer: `${ORIGIN}/tasks/new` })), null);
    assert.notEqual(originGuard(post({ ...cookie, Referer: 'https://evil.example/x' })), null);
    assert.notEqual(originGuard(post({ ...cookie, Referer: 'not a url' })), null);
  });

  it('lets a header-less request through only when it carries no cookie', () => {
    assert.equal(originGuard(post({})), null);
    assert.notEqual(originGuard(post({ Cookie: 'session=1' })), null);
  });

  it('compares against a configured public origin instead of the request URL', () => {
    const behindProxy = facts(
      '/tasks',
      { Origin: 'https://app.example', Cookie: 'a=1' },
      {
        method: 'POST',
        origin: 'http://10.0.0.5:3000',
      },
    );
    assert.notEqual(originGuard(behindProxy), null);
    assert.equal(originGuard(behindProxy, { origin: 'https://app.example' }), null);
  });

  it('rejects a trusted origin that is not a bare http(s) origin', () => {
    for (const origin of ['https://app.example/', 'app.example', 'ftp://app.example', '']) {
      assert.throws(
        () => originGuard(post({}), { origin }),
        (error: unknown) => error instanceof InertiaError && error.code === 'invalid_options',
      );
    }
  });
});
