/**
 * Tests for the API-token service: it enforces a signed-in session, validates
 * names and lifetimes, and resolves a request cookie-first then by token,
 * failing closed when the token is unknown. The plugin options resolver is
 * covered too.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ApiTokenError,
  createApiTokenService,
  resolveApiTokensOptions,
} from '../src/api-token-service.js';
import type { ApiTokenStore } from '../src/api-token-store.js';
import { cookieSession, createInMemoryTokenStore, requestContext, USER_ID } from './fixtures.js';

describe('resolveApiTokensOptions', () => {
  it('defaults to disabled, the authorization header, and 30 days', () => {
    assert.deepEqual(resolveApiTokensOptions(), {
      enabled: false,
      headerName: 'authorization',
      expiresInDays: 30,
    });
  });

  it('rejects a header name with control characters and an out-of-range lifetime', () => {
    assert.throws(() => resolveApiTokensOptions({ headerName: 'x\ny' }), {
      name: 'TypeError',
    });
    assert.throws(() => resolveApiTokensOptions({ expiresInDays: 0 }), { name: 'TypeError' });
    assert.throws(() => resolveApiTokensOptions({ expiresInDays: 3651 }), { name: 'TypeError' });
  });
});

describe('createApiTokenService', () => {
  function createService(store: ApiTokenStore) {
    return createApiTokenService({
      store,
      cookieSession: async (request) => {
        const cookie = request.headers.get('cookie');
        return cookie === 'session=abc' ? cookieSession() : null;
      },
      headerName: 'authorization',
      expiresInDays: 30,
    });
  }

  it('creates, lists, and revokes a token for a signed-in session', async () => {
    const store = createInMemoryTokenStore();
    const service = createService(store);

    const created = await service.createApiToken(requestContext(cookieSession()), {
      name: '  ci  ',
    });
    assert.equal(created.name, 'ci');
    assert.equal(typeof created.token, 'string');

    const listed = await service.listApiTokens(requestContext(cookieSession()));
    assert.equal(listed.length, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(listed[0], 'token'));

    assert.equal(await service.revokeApiToken(requestContext(cookieSession()), created.id), true);
    assert.equal(await service.revokeApiToken(requestContext(cookieSession()), created.id), false);
  });

  it('rejects an unauthenticated session', async () => {
    const service = createService(createInMemoryTokenStore());
    await assert.rejects(
      service.createApiToken(requestContext(null), { name: 'ci' }),
      (error: unknown) => error instanceof ApiTokenError && error.status === 401,
    );
  });

  it('validates names and lifetimes', async () => {
    const service = createService(createInMemoryTokenStore());
    const session = cookieSession();

    for (const name of ['', '   ', 'a'.repeat(201), 'bad\nname']) {
      await assert.rejects(
        service.createApiToken(requestContext(session), { name }),
        (error: unknown) => error instanceof ApiTokenError && error.status === 400,
      );
    }

    for (const expiresInDays of [0, -1, 3651, 1.5]) {
      await assert.rejects(
        service.createApiToken(requestContext(session), { name: 'ci', expiresInDays }),
        (error: unknown) => error instanceof ApiTokenError && error.status === 400,
      );
    }
  });

  it('resolves an API token before the cookie, then falls back, failing closed', async () => {
    const store = createInMemoryTokenStore();
    const service = createService(store);
    const created = await service.createApiToken(requestContext(cookieSession()), { name: 'ci' });

    // A header token is resolved through the store, never through the cookie
    // path (whose Better Auth getSession would slide the token's expiry).
    const both = new Request('http://localhost/', {
      headers: { cookie: 'session=abc', authorization: `Bearer ${created.token}` },
    });
    assert.equal((await service.resolveSessionWithApiToken(both))?.id, created.id);

    // No token: the cookie resolves.
    const cookieRequest = new Request('http://localhost/', { headers: { cookie: 'session=abc' } });
    assert.equal((await service.resolveSessionWithApiToken(cookieRequest))?.id, 'session-1');

    const tokenRequest = new Request('http://localhost/', {
      headers: { authorization: `Bearer ${created.token}` },
    });
    const viaToken = await service.resolveSessionWithApiToken(tokenRequest);
    assert.equal(viaToken?.id, created.id);
    assert.deepEqual(viaToken?.data, {
      user: { id: USER_ID, name: 'Ada', email: 'ada@example.com' },
      authMethod: 'api-token',
    });

    // Unknown or absent token: fail closed.
    assert.equal(
      await service.resolveSessionWithApiToken(
        new Request('http://localhost/', { headers: { authorization: 'Bearer nope' } }),
      ),
      null,
    );
    assert.equal(await service.resolveSessionWithApiToken(new Request('http://localhost/')), null);
  });

  it('resolves a token session without reading any secret', async () => {
    const store = createInMemoryTokenStore();
    const service = createApiTokenService({
      store,
      cookieSession: async () => null,
      headerName: 'x-api-token',
      expiresInDays: 30,
    });
    const created = await service.createApiToken(requestContext(cookieSession()), { name: 'ci' });
    const session = await service.resolveSessionWithApiToken(
      new Request('http://localhost/', { headers: { 'x-api-token': `Bearer ${created.token}` } }),
    );
    assert.equal(session?.id, created.id);
    assert.deepEqual(Object.keys(session ?? {}).sort(), ['data', 'expiresAt', 'id']);
  });
});
