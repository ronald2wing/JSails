/**
 * Disposal tests for the Better Auth instance seam.
 *
 * These prove that a Better Auth instance releases its Kysely connection pool
 * exactly once, without a database, by driving the extracted {@link attachDispose}
 * helper directly with a fake `destroy` function. The live-DB path — building a
 * real memoized instance through {@link createAuth} and disposing it — is not
 * exercised here because Better Auth's runtime schema check introspects the
 * database at construction time (opening a real connection); see the note on the
 * memo-clear test below.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { getMigrations } from 'better-auth/db/migration';
import { deferred } from 'jsails/testing';

import {
  attachDispose,
  AuthInstanceError,
  authPoolSizing,
  createAuth,
  DEFAULT_POOL_CONNECTION_LIMIT,
  DEFAULT_POOL_QUEUE_LIMIT,
  disposeCachedAuth,
  findUserByEmail,
  setUserRole,
  type Auth,
  type DisposableAuth,
} from '../src/better-auth.js';

const DATABASE_ENV = {
  DATABASE_HOST: '127.0.0.1',
  DATABASE_USER: 'auth',
  DATABASE_PASSWORD: 'unused',
  DATABASE_NAME: 'auth',
  DATABASE_PORT: '1',
  BETTER_AUTH_SECRET: 'a-test-secret-that-is-long-enough-for-better-auth',
} as const;

/** Set environment variables for one test and restore them afterwards. */
function withEnv(t: TestContext, values: Readonly<Record<string, string | undefined>>): void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

describe('attachDispose', () => {
  it('attaches a non-enumerable dispose method', () => {
    const auth = attachDispose({} as Auth, async () => {});
    assert.equal(typeof auth.dispose, 'function');
    assert.equal(Object.prototype.propertyIsEnumerable.call(auth, 'dispose'), false);
  });

  it('runs the underlying destroy exactly once on the first dispose', async () => {
    let calls = 0;
    const auth = attachDispose({} as Auth, async () => {
      calls += 1;
    });

    await auth.dispose();
    assert.equal(calls, 1);
  });

  it('does not re-run destroy on a second dispose', async () => {
    let calls = 0;
    const auth = attachDispose({} as Auth, async () => {
      calls += 1;
    });

    await auth.dispose();
    await auth.dispose();
    assert.equal(calls, 1);
  });

  it('shares one destroy across concurrent dispose calls', async () => {
    let calls = 0;
    const gate = deferred();
    const auth = attachDispose({} as Auth, async () => {
      calls += 1;
      await gate.promise;
    });

    const first = auth.dispose();
    const second = auth.dispose();
    gate.resolve();
    await Promise.all([first, second]);

    assert.equal(calls, 1);
  });

  it('surfaces a value-free AuthInstanceError when destroy rejects', async () => {
    const auth = attachDispose({} as Auth, async () => {
      throw new Error('root:secret@db.internal:3306/auth');
    });

    await assert.rejects(auth.dispose(), (error: unknown) => {
      assert.ok(error instanceof AuthInstanceError);
      assert.equal(error.code, 'dispose_failed');
      assert.equal(error.message, 'failed to release the auth database connection pool');
      // The message is fixed and never echoes the DSN, host, user, or password.
      assert.ok(!error.message.includes('root'));
      assert.ok(!error.message.includes('secret'));
      assert.ok(!error.message.includes('db.internal'));
      assert.ok(!error.message.includes('3306'));
      return true;
    });
  });

  it('clears the memo once after a successful dispose', async () => {
    let cleared = 0;
    const auth = attachDispose(
      {} as Auth,
      async () => {},
      () => {
        cleared += 1;
      },
    );

    await auth.dispose();
    assert.equal(cleared, 1);

    // Idempotent: the second dispose shares the first call's promise and does
    // not run the memo clear a second time.
    await auth.dispose();
    assert.equal(cleared, 1);
  });

  it('does not clear the memo when dispose fails', async () => {
    let cleared = 0;
    const auth = attachDispose(
      {} as Auth,
      async () => {
        throw new Error('boom');
      },
      () => {
        cleared += 1;
      },
    );

    await assert.rejects(auth.dispose(), AuthInstanceError);
    assert.equal(cleared, 0);
  });
});

describe('disposeCachedAuth', () => {
  it('is a no-op when the memoized instance was never built', async () => {
    // No `createAuth()` call runs in this suite, so the module memo is empty;
    // disposing must neither throw nor open a connection.
    await assert.doesNotReject(disposeCachedAuth());
  });

  // NOTE (live-DB gap): the full "dispose then `createAuth()` returns a NEW
  // object" contract is not asserted here because building a real memoized
  // instance requires Better Auth to introspect MariaDB at construction (its
  // runtime schema check), which needs a live connection. The memo-clear wiring
  // is the `clearMemo` callback (`cachedAuth = undefined`), and its
  // exactly-once invocation is covered by the `attachDispose` memo tests above;
  // the end-to-end disposal is covered by the `auth` plugin's close test and the
  // starter's live `auth:migrate` journey.
});

describe('createAuth construction policy', () => {
  // A mysql2 pool connects lazily and runtime schema validation is off, so an
  // instance can be built and inspected without a database.
  function build(t: TestContext, options: Parameters<typeof createAuth>[0] = {}): DisposableAuth {
    withEnv(t, { ...DATABASE_ENV, DATABASE_TYPE: undefined });
    const auth = createAuth(options);
    t.after(() => auth.dispose());
    return auth;
  }

  it('disables sign-up and revokes every session on password reset by default', (t) => {
    const policy = build(t).options.emailAndPassword;
    assert.equal(policy?.enabled, true);
    assert.equal(policy?.disableSignUp, true);
    assert.equal(policy?.revokeSessionsOnPasswordReset, true);
  });

  it('applies an explicit policy at construction', (t) => {
    const policy = build(t, {
      emailAndPassword: { disableSignUp: false, autoSignIn: false },
    }).options.emailAndPassword;
    assert.equal(policy?.disableSignUp, false);
    assert.equal(policy?.autoSignIn, false);
    assert.equal(policy?.revokeSessionsOnPasswordReset, true);
  });

  it('adds a user role column that no endpoint input can set', (t) => {
    const role = build(t).options.user?.additionalFields?.role;
    assert.equal(role?.type, 'string');
    assert.equal(role?.input, false);
    assert.equal(build(t, { roles: false }).options.user?.additionalFields?.role, undefined);
  });

  it('enables the signed session cookie cache only when asked', (t) => {
    assert.equal(build(t).options.session?.cookieCache, undefined);
    assert.deepEqual(build(t, { cookieCache: { maxAge: 60 } }).options.session?.cookieCache, {
      enabled: true,
      maxAge: 60,
    });
    assert.throws(() => createAuth({ cookieCache: { maxAge: 0 } }), TypeError);
  });

  it('bounds the connection pool and its wait queue by default', () => {
    assert.deepEqual(authPoolSizing(), {
      connectionLimit: DEFAULT_POOL_CONNECTION_LIMIT,
      queueLimit: DEFAULT_POOL_QUEUE_LIMIT,
    });
    assert.deepEqual(authPoolSizing({ connectionLimit: 4 }), {
      connectionLimit: 4,
      queueLimit: DEFAULT_POOL_QUEUE_LIMIT,
    });
    assert.deepEqual(authPoolSizing({ connectionLimit: 20, queueLimit: 50 }), {
      connectionLimit: 20,
      queueLimit: 50,
    });
  });

  it('refuses pool sizes mysql2 would read as unlimited or invalid', (t) => {
    withEnv(t, { ...DATABASE_ENV, DATABASE_TYPE: undefined });
    for (const pool of [
      { connectionLimit: 0 },
      { queueLimit: 0 },
      { queueLimit: -1 },
      { connectionLimit: 1.5 },
      { connectionLimit: Number.NaN },
    ]) {
      assert.throws(() => createAuth({ pool }), {
        name: 'TypeError',
        message: /^pool\.(connectionLimit|queueLimit) must be a positive integer$/,
      });
    }
  });

  it('mounts two-factor and magic-link only for an options object', (t) => {
    const ids = (auth: DisposableAuth): string[] =>
      (auth.options.plugins ?? []).map((plugin) => plugin.id);
    const off = ids(build(t, { twoFactor: false, magicLink: false }));
    assert.equal(off.includes('two-factor'), false);
    assert.equal(off.includes('magic-link'), false);
    const on = ids(build(t, { twoFactor: {}, magicLink: {} }));
    assert.ok(on.includes('two-factor'));
    assert.ok(on.includes('magic-link'));
    assert.throws(() => createAuth({ magicLink: true as never }), TypeError);
  });

  it('reads the client address from the X-Forwarded-For core canonicalized', (t) => {
    assert.deepEqual(build(t).options.advanced?.ipAddress, {
      ipAddressHeaders: ['x-forwarded-for'],
      ipv6Subnet: 64,
    });
  });

  it('closes user creation while sign-up is disabled, even an explicit undefined', (t) => {
    assert.equal(typeof build(t).options.databaseHooks?.user?.create?.before, 'function');
    const undefinedPolicy = build(t, { emailAndPassword: { disableSignUp: undefined } });
    assert.equal(undefinedPolicy.options.emailAndPassword?.disableSignUp, true);
    assert.equal(
      build(t, { emailAndPassword: { disableSignUp: false } }).options.databaseHooks,
      undefined,
    );
  });

  it('builds a postgres instance when DATABASE_TYPE is postgres', async (t) => {
    withEnv(t, { ...DATABASE_ENV, DATABASE_TYPE: 'postgres' });
    const auth = createAuth({});
    await auth.dispose();
  });

  it('refuses a DATABASE_TYPE no auth dialect serves', (t) => {
    withEnv(t, { ...DATABASE_ENV, DATABASE_TYPE: 'oracle' });
    assert.throws(
      () => createAuth({}),
      (error: unknown) =>
        error instanceof AuthInstanceError && error.code === 'unsupported_database',
    );
  });

  it('prefers an explicit database over the environment', async (t) => {
    withEnv(t, { ...DATABASE_ENV, DATABASE_TYPE: 'oracle' });
    const auth = createAuth({
      database: { type: 'sqlite', location: ':memory:' },
    });
    await auth.dispose();
  });
});

describe('user lookups on a SQLite auth database', () => {
  /** A migrated auth database in a temp file, with sign-up open for the test. */
  async function migratedAuth(t: TestContext): Promise<DisposableAuth> {
    withEnv(t, { BETTER_AUTH_SECRET: DATABASE_ENV.BETTER_AUTH_SECRET });
    const dir = await mkdtemp(join(tmpdir(), 'jsails-auth-'));
    const auth = createAuth({
      database: { type: 'sqlite', location: join(dir, 'auth.sqlite') },
      emailAndPassword: { disableSignUp: false, autoSignIn: false },
    });
    t.after(async () => {
      await auth.dispose();
      await rm(dir, { recursive: true, force: true });
    });
    await (await getMigrations(auth.options)).runMigrations();
    await auth.api.signUpEmail({
      body: { name: 'Ada', email: 'ada@example.com', password: 'correct-horse-battery' },
    });
    return auth;
  }

  it('finds a user case-insensitively and returns null for an unknown email', async (t) => {
    const auth = await migratedAuth(t);
    const user = await findUserByEmail(auth, '  ADA@Example.com ');
    assert.equal(user?.email, 'ada@example.com');
    assert.equal(user?.name, 'Ada');
    assert.equal(await findUserByEmail(auth, 'nobody@example.com'), null);
    await assert.rejects(findUserByEmail(auth, '  '), TypeError);
  });

  it('assigns and clears a role that findUserByEmail then reports', async (t) => {
    const auth = await migratedAuth(t);
    assert.equal(await setUserRole(auth, 'ada@example.com', ' admin '), true);
    assert.equal((await findUserByEmail(auth, 'ada@example.com'))?.role, 'admin');
    assert.equal(await setUserRole(auth, 'ada@example.com', null), true);
    assert.equal((await findUserByEmail(auth, 'ada@example.com'))?.role, null);
    assert.equal(await setUserRole(auth, 'nobody@example.com', 'admin'), false);
  });
});

describe('closed registration on a SQLite auth database', () => {
  /** A migrated magic-link instance; returns it with the links it sent. */
  async function magicLinkAuth(
    t: TestContext,
    disableSignUp: boolean,
  ): Promise<{ auth: DisposableAuth; links: string[] }> {
    withEnv(t, { BETTER_AUTH_SECRET: DATABASE_ENV.BETTER_AUTH_SECRET });
    const dir = await mkdtemp(join(tmpdir(), 'jsails-auth-closed-'));
    const links: string[] = [];
    const auth = createAuth({
      database: { type: 'sqlite', location: join(dir, 'auth.sqlite') },
      magicLink: {},
      sendMagicLink: ({ url }) => {
        links.push(url);
      },
      emailAndPassword: { disableSignUp, autoSignIn: false },
    });
    t.after(async () => {
      await auth.dispose();
      await rm(dir, { recursive: true, force: true });
    });
    await (await getMigrations(auth.options)).runMigrations();
    return { auth, links };
  }

  /** Request a magic link for `email` and follow it. */
  async function followMagicLink(
    auth: DisposableAuth,
    links: string[],
    email: string,
  ): Promise<void> {
    const origin = 'http://localhost:3000';
    await auth.handler(
      new Request(`${origin}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ email }),
      }),
    );
    const link = links.at(-1);
    assert.ok(link !== undefined, 'a magic link was sent');
    await auth.handler(new Request(link));
  }

  it('lets a magic link sign in no unknown address while sign-up is closed', async (t) => {
    const { auth, links } = await magicLinkAuth(t, true);
    await followMagicLink(auth, links, 'stranger@example.com');
    assert.equal(await findUserByEmail(auth, 'stranger@example.com'), null);
  });

  it('lets a magic link create the account once sign-up is open', async (t) => {
    const { auth, links } = await magicLinkAuth(t, false);
    await followMagicLink(auth, links, 'newcomer@example.com');
    assert.equal(
      (await findUserByEmail(auth, 'newcomer@example.com'))?.email,
      'newcomer@example.com',
    );
  });
});

describe('better-auth dependency', () => {
  it('is pinned to the exact version the endpoint table and redaction were verified against', async () => {
    // The throttled-path table, the hidden session endpoints, and the token
    // redaction name Better Auth routes and response shapes; a minor release
    // that adds or renames one must be reviewed, not picked up by a range.
    const manifestUrl = new URL('../../package.json', import.meta.url);
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const declared = manifest.dependencies['better-auth'];
    assert.match(declared ?? '', /^\d+\.\d+\.\d+$/);
    const installedPath = findPackageJSON('better-auth', import.meta.url);
    assert.ok(installedPath !== undefined);
    const installed = JSON.parse(await readFile(installedPath, 'utf8')) as { version: string };
    assert.equal(installed.version, declared);
  });
});
