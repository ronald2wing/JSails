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
import { describe, it, type TestContext } from 'node:test';

import { deferred } from 'jsails/testing';

import {
  attachDispose,
  AuthInstanceError,
  createAuth,
  disposeCachedAuth,
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
    const auth = createAuth(options) as DisposableAuth;
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

  it('refuses a DATABASE_TYPE the MySQL pool cannot serve', (t) => {
    withEnv(t, { ...DATABASE_ENV, DATABASE_TYPE: 'postgres' });
    assert.throws(
      () => createAuth({}),
      (error: unknown) =>
        error instanceof AuthInstanceError && error.code === 'unsupported_database',
    );
  });
});
