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

import {
  adminOnly,
  authPlugin,
  authSessionToken,
  AuthInstanceError,
  resolveSessionFromRequest,
  sessionRole,
} from '../src/index.js';
import { deriveCsrf, fakeAuth, ORIGIN, requestContext, SECRET } from './fixtures.js';

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
      authMethod: 'cookie',
    });
    assert.equal(session.csrfToken, deriveCsrf('session-1'));
  });

  it('projects the assigned role so adminOnly can allow the session', async () => {
    const withRole = fakeAuth({
      getSession: async () => ({
        session: { id: 'session-1', token: 'tok', expiresAt: EXPIRY },
        user: { id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'admin' },
      }),
    });
    const session = await resolveSessionFromRequest(withRole, new Request(`${ORIGIN}/`), SECRET);
    assert.equal(session?.data.role, 'admin');
    assert.equal(adminOnly(session), true);
    assert.equal(sessionRole({ ...requestContext(session) }), 'admin');
  });

  it('resolves a bearer credential without sliding its expiry and marks it', async () => {
    const calls: unknown[] = [];
    const recording = fakeAuth({
      getSession: async (input: unknown) => {
        calls.push(input);
        return {
          session: { id: 'session-9', token: 'raw-token', expiresAt: EXPIRY, userAgent: null },
          user: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
        };
      },
    });
    const bearer = new Request(`${ORIGIN}/`, { headers: { authorization: 'Bearer raw-token' } });
    const session = await resolveSessionFromRequest(recording, bearer, SECRET);
    assert.equal(session?.data.authMethod, 'bearer');
    assert.deepEqual((calls[0] as { query?: unknown }).query, { disableRefresh: true });

    await resolveSessionFromRequest(recording, new Request(`${ORIGIN}/`), SECRET);
    assert.equal((calls[1] as { query?: unknown }).query, undefined, 'cookies keep sliding');
  });

  it('marks an API-token session reached through the bearer header', async () => {
    const tokenAuth = fakeAuth({
      getSession: async () => ({
        session: {
          id: 'tok-1',
          token: 'secret-1',
          expiresAt: EXPIRY,
          userAgent: 'jsails/api-token:ci',
        },
        user: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
      }),
    });
    const request = new Request(`${ORIGIN}/`, { headers: { authorization: 'Bearer secret-1' } });
    const session = await resolveSessionFromRequest(tokenAuth, request, SECRET);
    assert.equal(session?.data.authMethod, 'api-token');
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

/** A form POST to the test app. */
function formInit(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  };
}

describe('authPlugin hardening', () => {
  it('throttles POST /api/login by default, keyed on the normalized email', async () => {
    let attempts = 0;
    const counting = fakeAuth({
      signInEmail: async () => {
        attempts += 1;
        throw new Error('bad password');
      },
    });
    const app = await createTestApp({
      config: { port: 0, extensions: [authPlugin({ createAuth: () => counting })] },
    });

    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      // Case and whitespace variants of one address share one bucket.
      const email = i % 2 === 0 ? 'Victim@Example.com' : ' victim@example.COM ';
      statuses.push((await app.request('/api/login', formInit({ email, password: 'x' }))).status);
    }
    assert.deepEqual(
      statuses.slice(0, 10),
      Array.from({ length: 10 }, () => 303),
    );
    assert.deepEqual(statuses.slice(10), [429, 429]);
    assert.equal(attempts, 10);
    await app.close();
  });

  it('throttles POST /api/login per client address across many emails', async () => {
    let attempts = 0;
    const counting = fakeAuth({
      signInEmail: async () => {
        attempts += 1;
        throw new Error('bad password');
      },
    });
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [
          authPlugin({ createAuth: () => counting, clientAddress: () => '203.0.113.7' }),
        ],
      },
    });

    const statuses: number[] = [];
    for (let i = 0; i < 102; i += 1) {
      const email = `spray${i}@example.com`;
      statuses.push((await app.request('/api/login', formInit({ email, password: 'x' }))).status);
    }
    assert.ok(statuses.slice(0, 100).every((status) => status === 303));
    assert.deepEqual(statuses.slice(100), [429, 429]);
    assert.equal(attempts, 100);
    await app.close();
  });

  it('turns login throttling off only when told to', async () => {
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [authPlugin({ createAuth: () => auth, login: { rateLimit: false } })],
      },
    });
    for (let i = 0; i < 12; i += 1) {
      const response = await app.request(
        '/api/login',
        formInit({ email: 'a@b.co', password: 'x' }),
      );
      assert.equal(response.status, 303);
    }
    await app.close();
  });

  it('throttles the Better Auth sign-in twin with the login limiter', async () => {
    let reached = 0;
    const router = fakeAuth(
      {},
      {
        handler: async () => {
          reached += 1;
          return new Response('{}', { status: 401 });
        },
      },
    );
    const denied: string[] = [];
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [
          authPlugin({
            createAuth: () => router,
            login: {
              rateLimit: (email, attempt) => {
                denied.push(`${attempt.route}:${email}`);
                return false;
              },
            },
          }),
        ],
      },
    });

    const response = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'Ada@Example.com', password: 'x' }),
    });
    assert.equal(response.status, 429);
    assert.equal(reached, 0);
    assert.deepEqual(denied, ['login:ada@example.com']);
    await app.close();
  });

  it('never lets a bearer token reach the Better Auth router', async () => {
    const seen: (string | null)[] = [];
    const router = fakeAuth(
      {},
      {
        handler: async (request: Request) => {
          seen.push(request.headers.get('authorization'));
          return new Response('ok');
        },
      },
    );
    const app = await createTestApp({
      config: { port: 0, extensions: [authPlugin({ createAuth: () => router })] },
    });

    const response = await app.request('/api/auth/revoke-other-sessions', {
      method: 'POST',
      headers: { authorization: 'Bearer leaked-api-token', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [null]);
    await app.close();
  });

  it('approves a device code only with the browser session, never a bearer token', async () => {
    const forwarded: (string | null)[] = [];
    const device = fakeAuth({
      deviceApprove: async (input: { headers: Headers }) => {
        forwarded.push(new Headers(input.headers).get('authorization'));
        return { success: true };
      },
    });
    const app = await createTestApp({
      config: { port: 0, extensions: [authPlugin({ createAuth: () => device })] },
    });
    const init = formInit({ user_code: 'ABCD', action: 'approve' });
    const response = await app.request('/api/device/approve', {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: 'Bearer t' },
    });
    assert.equal(response.status, 303);
    assert.deepEqual(forwarded, [null]);
    await app.close();
  });

  it('resolves the session once per request for every consumer', async () => {
    let lookups = 0;
    const counting = fakeAuth({
      getSession: async () => {
        lookups += 1;
        return {
          session: { id: 'session-1', expiresAt: EXPIRY },
          user: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
        };
      },
    });
    const consumer = definePlugin({
      name: 'double-consumer',
      requires: [authSessionToken],
      setup({ services, configureHttp }) {
        const service = services.get(authSessionToken);
        configureHttp((app) => {
          app.get('/twice', async (c) => {
            await service.resolveSession(c.req.raw);
            await service.resolveSession(c.req.raw);
            return c.text('ok');
          });
        });
      },
    });
    const app = await createTestApp({
      config: { port: 0, extensions: [authPlugin({ createAuth: () => counting }), consumer] },
    });
    assert.equal((await app.request('/twice')).status, 200);
    assert.equal(lookups, 1);
    await app.close();
  });

  it('refuses an injected instance whose sign-up is open while registration is off', async () => {
    /** The error code `getAuth()` throws for an injected instance, or `ok`. */
    async function probe(injected: ReturnType<typeof fakeAuth>): Promise<string> {
      let outcome = 'ok';
      const consumer = definePlugin({
        name: 'auth-probe',
        requires: [authSessionToken],
        setup({ services, configureHttp }) {
          const service = services.get(authSessionToken);
          configureHttp((app) => {
            app.get('/probe', (c) => {
              try {
                service.getAuth();
              } catch (error) {
                outcome = error instanceof AuthInstanceError ? error.code : 'other';
              }
              return c.text('done');
            });
          });
        },
      });
      const app = await createTestApp({
        config: { port: 0, extensions: [authPlugin({ createAuth: () => injected }), consumer] },
      });
      await app.request('/probe');
      await app.close();
      return outcome;
    }

    const open = fakeAuth({}, { options: { emailAndPassword: { enabled: true } } });
    assert.equal(await probe(open), 'unsafe_instance');

    const locked = fakeAuth(
      {},
      {
        options: {
          emailAndPassword: {
            enabled: true,
            disableSignUp: true,
            revokeSessionsOnPasswordReset: true,
          },
        },
      },
    );
    assert.equal(await probe(locked), 'ok');
  });
});
