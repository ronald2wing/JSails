/**
 * `auth` plugin seam tests, without a database, Valkey, browser, or listener:
 *
 * - `resolveSessionFromRequest` maps a Better Auth session to the JSails
 *   `Session` shape (and `null` when unauthenticated), deriving the CSRF token
 *   from the signing secret when one is configured;
 * - `authPlugin` defers Better Auth construction, provides an
 *   `AuthSessionService` under `authSessionToken` to later extensions, releases
 *   the instance exactly once on close, fails closed when reset/verification
 *   are enabled without a mail seam, and mounts the registration route only
 *   when enabled.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { definePlugin } from 'jsails/extensions';
import type { Session } from 'jsails';
import { createTestApp } from 'jsails/testing';

import { authPlugin, authSessionToken, resolveSessionFromRequest } from '../src/index.js';
import { deriveCsrf, fakeAuth, ORIGIN, SECRET } from './fixtures.js';

const EXPIRY = new Date('2025-01-01T00:00:00.000Z');

/** A Better Auth stub for tests: no pool, no database, no network. */
const auth = fakeAuth(
  {
    getSession: async () => ({
      session: { id: 'session-1', expiresAt: EXPIRY },
      user: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
    }),
    signInEmail: async () => ({ headers: new Headers({ 'set-cookie': 'session=abc' }) }),
    signOut: async () => ({ headers: new Headers({ 'set-cookie': 'session=; Max-Age=0' }) }),
  },
  { handler: async () => new Response('ok') },
);

describe('resolveSessionFromRequest', () => {
  it('maps a Better Auth session to the JSails Session shape', async () => {
    const request = new Request(`${ORIGIN}/`, { headers: { cookie: 'session=abc' } });
    const session = await resolveSessionFromRequest(auth, request, SECRET);
    assert.ok(session);
    assert.equal(session.id, 'session-1');
    assert.equal(session.expiresAt, EXPIRY.getTime());
    assert.deepEqual(session.data, {
      user: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
    });
    assert.equal(session.csrfToken, deriveCsrf('session-1'));
  });

  it('derives a deterministic CSRF token without a secret', async () => {
    const request = new Request(`${ORIGIN}/`);
    const session = await resolveSessionFromRequest(auth, request, undefined);
    assert.equal(session?.csrfToken, 'csrf:session-1');
  });

  it('returns null for an unauthenticated request', async () => {
    const unauthenticated = fakeAuth({ getSession: async () => null });
    const request = new Request(`${ORIGIN}/`);
    assert.equal(await resolveSessionFromRequest(unauthenticated, request, undefined), null);
  });
});

describe('authPlugin', () => {
  it('defers Better Auth construction until first use (setup needs no database)', async () => {
    // No `createAuth` override and no database variables: assembly must not
    // build the instance (which would throw on the missing MariaDB env vars), so
    // `jsails build` / static export works without a database. Only a live
    // request or consumer that resolves a session forces construction.
    const app = await createTestApp({
      config: { port: 0, extensions: [authPlugin()] },
    });
    await app.close();
  });

  it('provides an auth session service under authSessionToken', async () => {
    const resolved: (Session | null)[] = [];
    const consumer = definePlugin({
      name: 'session-consumer',
      requires: [authSessionToken],
      setup({ services, configureHttp }) {
        const service = services.get(authSessionToken);
        configureHttp((app) => {
          app.get('/whoami', async (c) => {
            resolved.push(await service.resolveSession(c.req.raw));
            return c.text('ok');
          });
        });
      },
    });
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [authPlugin({ createAuth: () => auth }), consumer],
      },
    });

    assert.equal((await app.request('/whoami')).status, 200);
    assert.equal(resolved[0]?.id, 'session-1');

    await app.close();
  });

  it('mounts the login route and forwards the session cookie', async () => {
    const app = await createTestApp({
      config: { port: 0, extensions: [authPlugin({ createAuth: () => auth })] },
    });

    const response = await app.request('/api/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'a@b.co', password: 'pw' }).toString(),
      redirect: 'manual',
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/dashboard');
    assert.equal(response.headers.get('set-cookie'), 'session=abc');

    await app.close();
  });

  it('releases the auth instance pool exactly once on close', async () => {
    let disposed = 0;
    const disposable = fakeAuth(
      {},
      {
        handler: async () => new Response('ok'),
        dispose: async () => {
          disposed += 1;
        },
      },
    );

    const app = await createTestApp({
      config: { port: 0, extensions: [authPlugin({ createAuth: () => disposable })] },
    });

    // Force deferred construction through a mounted auth route.
    const response = await app.request('/api/auth/session');
    assert.equal(response.status, 200);
    assert.equal(disposed, 0);

    await app.close();
    assert.equal(disposed, 1);

    // A second close is idempotent: `Application.close` is single-shot, and the
    // instance's own dispose guard would also make a re-run a no-op.
    await app.close();
    assert.equal(disposed, 1);
  });

  it('does not throw on close when the auth instance lacks dispose', async () => {
    const app = await createTestApp({
      config: { port: 0, extensions: [authPlugin({ createAuth: () => auth })] },
    });

    // Force deferred construction; the stub has no `dispose`, so the plugin
    // cleanup must skip it rather than throw.
    const response = await app.request('/api/auth/session');
    assert.equal(response.status, 200);

    await app.close();
  });

  it('fails closed at construction when passwordReset is enabled without sendMail', () => {
    assert.throws(() => authPlugin({ passwordReset: { enabled: true } }), {
      name: 'TypeError',
      message: /sendMail/,
    });
  });

  it('fails closed at construction when verification is enabled without sendMail', () => {
    assert.throws(() => authPlugin({ verification: { enabled: true } }), /sendMail/);
  });

  it('accepts reset/verification when a sendMail callback is supplied', () => {
    assert.doesNotThrow(() =>
      authPlugin({
        sendMail: async () => {},
        passwordReset: { enabled: true },
        verification: { enabled: true },
      }),
    );
  });

  it('mounts POST /api/register when registration is enabled', async () => {
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [
          authPlugin({
            registration: { enabled: true },
            createAuth: () => fakeAuth({ signUpEmail: async () => ({ token: null, user: {} }) }),
          }),
        ],
      },
    });

    const response = await app.request('/api/register', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: 'Ada',
        email: 'ada@example.com',
        password: 'pw12345678',
      }).toString(),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    await app.close();
  });
});
