/**
 * Better Auth schema migrations for the `auth` plugin.
 *
 * `loadAuthMigrations()` builds a Better Auth instance of its own and the
 * migration plan for it through Better Auth's own `getMigrations`; the plan
 * carries the `dispose()` that releases that instance. Importing this module performs no environment reads and no
 * database work: the instance (and any connection it opens) is resolved only
 * when the function is called.
 *
 * This is the single seam the starter's `auth:migrate` script and auth test
 * suite use. They must not import the `better-auth/db/migration` subpath
 * directly: that resolution depends on npm hoisting a transitive framework
 * dependency into the app's own `node_modules`, which is not guaranteed.
 *
 * Better Auth's migrator stays the source of truth for the auth tables on
 * every dialect; they are not declared to `db:push` as plugin schema entities.
 * The migrator derives column types and indexes per dialect and per enabled
 * feature (two-factor, magic link, the `role` column), and a hand-kept copy as
 * TypeORM entities would drift from it and turn every difference into a
 * destructive `db:push` plan. The plugin declares only the table names
 * (`authTableNames` in `auth-tables.ts`) as `schema.unmanagedTables`, so `db:push` leaves
 * them alone when they share the app database.
 */

import { getMigrations } from 'better-auth/db/migration';

import { createAuth, type AuthBuildOptions } from './better-auth.js';

/**
 * A migration plan: what Better Auth's `getMigrations` returns (the tables to
 * create or alter, the indexes to add, the warnings `schemaProblems` and
 * `unsafeChanges`, and a `runMigrations()` runner), plus `dispose()`, which
 * releases the connection pool or SQLite handle of the instance the plan was
 * built on. `dispose()` is idempotent.
 */
export type AuthMigrations = Awaited<ReturnType<typeof getMigrations>> & {
  readonly dispose: () => Promise<void>;
};

/**
 * Build the migration plan on a fresh auth instance that the caller owns.
 *
 * The plan never borrows the shared memoized instance: a pool that belongs to
 * the process would keep a short-lived caller (the `auth:migrate` script, a
 * test file that `node --test` runs in its own process) alive after its work,
 * and the caller could not release it without also tearing down the instance
 * the plugin serves requests with. Call `dispose()` once the plan has run or
 * been discarded, normally in a `finally`.
 *
 * `options` must match the plugin's configuration when the app enables
 * `twoFactor`/`socialProviders` or sets `database`, so the plan covers the same
 * tables on the same database; without options the plan uses the same
 * environment defaults as the plugin.
 *
 * The plan's `runMigrations()` executes against the connection the plan was
 * built from, so that connection is never released before it runs.
 *
 * Failures are value-free: a missing connection variable is reported by name
 * only (see {@link createAuth}), and a malformed plan surfaces Better Auth's own
 * error without echoing credentials.
 */
export async function loadAuthMigrations(options: AuthBuildOptions = {}): Promise<AuthMigrations> {
  const auth = createAuth(options);
  try {
    const plan = await getMigrations(auth.options);
    return { ...plan, dispose: () => auth.dispose() };
  } catch (error) {
    await auth.dispose();
    throw error;
  }
}
