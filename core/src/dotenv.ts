/**
 * Process-environment assembly from developer-owned `.env` files.
 *
 * JSails follows the Node-ecosystem consensus for environment files (dotenv-flow,
 * Vite/Vitest, Next.js, Symfony, NestJS): a **cumulative merge** where `.env` is
 * always the base and the `NODE_ENV`-specific file layers on top, with a real
 * `process.env` variable always winning over every file. The developer owns
 * git-ignored `.env` files seeded from committed `.example` templates; this
 * module is the only place `.env` files are read. The validators
 * (`readEnvironment`, `readDatabaseEnvironment`) stay pure and read whatever
 * this bootstrap assembled.
 *
 * **Selection.** The signal is `NODE_ENV` (auto-set to `test` by `jsails test`,
 * matching Jest and Vitest):
 *
 * - `test` mode: load `.env`, then `.env.testing` (Laravel's name) — the test
 *   file overrides keys such as `DATABASE_NAME=*_test`. `.env.local` is skipped
 *   (determinism: dotenv-flow's rule that test results must not depend on a
 *   machine-local override).
 * - otherwise: load `.env`, `.env.local`, then `.env.${NODE_ENV}` — later wins.
 *
 * This is dotenv-flow's cumulative model with `.env.testing` as the test
 * override; the "tests never touch dev data" guarantee comes from
 * `.env.testing` overriding `DATABASE_NAME`, not from never loading `.env`.
 *
 * **Reserved keys.** `NODE_ENV` chooses which files load, so a file that sets
 * it would select credentials for one environment after the files of another
 * were already applied. `JSAILS_CREDENTIALS_KEY` (and the loaded marker) belong
 * to the credentials loader. A file that defines any of them is rejected with a
 * value-free {@link DotenvError}; they come from the real environment only.
 *
 * **Precedence.** A real `process.env` entry always wins. Uses Node's built-in
 * `util.parseEnv` parser rather than a hand-rolled one.
 *
 * **Credentials.** After the files, the environment's encrypted credentials
 * (`config/credentials/<NODE_ENV>.enc`, see `credentials.ts`) fill any key
 * still unset. They are the lowest layer: committed shared values that a real
 * variable or a developer's `.env` file overrides.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import {
  loadCredentials,
  reservedEnvironmentKey,
  type CredentialsLoadResult,
} from './credentials.js';
import { JsailsError } from './errors/jsails-error.js';

/** The base environment file, loaded in every mode. */
const DOTENV_BASE = '.env';
/** The developer-machine override of `.env`, skipped in test mode. */
const DOTENV_LOCAL = '.env.local';
/**
 * The test environment override: layered on `.env` under `NODE_ENV=test`. The
 * name follows Laravel's `.env.testing`; the semantics follow dotenv-flow
 * (`.env.${NODE_ENV}` with `NODE_ENV=test`).
 */
const DOTENV_TESTING = '.env.testing';

/** A `.env` file that cannot be applied. Value-free: names a file and a key, never a value. */
export class DotenvError extends JsailsError {
  readonly code = 'invalid_dotenv';
}

/** Options for {@link assembleEnvironment}. */
interface AssembleEnvironmentOptions {
  /** Project root; `.env` files resolve under it. Defaults to `process.cwd()`. */
  readonly rootDir?: string;
  /** The environment name, from `NODE_ENV`. */
  readonly nodeEnv?: string;
  /** The env map to assemble into (defaults to `process.env`); injectable for tests. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Whether to load encrypted credentials after the files. Defaults to `true`;
   * the `credentials` command turns it off so a broken file can still be fixed.
   */
  readonly credentials?: boolean;
}

/** Options for {@link dotenvFileNames} and {@link readDotenvFiles}. */
interface DotenvSelectionOptions {
  /**
   * Whether `.env.local` takes part outside test mode. Defaults to `true`;
   * sealing credentials turns it off so a machine-local override never becomes
   * a committed value.
   */
  readonly local?: boolean;
}

/**
 * The `.env` file names that apply to `nodeEnv`, in load order (a later file
 * wins). `test` loads `.env` and `.env.testing`; any other environment loads
 * `.env`, `.env.local` (unless `local` is `false`), then `.env.<nodeEnv>`.
 */
export function dotenvFileNames(
  nodeEnv: string | undefined,
  options: DotenvSelectionOptions = {},
): readonly string[] {
  if (nodeEnv === 'test') {
    return [DOTENV_BASE, DOTENV_TESTING];
  }
  const names = [DOTENV_BASE];
  if (options.local !== false) {
    names.push(DOTENV_LOCAL);
  }
  if (nodeEnv !== undefined && nodeEnv !== '') {
    names.push(`${DOTENV_BASE}.${nodeEnv}`);
  }
  return names;
}

/**
 * The merged values the `.env` files for `nodeEnv` define, a later file winning
 * over an earlier one. A missing file contributes nothing. The real
 * environment is not consulted. Throws {@link DotenvError} when a file defines
 * a reserved key.
 */
export function readDotenvFiles(
  rootDir: string,
  nodeEnv: string | undefined,
  options: DotenvSelectionOptions = {},
): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const name of dotenvFileNames(nodeEnv, options)) {
    const parsed = readDotenvFile(join(rootDir, name), name);
    if (parsed !== undefined) {
      Object.assign(merged, parsed);
    }
  }
  return merged;
}

/**
 * Assemble `process.env` from the developer's `.env` files, never overwriting a
 * real environment variable.
 *
 * - `test` mode: load `.env`, then `.env.testing` (if present); skip `.env.local`
 *   (determinism — the one `test`-specific rule dotenv-flow keeps: test results
 *   should not depend on a developer's machine-local overrides).
 * - otherwise: load `.env`, `.env.local` (if present), then `.env.${nodeEnv}`
 *   (if `nodeEnv` is set and the file is present).
 * - A missing file is a silent no-op, never an error; a file that defines a
 *   reserved key throws before anything is applied.
 * - Credentials then fill any key still unset; the result says what they did.
 */
export function assembleEnvironment(
  options: AssembleEnvironmentOptions = {},
): CredentialsLoadResult {
  const rootDir = options.rootDir ?? process.cwd();
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const env = options.env ?? process.env;

  for (const [key, value] of Object.entries(readDotenvFiles(rootDir, nodeEnv))) {
    // A key already present is a real environment variable, which a file
    // never overwrites.
    if (!(key in env)) {
      env[key] = value;
    }
  }
  if (options.credentials === false) {
    return { status: 'absent' };
  }
  return loadCredentials({ rootDir, env, ...(nodeEnv === undefined ? {} : { nodeEnv }) });
}

/** Parse one `.env` file, or `undefined` when it does not exist. */
function readDotenvFile(path: string, name: string): Readonly<Record<string, string>> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined; // a missing `.env` file is not an error.
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseEnv(raw))) {
    if (value !== undefined) values[key] = value;
  }
  const reserved = reservedEnvironmentKey(values);
  if (reserved !== undefined) {
    throw new DotenvError(`${name} defines ${reserved}, which only the real environment may set`, {
      suggestion: 'remove it from the file and set it in the shell or the process manager',
    });
  }
  return values;
}
