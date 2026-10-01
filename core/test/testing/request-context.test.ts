/**
 * Tests for `createTestRequestContext` (`jsails/testing`).
 *
 * The helper exists so generated route/page tests can call a handler directly
 * without constructing a fake Hono context. These cases pin the fields the
 * pipeline promises: an absolute URL, a real `Request`, route params, session,
 * headers, and the origin and client the pipeline would resolve.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestRequestContext } from '../../src/testing/index.js';

describe('createTestRequestContext', () => {
  it('defaults to a GET request at http://localhost/', () => {
    const context = createTestRequestContext();

    assert.equal(context.url.href, 'http://localhost/');
    assert.equal(context.request.method, 'GET');
    assert.equal(context.request.url, 'http://localhost/');
    assert.equal(context.session, null);
    assert.deepEqual(context.params, {});
    assert.deepEqual(context.origin, {
      origin: 'http://localhost',
      host: 'localhost',
      canonical: false,
    });
    assert.deepEqual(context.client, { via: 'unknown', bucket: 'unknown' });
  });

  it('threads a URL, method, headers, params, session, and client', () => {
    const session = { id: 'session-1', csrfToken: 'csrf-1', data: {}, expiresAt: 0 };
    const context = createTestRequestContext({
      url: 'https://example.test/posts/42?tab=comments',
      method: 'POST',
      headers: { 'x-test': 'yes' },
      params: { id: '42' },
      session,
      client: { via: 'socket', ip: '198.51.100.7', bucket: '198.51.100.7' },
    });

    assert.equal(context.url.pathname, '/posts/42');
    assert.equal(context.url.search, '?tab=comments');
    assert.equal(context.request.method, 'POST');
    assert.equal(context.request.headers.get('x-test'), 'yes');
    assert.deepEqual(context.params, { id: '42' });
    assert.equal(context.session, session);
    assert.equal(context.origin?.origin, 'https://example.test');
    assert.deepEqual(context.client, { via: 'socket', ip: '198.51.100.7', bucket: '198.51.100.7' });
  });
});
