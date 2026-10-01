/**
 * Docker env-file encoding for resolved secrets.
 *
 * Mirrors Kamal's `Kamal::EnvFile` (`lib/kamal/env_file.rb`). A `secret` env
 * entry is never passed on the `docker run` command line — it is written to a
 * file on the host and read by the container, so the value never appears in
 * `ps` output or shell history.
 *
 * The escaping is a straight port of Kamal's algorithm: each ASCII run is
 * round-tripped through JSON string escaping (the equivalent of Ruby
 * `String#dump[1..-2]`), except that `\"` and `\#` are then unescaped, because
 * double quotes are treated literally in a Docker env file. Non-ASCII (UTF-8)
 * runs are passed through untouched. A value containing a newline or other
 * control character is escaped to its literal `\n`/`\uXXXX` form — never
 * rejected — so it cannot break the `KEY=VALUE` line or inject another entry.
 */

import { isForbiddenKey } from '../internal/json-safe.js';

/** Raised for an env-file entry with an unserializable key. */
export class JamalEnvFileError extends Error {
  readonly code: 'invalid_key';

  constructor(message: string) {
    super(message);
    this.name = 'JamalEnvFileError';
    this.code = 'invalid_key';
  }
}

/**
 * Encode `entries` as a Docker env file. Keys are emitted in the given order;
 * the caller sorts them for determinism.
 *
 * An empty map yields a single newline, matching Kamal's
 * `env_file.presence || "\n"` — an empty file makes sshkit warn.
 */
export function encodeEnvFile(entries: Readonly<Record<string, string>>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    assertEnvKey(key);
    lines.push(`${key}=${escapeDockerEnvFileValue(value)}`);
  }
  return lines.length === 0 ? '\n' : `${lines.join('\n')}\n`;
}

/** Reject a key that is not a valid environment variable name. */
function assertEnvKey(key: string): void {
  if (key.length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new JamalEnvFileError(
      'env-file keys must start with a letter or "_" and contain only letters, digits, and "_"',
    );
  }
  if (isForbiddenKey(key)) {
    throw new JamalEnvFileError('env-file keys must not use a reserved key');
  }
}

/**
 * Escape one value, preserving non-ASCII runs untouched — Kamal's
 * `escape_docker_env_file_value`, whose `value.scan(/[\x00-\x7F]+|[^\x00-\x7F]+/)`
 * becomes a global match here.
 */
function escapeDockerEnvFileValue(value: string): string {
  const parts = value.match(/[\x00-\x7F]+|[^\x00-\x7F]+/g) ?? [];
  return parts.map((part) => (/^[\x00-\x7F]+$/.test(part) ? escapeAscii(part) : part)).join('');
}

/**
 * Kamal's `escape_docker_env_file_ascii_value`: JSON escaping is the JS form of
 * Ruby `String#dump`, so dump, strip the surrounding quotes, then unescape the
 * two sequences Docker reads literally.
 */
function escapeAscii(value: string): string {
  return JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"').replace(/\\#/g, '#');
}
