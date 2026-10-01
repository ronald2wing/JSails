/**
 * Resolve a Jamal config's `env` map into the two delivery channels Kamal uses.
 *
 * Kamal splits env into `clear` and `secret` (`Kamal::Configuration::Env`):
 *
 * - **clear** values are passed on the `docker run` command line as `-e`.
 * - **secret** values are written to an env file on the host and read by the
 *   container, so they never appear in `ps` output or shell history.
 *
 * This module performs that split and resolves every secret name through
 * {@link JamalSecrets}. It returns data only: the caller decides where the env
 * file lands and how the argv is executed.
 *
 * ## Which entries are secrets
 *
 * An entry is a secret when its value is a {@link SecretRef} and `clear` is not
 * `true`. A literal string is always clear. `clear: true` on a `SecretRef` entry
 * opts it into the command line — the escape hatch for a value that is not
 * actually sensitive (a hostname, a port).
 *
 * ## Aliasing
 *
 * `alias` renames the variable inside the container: `{ value: secret('DB_PASS'),
 * alias: 'DATABASE_PASSWORD' }` reads the secret `DB_PASS` and exports it as
 * `DATABASE_PASSWORD`. This mirrors Kamal's `KEY:ALIAS` form.
 */

import { SecretRef, type JamalConfig, type JamalEnvEntry } from './config.js';
import { encodeEnvFile } from './env-file.js';
import { requireSecret, type JamalSecrets } from './secrets.js';

/** One resolved env entry: the container variable name and its value. */
export interface ResolvedEnvEntry {
  /** The variable name inside the container (the alias when one is set). */
  readonly name: string;
  /** The resolved value. Never logged by this module. */
  readonly value: string;
  /** Whether this entry is delivered through the env file rather than `-e`. */
  readonly secret: boolean;
}

/** The two delivery channels for a resolved env map. */
export interface ResolvedEnv {
  /** Entries passed as `-e NAME=VALUE`, sorted by name. */
  readonly clear: readonly ResolvedEnvEntry[];
  /** Entries written to the env file, sorted by name. */
  readonly secret: readonly ResolvedEnvEntry[];
  /** The env-file contents for {@link secret}; a single newline when empty. */
  readonly envFile: string;
}

/**
 * Resolve `config.env` against `secrets`.
 *
 * Throws {@link JamalSecretsError} (`code: 'missing_secret'`) when a referenced
 * secret is not defined. The message names the secret, never a value.
 */
export function resolveJamalEnv(config: JamalConfig, secrets: JamalSecrets): ResolvedEnv {
  const clear: ResolvedEnvEntry[] = [];
  const secretEntries: ResolvedEnvEntry[] = [];

  for (const [key, entry] of Object.entries(config.env)) {
    const resolved = resolveEntry(key, entry, secrets);
    if (resolved.secret) {
      secretEntries.push(resolved);
    } else {
      clear.push(resolved);
    }
  }

  const byName = (a: ResolvedEnvEntry, b: ResolvedEnvEntry): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  clear.sort(byName);
  secretEntries.sort(byName);

  const envFile = encodeEnvFile(
    Object.fromEntries(secretEntries.map((entry) => [entry.name, entry.value])),
  );

  return { clear, secret: secretEntries, envFile };
}

/** Resolve one `config.env` entry into its container name, value, and channel. */
function resolveEntry(key: string, entry: JamalEnvEntry, secrets: JamalSecrets): ResolvedEnvEntry {
  const name = entry.alias ?? key;
  const isRef = entry.value instanceof SecretRef;
  const secret = isRef && !entry.clear;
  const value = isRef ? requireSecret(secrets, entry.value.name) : entry.value;
  return { name, value, secret };
}

/**
 * The `-e NAME=VALUE` flags for the clear channel. Kept separate from
 * {@link resolveJamalEnv} so a caller that only needs the argv never touches
 * the env-file string.
 */
export function clearEnvFlags(env: ResolvedEnv): readonly string[] {
  return env.clear.flatMap((entry) => ['-e', `${entry.name}=${entry.value}`]);
}
