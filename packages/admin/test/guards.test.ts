/**
 * Tests for the request guards: form-body parsing drops prototype keys, a
 * mutation needs a same-origin `Origin` plus a constant-time `_csrf` match, and
 * the session gate resolves then authorizes, failing closed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineAdminPanel } from '../src/index.js';
import { assertAdminMutation, assertAdminSession, readFormBody } from '../src/guards.js';
import { SESSION } from './fixtures.js';

describe('admin guards', () => {
  it('parses a form body and drops dangerous prototype keys', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ a: '1', __proto__: 'evil' }).toString(),
    });
    const body = await readFormBody(request);
    assert.deepEqual(body, { a: '1' });
  });

  it('asserts a same-origin, CSRF-matching mutation', () => {
    const request = new Request('http://localhost/x', {
      headers: { origin: 'http://localhost' },
    });
    assert.equal(assertAdminMutation(request, SESSION, { _csrf: SESSION.csrfToken }), true);
    assert.equal(assertAdminMutation(request, SESSION, { _csrf: 'wrong' }), false);
    assert.equal(assertAdminMutation(request, SESSION, {}), false);
  });

  it('resolves and authorizes the admin session, failing closed', async () => {
    const request = new Request('http://localhost/x');
    const allow = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
    });
    assert.deepEqual(await assertAdminSession(allow, request), SESSION);

    const deny = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => false,
    });
    assert.equal(await assertAdminSession(deny, request), null);
  });
});
