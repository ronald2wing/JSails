/**
 * The secrets file: the layer a deploy mounts into the app container, named
 * by `JSAILS_SECRETS_FILE`, format v1:
 *
 * ```json
 * { "v": 1, "values": { "NAME": "value" } }
 * ```
 *
 * Values are JSON strings, so any byte sequence but NUL travels unescaped and
 * unmangled (a PEM block, quotes, `$`, non-ASCII). When the variable is set
 * the file must be there and well formed: a missing or unreadable file is
 * fatal rather than skipped, and the resolved environment records that the
 * file was consumed and how many values it held, which a deploy's post-start
 * check asserts. The path itself never appears in an error.
 *
 * The file stands in for the real environment of a deployed container, so it
 * may carry the one control variable a deploy has to deliver:
 * `JSAILS_CREDENTIALS_KEY`, the key ring that opens the sealed credentials
 * built into the image. It is lifted out of the values (it never becomes a
 * resolved variable, and it is not counted) and opens the document when the
 * real environment holds no ring. Every other reserved key is refused, since
 * each decides which layers apply or how a failure is reported.
 */

import { readFileSync } from 'node:fs';

import { EnvironmentErrors } from './errors.js';
import { CREDENTIALS_KEY_ENV, firstReservedKey, isEnvKey } from './names.js';

/** The format version this module reads. */
export const SECRETS_FILE_VERSION = 1;

/** A validated secrets file. */
export interface SecretsFileContents {
  /** The variables it defines, `JSAILS_CREDENTIALS_KEY` excluded. */
  readonly values: Readonly<Record<string, string>>;
  /** The credentials key ring text it carries, when it carries one. */
  readonly credentialsKey: string | undefined;
}

/**
 * Read and validate the secrets file at `path`. Throws
 * `environment.unreadable_secrets_file`, `environment.invalid_secrets_file`
 * or `environment.secrets_file_reserved_key`.
 */
export function readSecretsFile(path: string): SecretsFileContents {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new EnvironmentErrors.Error('unreadable_secrets_file', {}, { cause: error });
  }
  return parseSecretsFile(raw);
}

/** Validate secrets-file text. Throws as {@link readSecretsFile} does. */
export function parseSecretsFile(raw: string): SecretsFileContents {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw invalid('not JSON');
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw invalid('not an object');
  }
  const { v, values } = document as { v?: unknown; values?: unknown };
  if (v !== SECRETS_FILE_VERSION) throw invalid('unsupported version');
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw invalid('no values object');
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  let credentialsKey: string | undefined;
  for (const [name, value] of Object.entries(values)) {
    if (!isEnvKey(name)) throw invalid('invalid variable name');
    if (typeof value !== 'string') throw invalid('a value that is not a string');
    if (value.includes('\0')) throw invalid('a value containing NUL');
    if (name === CREDENTIALS_KEY_ENV) credentialsKey = value;
    else result[name] = value;
  }
  const reserved = firstReservedKey(Object.keys(result));
  if (reserved !== undefined) {
    throw new EnvironmentErrors.Error('secrets_file_reserved_key', { key: reserved });
  }
  return Object.freeze({ values: Object.freeze(result), credentialsKey });
}

type SecretsFileProblem =
  | 'not JSON'
  | 'not an object'
  | 'unsupported version'
  | 'no values object'
  | 'invalid variable name'
  | 'a value that is not a string'
  | 'a value containing NUL';

function invalid(problem: SecretsFileProblem): Error {
  return new EnvironmentErrors.Error('invalid_secrets_file', { problem });
}
