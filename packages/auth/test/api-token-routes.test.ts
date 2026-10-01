/**
 * Tests for the mounted `/api/tokens` routes: `authPlugin` mounts them only
 * when enabled, manages tokens from the cookie session alone, and protects
 * mutations with the same-origin + CSRF boundary.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestApp } from 'jsails/testing';

import { createApiTokenHandlers } from '../src/api-token-routes.js';
import { createApiTokenService } from '../src/api-token-service.js';
import { authPlugin, type Auth, type CreatedApiToken } from '../src/index.js';
import {
  cookieSession,
  createInMemoryTokenStore,
  deriveCsrf,
  fakeAuth,
  ORIGIN,
  SECRET,
  USER_ID,
} from './fixtures.js';

describe('createApiTokenHandlers', () => {
  it('manages tokens from the cookie session only, never from a bearer token', async () => {
    const service = createApiTokenService({
      store: createInMemoryTokenStore(),
      cookieSession: async () => null,
      secret: SECRET,
      headerName: 'authorization',
      expiresInDays: 30,
    });
    const seen: Array<string | null> = [];
    const handlers = createApiTokenHandlers({
      service,
      resolveSession: async (request) => {
        seen.push(request.headers.get('authorization'));
        return request.headers.get('cookie') === 'session=abc' ? cookieSession() : null;
      },
    });

    const bearerOnly = await handlers.list(
      new Request(`${ORIGIN}/api/tokens`, { headers: { authorization: 'Bearer x' } }),
    );
    assert.equal(bearerOnly.status, 401);
    assert.deepEqual(await bearerOnly.json(), {
      error: { status: 401, code: 'unauthorized', message: 'authentication required' },
    });

    const withCookie = await handlers.list(
      new Request(`${ORIGIN}/api/tokens`, {
        headers: { authorization: 'Bearer x', cookie: 'session=abc' },
      }),
    );
    assert.equal(withCookie.status, 200);
    assert.deepEqual(seen, [null, null]);
  });

  it('answers a malformed create body in the error envelope', async () => {
    const service = createApiTokenService({
      store: createInMemoryTokenStore(),
      cookieSession: async () => cookieSession(),
      secret: SECRET,
      headerName: 'authorization',
      expiresInDays: 30,
    });
    const handlers = createApiTokenHandlers({
      service,
      resolveSession: async () => cookieSession(),
      publicOrigin: ORIGIN,
    });

    const response = await handlers.create(
      new Request(`${ORIGIN}/api/tokens`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          'x-csrf-token': deriveCsrf('session-1'),
        },
        body: 'not json',
      }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { status: 400, code: 'invalid_body', message: 'request body must be valid JSON' },
    });
  });
});

describe('authPlugin api tokens', () => {
  function sessionAuth(authenticated: boolean): Auth {
    return fakeAuth({
      getSession: async () =>
        authenticated
          ? {
              session: { id: 'session-1', expiresAt: new Date('2099-01-01T00:00:00.000Z') },
              user: { id: USER_ID, name: 'Ada', email: 'ada@example.com' },
            }
          : null,
    });
  }

  async function buildApp(options: { enabled: boolean; authenticated?: boolean }) {
    const store = createInMemoryTokenStore();
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [
          authPlugin({
            createAuth: () => sessionAuth(options.authenticated ?? true),
            secret: SECRET,
            publicOrigin: ORIGIN,
            apiTokens: { enabled: options.enabled, store },
          }),
        ],
      },
    });
    return { app, store };
  }

  const csrf = deriveCsrf('session-1');

  it('mints, lists, and revokes a token over the mounted routes', async () => {
    const { app } = await buildApp({ enabled: true });

    const created = await app.json<CreatedApiToken>('/api/tokens', {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        cookie: 'session=abc',
      },
      body: JSON.stringify({ name: 'ci' }),
    });

    assert.equal(created.name, 'ci');
    assert.equal(typeof created.token, 'string');
    assert.equal(typeof created.id, 'string');

    const listed = await app.json<Array<{ id: string; token?: string }>>('/api/tokens', {
      headers: { cookie: 'session=abc' },
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, created.id);
    assert.equal('token' in (listed[0] ?? {}), false);

    const removed = await app.json<{ revoked: boolean }>(`/api/tokens/${created.id}`, {
      method: 'DELETE',
      headers: { origin: ORIGIN, 'x-csrf-token': csrf, cookie: 'session=abc' },
    });
    assert.equal(removed.revoked, true);

    const gone = await app.request(`/api/tokens/${created.id}`, {
      method: 'DELETE',
      headers: { origin: ORIGIN, 'x-csrf-token': csrf, cookie: 'session=abc' },
    });
    assert.equal(gone.status, 404);

    await app.close();
  });

  it('rejects an unauthenticated management request', async () => {
    const { app } = await buildApp({ enabled: true, authenticated: false });

    const response = await app.request('/api/tokens', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ci' }),
    });
    assert.equal(response.status, 401);

    await app.close();
  });

  it('rejects a mutation without a valid CSRF token', async () => {
    const { app } = await buildApp({ enabled: true });

    const response = await app.request('/api/tokens', {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: 'session=abc',
      },
      body: JSON.stringify({ name: 'ci' }),
    });
    assert.equal(response.status, 403);

    await app.close();
  });

  it('does not mount the token surface when disabled (default)', async () => {
    const { app } = await buildApp({ enabled: false });

    const response = await app.request('/api/tokens', {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: 'session=abc',
      },
      body: JSON.stringify({ name: 'ci' }),
    });
    assert.equal(response.status, 404);

    await app.close();
  });
});
