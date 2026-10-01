/**
 * Encrypted credentials: a committed, per-environment secrets file that the
 * CLI bootstrap decrypts into `process.env`.
 *
 * `config/credentials/<environment>.enc` holds dotenv-format `KEY=value` lines
 * encrypted with AES-256-GCM. The file is committed; its key is not. The key
 * comes from the git-ignored `config/credentials/<environment>.key`, or, for
 * the environment the process runs as, from `JSAILS_CREDENTIALS_KEY`. Each
 * environment has its own key, so holding the development key reveals nothing
 * about production. The variable is scoped to the running environment because
 * a `.env` file loads in every mode: a development key set there must not be
 * tried, or used to create a file, for production or test. The
 * environment name is bound into the ciphertext as authenticated data, so a
 * file copied from one environment to another fails to decrypt rather than
 * loading the wrong secrets.
 *
 * Credentials are the lowest layer of the environment. A real environment
 * variable wins over every file, and a `.env` file wins over credentials, so
 * an operator or a developer's `.env.local` can always override a committed
 * value. App code never knows where a value came from; it reads
 * `process.env` through the same validators either way.
 *
 * The key is used once: the loader removes `JSAILS_CREDENTIALS_KEY` from the
 * environment when it finishes, so app code and child processes never see it.
 *
 * The feature is inert until a `.enc` file exists. Errors are value-free: a
 * message never contains a key, a ciphertext, or a decrypted value.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { AesEncrypter } from './encryption/encrypter.js';
import { EncryptionError } from './encryption/errors.js';
import { JsailsError, type JsailsErrorOptions } from './errors/jsails-error.js';

/** The directory, relative to the project root, that holds credentials files. */
export const CREDENTIALS_DIR = join('config', 'credentials');

/** The environment variable that supplies the key, ahead of the key file. */
export const CREDENTIALS_KEY_ENV = 'JSAILS_CREDENTIALS_KEY';

/**
 * Set to the environment name once its credentials are in the env map. A
 * child process inherits the decrypted values but not the key, so the marker
 * tells its bootstrap there is nothing left to load.
 */
export const CREDENTIALS_LOADED_ENV = 'JSAILS_CREDENTIALS_LOADED';

/** The environment a credentials lookup uses when `NODE_ENV` is unset. */
export const DEFAULT_CREDENTIALS_ENVIRONMENT = 'development';

/** A name that can safely become a file name: no separators, no dots. */
const ENVIRONMENT_NAME = /^[A-Za-z0-9_-]+$/;

/** Stable codes carried by a {@link CredentialsError}. */
export type CredentialsErrorCode =
  | 'invalid_environment'
  | 'missing_key'
  | 'invalid_key'
  | 'decryption_failed'
  | 'missing_order_file'
  | 'invalid_order_file';

/** A credentials failure. Value-free: no key, ciphertext, or plaintext. */
export class CredentialsError extends JsailsError {
  constructor(
    readonly code: CredentialsErrorCode,
    message: string,
    options?: JsailsErrorOptions,
  ) {
    super(message, options);
  }
}

/** Where one environment's credentials live. */
export interface CredentialsPaths {
  /** The committed, encrypted file. */
  readonly file: string;
  /** The git-ignored key file. */
  readonly keyFile: string;
}

/**
 * The credentials environment for a `NODE_ENV` value: the value itself, or
 * `development` when it is unset or empty. Throws `invalid_environment` for a
 * name that could not be a plain file name.
 */
export function credentialsEnvironment(nodeEnv: string | undefined): string {
  const name = nodeEnv === undefined || nodeEnv === '' ? DEFAULT_CREDENTIALS_ENVIRONMENT : nodeEnv;
  if (!ENVIRONMENT_NAME.test(name)) {
    throw new CredentialsError(
      'invalid_environment',
      'a credentials environment name may contain only letters, digits, "-", and "_"',
    );
  }
  return name;
}

/** The encrypted file and key file for `environment` under `rootDir`. */
export function credentialsPaths(rootDir: string, environment: string): CredentialsPaths {
  const dir = join(rootDir, CREDENTIALS_DIR);
  return { file: join(dir, `${environment}.enc`), keyFile: join(dir, `${environment}.key`) };
}

/**
 * The key for `environment`. `JSAILS_CREDENTIALS_KEY` from `env` counts only
 * when `environment` is `running`, the environment the process runs as; any
 * other environment reads its own key file. `undefined` when neither exists.
 */
export function resolveCredentialsKey(
  rootDir: string,
  environment: string,
  env: NodeJS.ProcessEnv,
  running: string | undefined,
): string | undefined {
  const fromEnv = env[CREDENTIALS_KEY_ENV];
  if (environment === running && fromEnv !== undefined && fromEnv !== '') {
    return fromEnv.trim();
  }
  const raw = readOptional(credentialsPaths(rootDir, environment).keyFile);
  const key = raw?.trim();
  return key === undefined || key === '' ? undefined : key;
}

/** The environment a `NODE_ENV` value runs as, or `undefined` for an unusable name. */
export function runningEnvironment(nodeEnv: string | undefined): string | undefined {
  try {
    return credentialsEnvironment(nodeEnv);
  } catch {
    return undefined;
  }
}

/** A fresh key: 32 random bytes, base64url-encoded. */
export function generateCredentialsKey(): string {
  return randomBytes(32).toString('base64url');
}

/** Encrypt dotenv-format `plaintext` for `environment`. */
export function encryptCredentials(plaintext: string, key: string, environment: string): string {
  return `${encrypter(key).encrypt(plaintext, { aad: aadFor(environment) })}\n`;
}

/**
 * Decrypt a credentials file's contents for `environment`. A wrong key, a
 * tampered file, or a file encrypted for another environment is
 * `decryption_failed`.
 */
export function decryptCredentials(contents: string, key: string, environment: string): string {
  try {
    return encrypter(key).decrypt(contents.trim(), { aad: aadFor(environment) });
  } catch (error) {
    if (error instanceof CredentialsError) throw error;
    throw new CredentialsError(
      'decryption_failed',
      'the credentials file could not be decrypted with this key for this environment',
      { suggestion: 'run "jsails credentials show" to inspect it' },
    );
  }
}

/** Parse decrypted credentials with the same rules as a `.env` file. */
export function parseCredentials(plaintext: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseEnv(plaintext))) {
    if (value !== undefined) values[name] = value;
  }
  return Object.freeze(values);
}

/** What {@link loadCredentials} found. */
export type CredentialsLoadResult =
  /** No credentials file for the environment; nothing was read. */
  | { readonly status: 'absent' }
  /** The file was decrypted; `applied` keys were set, the rest were already present. */
  | { readonly status: 'loaded'; readonly environment: string; readonly applied: number }
  /** A file exists but no key was found; nothing was set. */
  | { readonly status: 'missing_key'; readonly environment: string }
  /** A parent process already loaded this environment's credentials into the inherited env. */
  | { readonly status: 'inherited'; readonly environment: string };

/** Options for {@link loadCredentials}. */
export interface LoadCredentialsOptions {
  /** Project root. Defaults to `process.cwd()`. */
  readonly rootDir?: string;
  /** The environment name source. Defaults to `env.NODE_ENV`. */
  readonly nodeEnv?: string;
  /** The env map to fill. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Decrypt the current environment's credentials into `env`, setting only keys
 * that are not already present, so real variables and `.env` files win.
 *
 * A missing file, or a `NODE_ENV` that is not a valid environment name, is
 * `absent`: there is nothing to load. A file without a key is `missing_key`,
 * reported rather than thrown so commands that do not need the secrets still
 * run. A file that does not decrypt throws, because starting with secrets
 * silently missing is worse than not starting.
 *
 * Whatever the outcome, `JSAILS_CREDENTIALS_KEY` is removed from `env` before
 * this returns or throws. Once the values are in place the key has no further
 * use, and leaving it would hand it to app code, dependencies that log the
 * environment, and every child process. A child inherits the decrypted values
 * instead, and {@link CREDENTIALS_LOADED_ENV} tells it so.
 */
export function loadCredentials(options: LoadCredentialsOptions = {}): CredentialsLoadResult {
  const env = options.env ?? process.env;
  try {
    return loadInto(options.rootDir ?? process.cwd(), env, options.nodeEnv ?? env.NODE_ENV);
  } finally {
    delete env[CREDENTIALS_KEY_ENV];
  }
}

function loadInto(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  nodeEnv: string | undefined,
): CredentialsLoadResult {
  const environment = runningEnvironment(nodeEnv);
  if (environment === undefined) {
    return { status: 'absent' };
  }
  if (env[CREDENTIALS_LOADED_ENV] === environment) {
    return { status: 'inherited', environment };
  }
  const contents = readOptional(credentialsPaths(rootDir, environment).file);
  if (contents === undefined) {
    return { status: 'absent' };
  }
  const key = resolveCredentialsKey(rootDir, environment, env, environment);
  if (key === undefined) {
    return { status: 'missing_key', environment };
  }
  const values = parseCredentials(decryptCredentials(contents, key, environment));
  let applied = 0;
  for (const [name, value] of Object.entries(values)) {
    if (!(name in env)) {
      env[name] = value;
      applied += 1;
    }
  }
  env[CREDENTIALS_LOADED_ENV] = environment;
  return { status: 'loaded', environment, applied };
}

function aadFor(environment: string): string {
  return `jsails-credentials:${environment}`;
}

function encrypter(key: string): AesEncrypter {
  try {
    return new AesEncrypter({ key });
  } catch (error) {
    if (error instanceof EncryptionError) {
      throw new CredentialsError('invalid_key', 'the credentials key must be at least 32 bytes');
    }
    throw error;
  }
}

/** A file's contents, or `undefined` when it does not exist. Any other failure throws. */
function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
