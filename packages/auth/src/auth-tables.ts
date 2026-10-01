/**
 * The names of the tables Better Auth's migrator owns.
 *
 * The `auth` plugin declares them as `schema.unmanagedTables`, so `db:push` and
 * `db:diff` plan nothing for them when they share the app database: their
 * columns, types, and indexes stay with `auth:migrate` (`loadAuthMigrations`).
 * An app whose explicit auth `database` config points at the app database
 * re-exports them as `unmanagedTables` from `jsails.database.js` instead.
 */

import { pluginToggle, type AuthBuildOptions } from './better-auth.js';

/** Core Better Auth plus device authorization, mounted in every configuration. */
const BASE_AUTH_TABLES = Object.freeze([
  'user',
  'session',
  'account',
  'verification',
  'deviceCode',
]);

/**
 * The tables Better Auth's migrator creates for these options: the base set,
 * plus `twoFactor` whenever `twoFactor` is an options object, because that is
 * when `createAuth` mounts the two-factor plugin. Magic links, social providers,
 * and the `role` column add no table.
 */
export function authTableNames(
  options: Pick<AuthBuildOptions, 'twoFactor'> = {},
): readonly string[] {
  return Object.freeze(
    pluginToggle(options.twoFactor, 'twoFactor') !== undefined
      ? [...BASE_AUTH_TABLES, 'twoFactor']
      : [...BASE_AUTH_TABLES],
  );
}
