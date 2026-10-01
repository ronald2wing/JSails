/**
 * Known holes in the auth surface, each stated as the safe behaviour against a
 * real assembled app: `authPlugin` building its own Better Auth instance on a
 * migrated SQLite file, served through `createTestApp`. No stub stands in for
 * Better Auth, so the response shapes, the hooks, and the OAuth callback are
 * the library's own; only the OAuth provider's token endpoint is answered
 * in-process, because the test opens no network connection.
 *
 * A case that fails today is listed in `scripts/expected-failures/security.json`
 * with the work package that closes it. A case that already holds stays here
 * as an ordinary regression test.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, type TestContext } from 'node:test';

import type { ServerOriginConfig } from 'jsails';
import { definePlugin } from 'jsails/extensions';
import { createTestApp, type TestApplication } from 'jsails/testing';

import {
  authPlugin,
  authSessionToken,
  loadAuthMigrations,
  type AuthPluginOptions,
  type AuthSessionService,
  type RateLimitAttempt,
} from '../src/index.js';

const SECRET = 'a-test-secret-that-is-long-enough-for-better-auth';
const ORIGIN = 'http://localhost';
const SESSION_COOKIE = 'better-auth.session_token';
const PASSWORD = 'correct-horse-battery-staple';

/** A running app plus the SQLite file its auth tables live in. */
interface AuthHarness {
  readonly app: TestApplication;
  readonly auth: () => AuthSessionService;
  /** Rows in the auth `user` table right now. */
  userCount(): number;
  /** The client address Better Auth recorded on each session row, oldest first. */
  sessionAddresses(): (string | null)[];
}

/**
 * Migrate a fresh SQLite auth database (every optional table, so each case can
 * turn features on) and assemble an app with `authPlugin(options)` on it.
 */
async function startAuth(
  t: TestContext,
  options: AuthPluginOptions = {},
  server: ServerOriginConfig = {},
): Promise<AuthHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'jsails-auth-holes-'));
  const location = join(dir, 'auth.sqlite');
  const plan = await loadAuthMigrations({
    secret: SECRET,
    database: { type: 'sqlite', location },
    twoFactor: {},
    magicLink: {},
  });
  try {
    await plan.runMigrations();
  } finally {
    await plan.dispose();
  }
  let service: AuthSessionService | undefined;
  const probe = definePlugin({
    name: 'auth-holes-probe',
    requires: [authSessionToken],
    setup({ services }) {
      service = services.get(authSessionToken);
    },
  });
  const app = await createTestApp({
    origin: ORIGIN,
    config: {
      port: 0,
      server,
      extensions: [
        authPlugin({
          secret: SECRET,
          baseUrl: ORIGIN,
          database: { type: 'sqlite', location },
          ...options,
        }),
        probe,
      ],
    },
  });
  const reader = new DatabaseSync(location, { readOnly: true });
  t.after(async () => {
    reader.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    app,
    auth: () => {
      assert.ok(service !== undefined, 'the auth service was provided');
      return service;
    },
    userCount: () => {
      const row = reader.prepare('SELECT count(*) AS n FROM user').get() as { n: number };
      return Number(row.n);
    },
    sessionAddresses: () =>
      (
        reader.prepare('SELECT ipAddress FROM session ORDER BY createdAt').all() as {
          ipAddress: string | null;
        }[]
      ).map((row) => row.ipAddress),
  };
}

/** A same-origin JSON POST to a Better Auth router endpoint. */
function postJson(
  app: TestApplication,
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return app.request(`/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

/** Every `name=value` pair the response sets, joined for a `Cookie` header. */
function cookiesOf(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return jar;
}

function cookieHeader(jar: ReadonlyMap<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** The raw session token a session cookie carries (`<token>.<signature>`). */
function sessionTokenOf(jar: ReadonlyMap<string, string>): string {
  const value = jar.get(SESSION_COOKIE);
  assert.ok(value !== undefined && value !== '', 'a session cookie was set');
  const token = decodeURIComponent(value).split('.')[0] ?? '';
  assert.ok(token.length >= 16, 'the session cookie carries a token');
  return token;
}

/** Assert neither the body nor a script-readable header carries any of `tokens`. */
async function assertNoToken(
  response: Response,
  tokens: readonly string[],
  label: string,
): Promise<void> {
  const body = await response.clone().text();
  for (const token of tokens) {
    assert.equal(body.includes(token), false, `${label}: the body carries a session token`);
  }
  for (const [name, value] of response.headers) {
    if (name === 'set-cookie') continue;
    for (const token of tokens) {
      assert.equal(value.includes(token), false, `${label}: header ${name} carries a token`);
    }
  }
}

describe('known holes: optional sign-in methods stay off when configured false', () => {
  it('answers 404 for the magic-link and two-factor endpoints', async (t) => {
    const { app } = await startAuth(t, { magicLink: false, twoFactor: false });
    const magic = await postJson(app, '/sign-in/magic-link', { email: 'ada@example.com' });
    assert.equal(magic.status, 404);
    const enable = await postJson(app, '/two-factor/enable', { password: PASSWORD });
    assert.equal(enable.status, 404);

    // The twin with both turned on mounts the endpoints, so the 404s above are
    // the toggles' doing.
    const on = await startAuth(t, { magicLink: {}, twoFactor: {}, sendMagicLink: () => {} });
    const mounted = await postJson(on.app, '/sign-in/magic-link', { email: 'ada@example.com' });
    assert.notEqual(mounted.status, 404);
    const unauthenticated = await postJson(on.app, '/two-factor/enable', { password: PASSWORD });
    assert.notEqual(unauthenticated.status, 404);
  });
});

/** Request a magic link for `email` and follow it, as the recipient would. */
async function followMagicLink(
  harness: AuthHarness,
  links: readonly string[],
  email: string,
): Promise<void> {
  await postJson(harness.app, '/sign-in/magic-link', { email });
  const link = links.at(-1);
  if (link !== undefined) {
    const url = new URL(link);
    await harness.app.request(`${url.pathname}${url.search}`);
  }
}

/** A GitHub provider whose profile lookup is answered in-process. */
const GITHUB: NonNullable<AuthPluginOptions['socialProviders']> = {
  github: {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    getUserInfo: async () => ({
      user: { name: 'Stranger', email: 'oauth-stranger@example.com', emailVerified: true },
      data: { id: 4242, login: 'stranger', email: 'oauth-stranger@example.com' } as never,
    }),
  },
};

/**
 * Run Better Auth's real OAuth flow for an account it has never seen: start
 * the sign-in, then hit the callback with the issued state. The provider's
 * token endpoint is answered in-process; nothing else is.
 */
async function oauthSignIn(t: TestContext, harness: AuthHarness): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return Response.json({ access_token: 'gho_test', token_type: 'bearer', scope: '' });
    }
    return realFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const start = await postJson(harness.app, '/sign-in/social', {
    provider: 'github',
    callbackURL: '/',
  });
  assert.equal(start.status, 200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get('state');
  assert.ok(state !== null, 'the authorization URL carries a state');
  await harness.app.request(
    `/api/auth/callback/github?code=code-1&state=${encodeURIComponent(state)}`,
    { headers: { cookie: cookieHeader(cookiesOf(start)) } },
  );
}

describe('known holes: closed registration closes every creation path', () => {
  // Each closed case has an open twin, so a refusal cannot pass by accident
  // (a flow that fails before it reaches user creation).
  it('creates no user through email sign-up', async (t) => {
    const harness = await startAuth(t);
    const body = { name: 'Mallory', email: 'mallory@example.com', password: PASSWORD };
    await postJson(harness.app, '/sign-up/email', body);
    assert.equal(harness.userCount(), 0);

    const open = await startAuth(t, { registration: { enabled: true } });
    await postJson(open.app, '/sign-up/email', body);
    assert.equal(open.userCount(), 1, 'with registration open the same request creates a user');
  });

  it('creates no user through a magic link for an unknown address', async (t) => {
    const links: string[] = [];
    const options: AuthPluginOptions = {
      magicLink: {},
      sendMagicLink: ({ url }) => {
        links.push(url);
      },
    };
    const harness = await startAuth(t, options);
    await followMagicLink(harness, links, 'stranger@example.com');
    assert.equal(harness.userCount(), 0);

    const open = await startAuth(t, { ...options, registration: { enabled: true } });
    await followMagicLink(open, links, 'stranger@example.com');
    assert.equal(open.userCount(), 1, 'with registration open the same link creates a user');
  });

  it('creates no user through an OAuth callback for an unknown account', async (t) => {
    const harness = await startAuth(t, { socialProviders: GITHUB });
    await oauthSignIn(t, harness);
    assert.equal(harness.userCount(), 0);

    const open = await startAuth(t, { socialProviders: GITHUB, registration: { enabled: true } });
    await oauthSignIn(t, open);
    assert.equal(open.userCount(), 1, 'with registration open the same callback creates a user');
  });
});

describe('known holes: no router response hands page script a session token', () => {
  it('keeps the session token out of every response a signed-in browser reads', async (t) => {
    const { app } = await startAuth(t, {
      registration: { enabled: true },
      login: { rateLimit: false },
    });
    const signUp = await postJson(app, '/sign-up/email', {
      name: 'Ada',
      email: 'ada@example.com',
      password: PASSWORD,
    });
    assert.equal(signUp.status, 200);
    const signIn = await postJson(app, '/sign-in/email', {
      email: 'ada@example.com',
      password: PASSWORD,
    });
    assert.equal(signIn.status, 200);
    const jar = cookiesOf(signIn);
    const tokens = [sessionTokenOf(jar)];
    await assertNoToken(signIn, tokens, 'sign-in/email');

    const cookie = { cookie: cookieHeader(jar) };
    const session = await app.request('/api/auth/get-session', { headers: cookie });
    assert.equal(session.status, 200);
    await assertNoToken(session, tokens, 'get-session');

    const updated = await postJson(app, '/update-user', { name: 'Ada L.' }, cookie);
    assert.equal(updated.status, 200);
    await assertNoToken(updated, tokens, 'update-user');

    // Revoking the other sessions issues a new session token in the response.
    const changed = await postJson(
      app,
      '/change-password',
      { currentPassword: PASSWORD, newPassword: `${PASSWORD}-2`, revokeOtherSessions: true },
      cookie,
    );
    assert.equal(changed.status, 200);
    const rotated = cookiesOf(changed);
    const all = rotated.has(SESSION_COOKIE) ? [...tokens, sessionTokenOf(rotated)] : tokens;
    await assertNoToken(changed, all, 'change-password');

    const accounts = await app.request('/api/auth/list-accounts', {
      headers: { cookie: cookieHeader(rotated.has(SESSION_COOKIE) ? rotated : jar) },
    });
    await assertNoToken(accounts, all, 'list-accounts');
  });
});

describe('known holes: the credential limiter cannot be dodged', () => {
  it('charges the login limit for a body sent with a crafted Content-Type', async (t) => {
    const attempts: string[] = [];
    const { app } = await startAuth(t, {
      login: {
        rateLimit: (email) => {
          attempts.push(email ?? '-');
          return true;
        },
      },
    });
    await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; boundary=multipart/form-data',
        origin: ORIGIN,
      },
      body: JSON.stringify({ email: 'Ada@Example.com', password: 'wrong' }),
    });
    await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: ORIGIN },
      body: 'garbage',
    });
    assert.deepEqual(attempts, ['ada@example.com', '-']);
  });

  it('keys the limiter on the address a trusted proxy saw, never on a spoofed header', async (t) => {
    const seen: (string | null)[] = [];
    const record = (_email: string | null, attempt: RateLimitAttempt): boolean => {
      seen.push(attempt.ip);
      return true;
    };
    const direct = await startAuth(t, { login: { rateLimit: record } });
    for (const spoofed of ['203.0.113.1', '203.0.113.2']) {
      await direct.app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': spoofed },
        body: JSON.stringify({ email: 'ada@example.com', password: 'wrong' }),
      });
    }
    // Without a trusted proxy the header is ignored: both attempts share one key.
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1]);

    seen.length = 0;
    const proxied = await startAuth(
      t,
      { login: { rateLimit: record } },
      { trustedProxies: { hops: 1 } },
    );
    for (const client of ['198.51.100.1', '198.51.100.2']) {
      await proxied.app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'x-forwarded-for': `6.6.6.6, ${client}`,
        },
        body: JSON.stringify({ email: 'ada@example.com', password: 'wrong' }),
      });
    }
    // Behind one proxy each client gets its own key, the entry the proxy wrote.
    assert.deepEqual(seen, ['198.51.100.1', '198.51.100.2']);
  });

  it('lets Better Auth record only the client core resolved, never a header the client wrote', async (t) => {
    const signUpAndIn = async (harness: AuthHarness, forwardedFor: string): Promise<void> => {
      const spoof = { 'x-forwarded-for': forwardedFor, 'x-real-ip': '6.6.6.6' };
      const signUp = await postJson(harness.app, '/sign-up/email', {
        name: 'Ada',
        email: 'ada@example.com',
        password: PASSWORD,
      });
      assert.equal(signUp.status, 200);
      const signIn = await postJson(
        harness.app,
        '/sign-in/email',
        { email: 'ada@example.com', password: PASSWORD },
        spoof,
      );
      assert.equal(signIn.status, 200);
    };
    const options: AuthPluginOptions = {
      registration: { enabled: true },
      login: { rateLimit: false },
    };

    // With no trusted proxy the forwarded headers are dropped before Better Auth
    // reads them, so a forged address never lands on the session row.
    const direct = await startAuth(t, options);
    await signUpAndIn(direct, '6.6.6.6');
    assert.ok(direct.sessionAddresses().length > 0, 'the sign-in opened a session');
    assert.equal(direct.sessionAddresses().includes('6.6.6.6'), false);

    // Behind one proxy, Better Auth sees exactly the entry that proxy wrote,
    // whatever the client prepended.
    const proxied = await startAuth(t, options, { trustedProxies: { hops: 1 } });
    await signUpAndIn(proxied, '6.6.6.6, 198.51.100.9');
    assert.equal(proxied.sessionAddresses().at(-1), '198.51.100.9');
    assert.equal(proxied.sessionAddresses().includes('6.6.6.6'), false);
  });
});
