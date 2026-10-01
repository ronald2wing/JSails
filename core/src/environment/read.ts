/**
 * Bounded application configuration read from a plain string source.
 *
 * This helper turns a `Record<string, string | undefined>` (by default
 * `process.env`) into typed configuration. It is deliberately narrow:
 *
 * - It never loads a `.env` file and never mutates the source or `process.env`.
 *   (Resolving the environment from its layers is the bin's job, in
 *   `resolve.ts`; this module only reads.)
 * - The default source (`process.env`) is resolved when a reader is *invoked*,
 *   not at import time, so importing this module opens no connections and
 *   reads no environment variables.
 * - Errors are `environment.invalid_variable` (or `invalid_environment` when
 *   no variable can be named) carrying structured `{ path, code }` issues in
 *   their payload and value-free messages. Custom Zod messages/inputs and thrown
 *   transform/refine errors may embed credentials, so raw Zod text is never
 *   surfaced and `.cause` is never populated.
 *
 * Optional services are opt-in: `readDatabaseEnvironment` and
 * `readValkeyEnvironment` fail when their variables are absent rather than
 * inventing a connection, so a static app that never calls them needs no
 * database or Valkey at all.
 */

import type { z } from 'zod';

import { isIdentifier } from '../errors/context-schema.js';
import { mapZodIssues } from '../validation/zod-issues.js';
import { resolveRuntimeValkeyUrl } from '../jobs/runtime-config.js';
import { EnvironmentErrors, type EnvironmentIssue } from './errors.js';

/** `DATABASE_TYPE` environment variable name. */
export const DATABASE_TYPE_ENV = 'DATABASE_TYPE';
/** `DATABASE_HOST` environment variable name. */
export const DATABASE_HOST_ENV = 'DATABASE_HOST';
/** `DATABASE_PORT` environment variable name. */
export const DATABASE_PORT_ENV = 'DATABASE_PORT';
/** `DATABASE_NAME` environment variable name. */
export const DATABASE_NAME_ENV = 'DATABASE_NAME';
/** `DATABASE_USER` environment variable name. */
export const DATABASE_USER_ENV = 'DATABASE_USER';
/** `DATABASE_PASSWORD` environment variable name. */
export const DATABASE_PASSWORD_ENV = 'DATABASE_PASSWORD';
/** Valkey URL environment variable name. */
export const VALKEY_URL_ENV = 'VALKEY_URL';

/** SQL drivers accepted by the bounded database reader. */
export type DatabaseType = 'mariadb' | 'postgres' | 'mysql';

/**
 * The error for `issues`: `environment.invalid_variable` naming the first
 * issue's variable, or `environment.invalid_environment` when that issue has
 * no variable a message may name. Either way the payload carries every issue.
 */
function environmentError(issues: readonly EnvironmentIssue[]): Error {
  const first = issues[0];
  const variable = first?.path[0];
  const problem = isIdentifier(first?.code) ? first.code : 'invalid';
  const payload = { issues: Object.freeze([...issues]) };
  if (typeof variable === 'string' && isIdentifier(variable)) {
    return new EnvironmentErrors.Error(
      'invalid_variable',
      { name: variable, problem, count: issues.length },
      { payload },
    );
  }
  return new EnvironmentErrors.Error(
    'invalid_environment',
    { problem, count: issues.length },
    { payload },
  );
}

function issueError(path: readonly (string | number)[], code: string, message: string): Error {
  return environmentError([{ path, code, message }]);
}

/**
 * Translate Zod issues into value-free `EnvironmentIssue`s via the canonical
 * mapper. The mapper expands an unrecognized-keys failure into one entry per
 * key with the key in its path; environment variable names are
 * caller-controlled and may themselves be secrets (e.g. `SECRET_KEY`), so
 * those entries are collapsed back into a single root entry that keeps the
 * failure code without naming the key.
 */
function mapEnvironmentIssues(error: z.ZodError): EnvironmentIssue[] {
  const mapped = mapZodIssues(error);
  if (mapped.some((entry) => entry.code === 'unknown_field')) {
    const others = mapped.filter((entry) => entry.code !== 'unknown_field');
    return [...others, { path: [], code: 'unknown_field', message: 'unknown field' }];
  }
  return mapped;
}

/**
 * Validate the source against a Zod schema. Unknown keys are stripped unless
 * the schema opts into `.strict()`; the source object is never mutated.
 *
 * Transform/refine functions may throw arbitrary errors (including ones that
 * embed secrets), so any thrown value is replaced by a generic
 * `environment.invalid_environment` error with no `.cause`.
 */
export function readEnvironment<T>(
  schema: z.ZodType<T>,
  source: Record<string, string | undefined> = process.env,
): T {
  try {
    // A shallow copy keeps a mutating preprocess/transform from touching the
    // caller's object (and `process.env`). Values are strings, so no nested
    // object survives the copy and the guard stays cheap.
    const result = schema.safeParse({ ...source });
    if (result.success) {
      return result.data;
    }
    throw environmentError(mapEnvironmentIssues(result.error));
  } catch (error) {
    // A ZodError was already mapped above; anything else is a thrown
    // transform/refine error whose text may embed credentials.
    if (EnvironmentErrors.is(error)) {
      throw error;
    }
    throw issueError([], 'invalid', 'environment validation failed');
  }
}

/** The typed database configuration produced by `readDatabaseEnvironment`. */
export interface DatabaseEnvironment {
  readonly type: DatabaseType;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

/** The typed Valkey configuration produced by `readValkeyEnvironment`. */
export interface ValkeyEnvironment {
  /** A validated `redis://` or `rediss://` URL. */
  readonly valkeyUrl: string;
}

const DATABASE_TYPES: readonly DatabaseType[] = ['mariadb', 'postgres', 'mysql'];
const DRIVER_DEFAULT_PORT: Readonly<Record<DatabaseType, number>> = {
  mariadb: 3306,
  mysql: 3306,
  postgres: 5432,
};
const MAX_PORT = 65535;
/** Canonical decimal only: no sign, decimal point, exponent, hex, or spaces. */
const PORT_PATTERN = /^[0-9]+$/;

function requireValue(source: Record<string, string | undefined>, name: string): string {
  const value = source[name];
  if (value === undefined || value === '') {
    throw issueError([name], 'required', 'is required and must not be empty');
  }
  return value;
}

function readDatabaseType(source: Record<string, string | undefined>): DatabaseType {
  const raw = source[DATABASE_TYPE_ENV];
  if (raw === undefined) {
    return 'mariadb';
  }
  if ((DATABASE_TYPES as readonly string[]).includes(raw)) {
    return raw as DatabaseType;
  }
  // The offending value is intentionally not echoed: it is application input.
  throw issueError([DATABASE_TYPE_ENV], 'invalid_type', 'must be one of mariadb, postgres, mysql');
}

function readDatabasePort(source: Record<string, string | undefined>, type: DatabaseType): number {
  const raw = source[DATABASE_PORT_ENV];
  if (raw === undefined) {
    return DRIVER_DEFAULT_PORT[type];
  }
  if (!PORT_PATTERN.test(raw)) {
    throw issueError([DATABASE_PORT_ENV], 'invalid_format', 'must be a canonical decimal integer');
  }
  const port = Number(raw);
  if (port <= 0 || port > MAX_PORT) {
    throw issueError([DATABASE_PORT_ENV], 'out_of_range', `must be between 1 and ${MAX_PORT}`);
  }
  return port;
}

/**
 * Read the database connection settings from the source. The driver defaults
 * to MariaDB and the port defaults per driver (3306 for mariadb/mysql, 5432
 * for postgres). Host, user, password, and database name are required when
 * this reader is invoked: there is no implicit database for static apps.
 *
 * The password is returned exactly as provided (never trimmed or normalized);
 * database and user names are ordinary strings with no identifier
 * restrictions. No value is ever interpolated into a connection URL.
 */
export function readDatabaseEnvironment(
  source: Record<string, string | undefined> = process.env,
): DatabaseEnvironment {
  const type = readDatabaseType(source);
  return {
    type,
    host: requireValue(source, DATABASE_HOST_ENV),
    port: readDatabasePort(source, type),
    username: requireValue(source, DATABASE_USER_ENV),
    password: requireValue(source, DATABASE_PASSWORD_ENV),
    database: requireValue(source, DATABASE_NAME_ENV),
  };
}

/**
 * Resolve the Valkey connection URL from the source using the existing
 * runtime resolver: `VALKEY_URL` is read. The resolved URL is validated but
 * never echoed. An explicit `source` is the only place consulted;
 * `process.env` is never used as a fallback.
 */
export function readValkeyEnvironment(
  source: Record<string, string | undefined> = process.env,
): ValkeyEnvironment {
  try {
    return { valkeyUrl: resolveRuntimeValkeyUrl({}, source) };
  } catch {
    throw issueError(
      [VALKEY_URL_ENV],
      'invalid_value',
      `expected a redis:// or rediss:// URL in ${VALKEY_URL_ENV}`,
    );
  }
}
