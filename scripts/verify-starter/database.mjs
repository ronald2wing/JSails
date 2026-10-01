/**
 * The live MariaDB the auth stages need, and the account they sign in with.
 *
 * `process.env` is assembled from the framework repo's `.env` (developer-owned,
 * seeded from `.env.example`) through the compiled `dotenv` module, so the
 * verifier talks to the same jamal-provisioned services the app does, with a
 * real environment variable still winning over the file. A clean checkout has
 * no `core/dist` until the `build-root` stage creates it, so the assembly is
 * skipped when the module is absent.
 *
 * Starter auth is lazy: importing the app config performs no database work, so
 * build, static export, and the native suite run without a database. Only
 * `auth:migrate`, `user:create`, and the auth browser journey need a live
 * MariaDB; when its connection variables are unset those stages are recorded
 * as explicit skips, never silently passed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from '../workspaces.mjs';

const dotenvModule = join(repoRoot, 'core', 'dist', 'src', 'dotenv.js');
if (existsSync(dotenvModule)) {
  const { assembleEnvironment } = await import('../../core/dist/src/dotenv.js');
  assembleEnvironment();
}

const REQUIRED_VARIABLES = ['DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_USER'];

/** The connection variables absent from the environment (an empty value counts as absent). */
export const missingDatabaseVariables = REQUIRED_VARIABLES.filter((name) => {
  const value = process.env[name];
  return value === undefined || value === '';
});

/** Whether every connection variable is present, so the auth stages may run. */
export const hasDatabase = missingDatabaseVariables.length === 0;

/** The skip detail recorded verbatim for every stage that needs the database. */
export const DATABASE_SKIP_REASON = 'requires MariaDB (DATABASE_HOST)';

/**
 * The Better Auth signing secret for the fixture. A caller-supplied
 * `BETTER_AUTH_SECRET` is honored; otherwise a fixed value of at least 32
 * bytes keeps the migrate/create/serve/browser chain consistent within a run.
 */
export const BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET ?? 'jsails-verify-starter-secret-0123456789abcdef';

/**
 * The account the auth browser journey signs in with. A unique email per run
 * avoids colliding with an account a previous run created; caller-supplied
 * `AUTH_TEST_EMAIL`/`AUTH_TEST_PASSWORD` target an existing account instead.
 */
export const AUTH_TEST_EMAIL =
  process.env.AUTH_TEST_EMAIL ?? `verify-${Date.now().toString(36)}@example.com`;
export const AUTH_TEST_PASSWORD = process.env.AUTH_TEST_PASSWORD ?? 'verify-starter-password';
