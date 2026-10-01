/**
 * The developer's `.env` files: which take part for an environment, and how
 * one is read.
 *
 * Only the `development` and `test` environments read files at all; any other
 * name (production, staging, ...) runs on the real environment, the secrets
 * file and its sealed credentials, so a stray `.env` copied into an image or
 * left on a server never decides a deployed value. For the two that read
 * them, `.env` is the base, `.env.<name>` (`.env.test` for test) layers above
 * it, and `.env.local`, the developer-machine override, applies to
 * `development` only and outranks the sealed credentials, so a test result
 * never depends on one machine's overrides.
 *
 * A file that does not exist contributes nothing; any other failure to read
 * one is fatal (`environment.unreadable_file`), since running with a file
 * silently skipped would pick values from the layer below. A file that
 * defines a reserved key is fatal too (`environment.reserved_key`). Node's
 * `util.parseEnv` is the parser.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { EnvironmentErrors } from './errors.js';
import { firstReservedKey } from './names.js';

/** The base `.env` file. */
export const DOTENV_BASE = '.env';
/** The developer-machine override, read in `development` only. */
export const DOTENV_LOCAL = '.env.local';

/** Whether an environment reads `.env` files at all. */
export function readsDotenvFiles(name: string): boolean {
  return name === 'development' || name === 'test';
}

/** The environment's own file: `.env.<name>`. */
export function environmentDotenvFile(name: string): string {
  return `${DOTENV_BASE}.${name}`;
}

/**
 * Parse the dotenv file `file` under `rootDir`, or `undefined` when it does
 * not exist. Throws `environment.unreadable_file` for any other read failure
 * and `environment.reserved_key` when it defines a reserved key.
 */
export function readDotenvFile(
  rootDir: string,
  file: string,
): Readonly<Record<string, string>> | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(rootDir, file), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new EnvironmentErrors.Error('unreadable_file', { file }, { cause: error });
  }
  return parseDotenv(raw, file);
}

/**
 * Parse dotenv text that came from `file` (a project-relative name used only
 * in errors). Throws `environment.reserved_key` when it defines a reserved key.
 */
export function parseDotenv(raw: string, file: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(parseEnv(raw))) {
    if (value !== undefined) values[key] = value;
  }
  const reserved = firstReservedKey(Object.keys(values));
  if (reserved !== undefined) {
    throw new EnvironmentErrors.Error('reserved_key', { file, key: reserved });
  }
  return Object.freeze(values);
}
