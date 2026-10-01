/**
 * Tests for the admin guards: form-body parsing drops prototype keys and an
 * untouched file input, and the session gate resolves then authorizes once
 * per request, failing closed and reporting a throwing resolver or authorize
 * through `onError`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineAdminPanel, type AdminErrorContext } from '../src/index.js';
import { assertAdminSession, readFormBodyAndFiles } from '../src/guards.js';
import { SESSION } from './fixtures.js';
describe('admin guards', () => {
  it('parses a form body and drops dangerous prototype keys', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ a: '1', __proto__: 'evil' }).toString(),
    });
    const body = await readFormBodyAndFiles(request);
    assert.deepEqual(body.values, { a: '1' });
  });

  it('drops the empty part an untouched file input submits but keeps a real upload', async () => {
    const form = new FormData();
    form.set('note', 'kept');
    form.set('photo', new File([], ''));
    form.set('doc', new File([new Uint8Array([1, 2])], 'a.bin'));
    const parsed = await readFormBodyAndFiles(
      new Request('http://localhost/x', { method: 'POST', body: form }),
    );
    assert.equal(parsed.values['note'], 'kept');
    // The untouched input is never a file part, whatever string the parser keeps.
    assert.deepEqual([...parsed.files.keys()], ['doc']);
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

  it('resolves and authorizes once per request for the access check and the handler', async () => {
    let resolved = 0;
    let authorized = 0;
    const panel = defineAdminPanel({
      resolveSession: () => {
        resolved += 1;
        return SESSION;
      },
      authorize: () => {
        authorized += 1;
        return true;
      },
    });
    const request = new Request('http://localhost/x');
    assert.equal(
      await assertAdminSession(panel, request),
      await assertAdminSession(panel, request),
    );
    assert.deepEqual([resolved, authorized], [1, 1]);
    await assertAdminSession(panel, new Request('http://localhost/x'));
    assert.deepEqual([resolved, authorized], [2, 2]);
  });

  it('refuses a bearer or API-token session before authorize runs', async () => {
    const request = new Request('http://localhost/x', {
      headers: { authorization: 'Bearer token' },
    });
    for (const authMethod of ['bearer', 'api-token']) {
      let authorized = 0;
      const panel = defineAdminPanel({
        resolveSession: () => ({ ...SESSION, data: { ...SESSION.data, authMethod } }),
        authorize: () => {
          authorized += 1;
          return true;
        },
      });
      assert.equal(await assertAdminSession(panel, request), null, authMethod);
      assert.equal(authorized, 0, authMethod);
    }
    const cookie = defineAdminPanel({
      resolveSession: () => ({ ...SESSION, data: { ...SESSION.data, authMethod: 'cookie' } }),
      authorize: () => true,
    });
    assert.notEqual(await assertAdminSession(cookie, request), null);
  });

  it('reports a throwing resolver or authorize through onError', async () => {
    const reports: AdminErrorContext[] = [];
    const onError = (_error: unknown, context: AdminErrorContext) => {
      reports.push(context);
    };
    const request = new Request('http://localhost/x');
    const brokenResolver = defineAdminPanel({
      resolveSession: () => {
        throw new Error('session store down');
      },
      authorize: () => true,
      onError,
    });
    assert.equal(await assertAdminSession(brokenResolver, request), null);
    const brokenAuthorize = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => {
        throw new Error('policy store down');
      },
      onError,
    });
    assert.equal(await assertAdminSession(brokenAuthorize, request), null);
    assert.deepEqual(reports, [{ surface: 'session' }, { surface: 'authorize' }]);
  });
});
