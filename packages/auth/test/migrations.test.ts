/**
 * Contract test for the auth migration disposal seam.
 *
 * `loadAuthMigrations()` builds Better Auth's migration plan on a fresh instance
 * the caller owns and hands back a plan whose `runMigrations()` runs against the
 * connection the plan was built from, plus the `dispose()` that releases it. It
 * never borrows the shared memoized instance, whose pool would keep a
 * short-lived caller (the `auth:migrate` script, a test file run in its own
 * process) alive after its work.
 *
 * On a server database `loadAuthMigrations()` introspects a live connection, so
 * that round-trip is exercised by the starter's live `auth:migrate` journey
 * (`npm run verify:starter`). A SQLite auth database needs no server, so the
 * plan-then-run round-trip is pinned here on a temp file, alongside the
 * disposal primitive the app-config shutdown seam uses, and the table names
 * the plugin declares to `db:push` are checked against what the plan creates.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { attachDispose, type Auth } from '../src/better-auth.js';
import { authTableNames } from '../src/auth-tables.js';
import { loadAuthMigrations } from '../src/migrations.js';

describe('auth migration disposal seam', () => {
  it('exposes an idempotent dispose a caller can invoke after running', async () => {
    // `disposeCachedAuth` (the app-config shutdown seam) goes through the
    // instance's own `dispose`; it must run its work exactly once even when
    // invoked repeatedly, so a double shutdown cannot destroy the pool twice.
    let released = 0;
    const auth = attachDispose({} as Auth, async () => {
      released += 1;
    });

    await Promise.all([auth.dispose(), auth.dispose()]);
    await auth.dispose();
    assert.equal(released, 1);
  });
});

describe('loadAuthMigrations on a SQLite auth database', () => {
  it('plans the enabled tables, applies them, and then has nothing left to do', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jsails-auth-migrate-'));
    // Each plan owns a node:sqlite handle on the file; close them before the
    // directory goes.
    const plans: { dispose(): Promise<void> }[] = [];
    t.after(async () => {
      await Promise.all(plans.map((plan) => plan.dispose()));
      await rm(dir, { recursive: true, force: true });
    });
    const options = {
      secret: 'a-test-secret-that-is-long-enough-for-better-auth',
      database: { type: 'sqlite', location: join(dir, 'auth.sqlite') },
      twoFactor: {},
    } as const;

    const plan = await loadAuthMigrations(options);
    plans.push(plan);
    const tables = plan.toBeCreated.map((table) => table.table).sort();
    for (const table of ['account', 'deviceCode', 'session', 'twoFactor', 'user', 'verification']) {
      assert.ok(tables.includes(table), `plan creates ${table}`);
    }
    await plan.runMigrations();

    const again = await loadAuthMigrations(options);
    plans.push(again);
    assert.deepEqual(again.toBeCreated, []);
    assert.deepEqual(again.toBeAdded, []);
  });

  it('releases the instance it built when the caller disposes the plan', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jsails-auth-migrate-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const plan = await loadAuthMigrations({
      secret: 'a-test-secret-that-is-long-enough-for-better-auth',
      database: { type: 'sqlite', location: join(dir, 'auth.sqlite') },
    });
    await plan.dispose();
    await plan.dispose();
    await assert.rejects(plan.runMigrations());
  });
});

describe('authTableNames', () => {
  // The names the plugin declares to db:push must be exactly what Better Auth's
  // migrator creates, or db:push would plan drops of the rest.
  for (const twoFactor of [undefined, false, {}] as const) {
    it(`matches the tables the migrator creates (twoFactor: ${JSON.stringify(twoFactor)})`, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'jsails-auth-tables-'));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const plan = await loadAuthMigrations({
        secret: 'a-test-secret-that-is-long-enough-for-better-auth',
        database: { type: 'sqlite', location: join(dir, 'auth.sqlite') },
        ...(twoFactor === undefined ? {} : { twoFactor }),
      });
      try {
        const created = plan.toBeCreated.map((table) => table.table).sort();
        assert.deepEqual([...authTableNames({ twoFactor })].sort(), created);
      } finally {
        await plan.dispose();
      }
    });
  }
});
