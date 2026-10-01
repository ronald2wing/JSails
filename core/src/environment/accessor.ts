/**
 * The config accessor: how config code reads a variable, so that a command
 * that never uses secrets runs without them and one that does fails on the
 * exact missing name.
 *
 * ```js
 * import { env } from 'jsails';
 *
 * const password = env.require('DATABASE_PASSWORD');
 * const region = env.optional('S3_REGION') ?? 'eu-west-1';
 * ```
 *
 * Both read `process.env` when called, after the bin resolved and applied the
 * environment. `require` throws `environment.missing_variable` naming the
 * variable when it is unset or empty, except under a command that declared
 * its secrets unused and so skipped a sealed document (the resolution marker
 * records it): there the value cannot be known, nothing connects or serves
 * with it, and `require` returns an empty string. Code that writes a required
 * value into build output must not rely on it; a value a build needs belongs
 * in the real environment or a `.env` file, not the sealed credentials.
 */

import { EnvironmentErrors } from './errors.js';
import { isEnvKey, RESOLVED_MARKER_ENV } from './names.js';

/**
 * Reads environment variables for config code.
 *
 * @public
 */
export interface EnvAccessor {
  /**
   * The variable `name`. Throws `environment.missing_variable` when it is
   * unset or empty, unless the command skipped the sealed credentials.
   */
  require(name: string): string;
  /** The variable `name`, or `undefined` when it is unset or empty. */
  optional(name: string): string | undefined;
}

/** The marker's key-id field when the command skipped a sealed document. */
const SKIPPED_FIELD = ':skipped:';

function read(name: string): string | undefined {
  if (!isEnvKey(name)) throw new EnvironmentErrors.Error('invalid_variable_name');
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The config accessor over the resolved process environment.
 *
 * @public
 */
export const env: EnvAccessor = Object.freeze({
  require(name: string): string {
    const value = read(name);
    if (value !== undefined) return value;
    if (process.env[RESOLVED_MARKER_ENV]?.includes(SKIPPED_FIELD) === true) return '';
    throw new EnvironmentErrors.Error('missing_variable', { name });
  },
  optional(name: string): string | undefined {
    return read(name);
  },
});
