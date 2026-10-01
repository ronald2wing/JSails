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
import {
  cookieSession,
  createInMemoryTokenStore,
  deriveCsrf,
  requestContext,
  SECRET,
  USER_ID,
} from './fixtures.js';

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
      secret: SECRET,
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

  it('resolves a request cookie-first, then by token, failing closed', async () => {
    const store = createInMemoryTokenStore();
    const service = createService(store);
    const created = await service.createApiToken(requestContext(cookieSession()), { name: 'ci' });

    // Cookie wins even when a token is also present.
    const cookieRequest = new Request('http://localhost/', {
      headers: { cookie: 'session=abc', authorization: `Bearer ${created.token}` },
    });
    const viaCookie = await service.resolveSessionWithApiToken(cookieRequest);
    assert.equal(viaCookie?.id, 'session-1');

    // No cookie: the token resolves.
    const tokenRequest = new Request('http://localhost/', {
      headers: { authorization: `Bearer ${created.token}` },
    });
    const viaToken = await service.resolveSessionWithApiToken(tokenRequest);
    assert.equal(viaToken?.id, created.id);
    assert.equal(viaToken?.csrfToken, deriveCsrf(created.id));
    assert.deepEqual(viaToken?.data, {
      user: { id: USER_ID, name: 'Ada', email: 'ada@example.com' },
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
});
