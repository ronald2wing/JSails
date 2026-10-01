/**
 * Tests for the request guards: form-body parsing drops prototype keys and an
 * untouched file input, a mutation needs a same-origin `Origin` (against the
 * origin core resolved for the request when present) plus a constant-time `_csrf` match,
 * and the session gate resolves then authorizes, failing closed and reporting
 * a throwing resolver or authorize through `onError`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Hono } from 'hono';

import { defineAdminPanel, type AdminErrorContext } from '../src/index.js';
import {
  assertAdminMutation,
  assertAdminSession,
  readFormBody,
  readFormBodyAndFiles,
} from '../src/guards.js';
import { SESSION } from './fixtures.js';

/** Run `assertAdminMutation` inside a Hono handler, optionally with a resolved origin. */
async function mutationAllowed(
  request: Request,
  body: Record<string, string>,
  origin?: string,
): Promise<boolean> {
  const app = new Hono<{ Variables: { origin?: { origin: string } } }>();
  app.use('*', async (c, next) => {
    if (origin !== undefined) c.set('origin', { origin });
    await next();
  });
  app.all('*', (c) => c.text(String(assertAdminMutation(c, SESSION, body))));
  return (await (await app.fetch(request)).text()) === 'true';
}

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

  it('drops the empty part an untouched file input submits but keeps a real upload', async () => {
    const form = new FormData();
    form.set('_csrf', 'token');
    form.set('photo', new File([], ''));
    form.set('doc', new File([new Uint8Array([1, 2])], 'a.bin'));
    const parsed = await readFormBodyAndFiles(
      new Request('http://localhost/x', { method: 'POST', body: form }),
    );
    assert.equal(parsed.values['_csrf'], 'token');
    // The untouched input is never a file part, whatever string the parser keeps.
    assert.deepEqual([...parsed.files.keys()], ['doc']);
  });

  it('asserts a same-origin, CSRF-matching mutation', async () => {
    const request = () =>
      new Request('http://localhost/x', { headers: { origin: 'http://localhost' } });
    assert.equal(await mutationAllowed(request(), { _csrf: SESSION.csrfToken }), true);
    assert.equal(await mutationAllowed(request(), { _csrf: 'wrong' }), false);
    assert.equal(await mutationAllowed(request(), {}), false);
  });

  it('compares the Origin with the resolved origin behind a TLS proxy', async () => {
    // The proxy terminates TLS: the app sees http:// while the browser sends https://.
    const request = (origin: string) =>
      new Request('http://admin.example/x', { headers: { origin } });
    const body = { _csrf: SESSION.csrfToken };
    assert.equal(
      await mutationAllowed(request('https://admin.example'), body, 'https://admin.example'),
      true,
    );
    // Without a resolved origin the request URL's scheme decides, so the post is refused.
    assert.equal(await mutationAllowed(request('https://admin.example'), body), false);
    // The resolved origin replaces the request URL's origin; it does not add to it.
    assert.equal(
      await mutationAllowed(request('http://admin.example'), body, 'https://admin.example'),
      false,
    );
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
