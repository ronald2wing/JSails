/**
 * Resolve a Jamal config's `env` map into its two delivery channels, as Kamal
 * splits env into `clear` and `secret` (`Kamal::Configuration::Env`):
 *
 * - **clear** values are passed on the `docker run` command line as `-e`.
 * - **secret** values are written to the release's secrets file on the host
 *   (`production/secrets-file.ts`), which the container mounts read-only, so
 *   they never appear in `ps` output or shell history.
 *
 * This module performs that split, resolves every secret name through
 * {@link JamalSecrets}, and encodes the secret channel as the secrets file's
 * bytes, so a value no process environment can receive stops the verb here,
 * before anything is built or sent. It returns data only: the caller decides
 * where the file lands and how the argv is executed.
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

import { SecretRef, type JamalConfig, type JamalEnvEntry } from './config/index.js';
import { encodeSecretsFile } from './production/secrets-file.js';
import { requireSecret, type JamalSecrets } from './secrets.js';

/** One resolved env entry: the container variable name and its value. */
export interface ResolvedEnvEntry {
  /** The variable name inside the container (the alias when one is set). */
  readonly name: string;
  /** The resolved value. Never logged by this module. */
  readonly value: string;
  /** Whether this entry is delivered through the secrets file rather than `-e`. */
  readonly secret: boolean;
}

/** The two delivery channels for a resolved env map. */
export interface ResolvedEnv {
  /** Entries passed as `-e NAME=VALUE`, sorted by name. */
  readonly clear: readonly ResolvedEnvEntry[];
  /** Entries written to the secrets file, sorted by name. */
  readonly secret: readonly ResolvedEnvEntry[];
  /** The secrets file holding {@link secret}, as the bytes written to the host. */
  readonly secretsFile: Uint8Array;
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

  clear.sort(byName);
  return withSecretChannel(clear, secretEntries);
}

/**
 * `env` with one more entry on the secret channel, for a value jamal itself
 * delivers rather than one `config.env` declares. The caller guarantees that
 * no entry already uses `name` (the config refuses the names jamal delivers).
 */
export function withSecretEntry(env: ResolvedEnv, name: string, value: string): ResolvedEnv {
  return withSecretChannel(env.clear, [...env.secret, { name, value, secret: true }]);
}

function byName(a: ResolvedEnvEntry, b: ResolvedEnvEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The env split with `secret` sorted by name and encoded as the secrets file. */
function withSecretChannel(
  clear: readonly ResolvedEnvEntry[],
  secret: readonly ResolvedEnvEntry[],
): ResolvedEnv {
  const sorted = [...secret].sort(byName);
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of sorted) values[entry.name] = entry.value;
  return { clear, secret: sorted, secretsFile: encodeSecretsFile(values) };
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
 * the secrets file.
 */
export function clearEnvFlags(env: ResolvedEnv): readonly string[] {
  return env.clear.flatMap((entry) => ['-e', `${entry.name}=${entry.value}`]);
}
