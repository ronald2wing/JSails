/**
 * Docker env-file encoding for resolved secrets.
 *
 * A `secret` env entry is never passed on the `docker run` command line — it
 * is written to a file on the host and read by the container through
 * `--env-file`, so the value never appears in `ps` output or shell history.
 *
 * Docker's env-file parser has no escaping and no quoting: it splits each line
 * at the first `=` and hands everything after it to the container byte for
 * byte. So a value is written verbatim — a backslash, a quote, an `=` or a
 * `#` reaches the container unchanged — and a value that cannot survive that
 * format is refused rather than rewritten: a newline or carriage return would
 * end the line (and could inject another entry), a NUL cannot be carried in an
 * environment variable at all, and a lone UTF-16 surrogate cannot be written
 * as UTF-8. Docker also reads the file with a line scanner whose buffer is
 * 64 KiB, so a longer line fails `docker run` midway through a deploy; it is
 * refused up front too. The refusal names only the key.
 */

import { JsailsError } from 'jsails/support';
import { isForbiddenKey } from './object-shape.js';

/** Why an env-file entry was refused. */
export type JamalEnvFileErrorCode = 'invalid_key' | 'invalid_value' | 'too_large';

/** Raised for an env-file entry with an unserializable key or value. Value-free. */
export class JamalEnvFileError extends JsailsError {
  constructor(
    readonly code: JamalEnvFileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * What Docker's line-based env-file format cannot carry in a value. With the
 * `u` flag, `\p{Cs}` matches only an unpaired surrogate.
 */
const UNREPRESENTABLE_VALUE = /[\n\r\0\p{Cs}]/u;

/**
 * The longest `KEY=VALUE` line, in UTF-8 bytes, that Docker's env-file reader
 * accepts: its `bufio.Scanner` buffer is 64 KiB and must also hold the newline.
 */
export const MAX_ENV_FILE_LINE_BYTES: number = 64 * 1024 - 1;

/**
 * Encode `entries` as a Docker env file. Keys are emitted in the given order;
 * the caller sorts them for determinism.
 *
 * An empty map yields a single newline, so the written file is never empty.
 */
export function encodeEnvFile(entries: Readonly<Record<string, string>>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    assertEnvKey(key);
    assertEnvValue(key, value);
    const line = `${key}=${value}`;
    if (Buffer.byteLength(line, 'utf8') > MAX_ENV_FILE_LINE_BYTES) {
      throw new JamalEnvFileError(
        'too_large',
        `the entry for ${key} is longer than the ${MAX_ENV_FILE_LINE_BYTES} bytes a Docker env-file line can hold`,
      );
    }
    lines.push(line);
  }
  return lines.length === 0 ? '\n' : `${lines.join('\n')}\n`;
}

/** Reject a key that is not a valid environment variable name. */
function assertEnvKey(key: string): void {
  if (key.length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new JamalEnvFileError(
      'invalid_key',
      'env-file keys must start with a letter or "_" and contain only letters, digits, and "_"',
    );
  }
  if (isForbiddenKey(key)) {
    throw new JamalEnvFileError('invalid_key', 'env-file keys must not use a reserved key');
  }
}

/**
 * Reject a value Docker's env-file format cannot carry verbatim. The key has
 * already passed {@link assertEnvKey}, so naming it cannot echo arbitrary input.
 */
function assertEnvValue(key: string, value: string): void {
  if (UNREPRESENTABLE_VALUE.test(value)) {
    throw new JamalEnvFileError(
      'invalid_value',
      `the value of ${key} contains a newline, carriage return, NUL, or unpaired surrogate, ` +
        'which a Docker env file cannot carry',
    );
  }
}
