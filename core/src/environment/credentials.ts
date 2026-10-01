/**
 * Sealed credentials, format v2: a committed, per-environment dotenv document
 * encrypted under the environment's key ring.
 *
 * `config/credentials/<environment>.enc` is two lines:
 *
 * ```text
 * jsails-credentials v2 <environment> <keyId>
 * <base64url of iv (12 bytes) || ciphertext || GCM tag (16 bytes)>
 * ```
 *
 * The cipher is AES-256-GCM under a key derived from the ring key that `keyId`
 * names (see `key-ring.ts`), with the header line as additional authenticated
 * data, so a document copied to another environment, or one whose header was
 * edited to name another key, fails to open rather than loading the wrong
 * secrets. The key ring comes from `JSAILS_CREDENTIALS_KEY` for the
 * environment the process runs as, else from the git-ignored
 * `config/credentials/<environment>.key`; holding one environment's key
 * reveals nothing about another's.
 *
 * The plaintext is a dotenv document and may not define a reserved key. The
 * module never reads `process.env`: what is sealed is exactly the document
 * the caller passes.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { CredentialsErrors, EnvironmentErrors } from './errors.js';
import { KeyRing } from './key-ring.js';
import { firstReservedKey, isEnvironmentName, isEnvKey } from './names.js';

/** The directory, relative to the project root, that holds credentials files. */
export const CREDENTIALS_DIR = 'config/credentials';

const FORMAT = 'jsails-credentials';
const VERSION = 2;
const HEADER = /^jsails-credentials v2 ([A-Za-z0-9][A-Za-z0-9_-]{0,63}) ([0-9a-f]{16})$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Where one environment's credentials live, relative to the project root.
 *
 * @internal
 */
export interface CredentialsPaths {
  /** The committed, sealed document. */
  readonly file: string;
  /** The git-ignored key file. */
  readonly keyFile: string;
}

/**
 * The document and key file of `environment`, relative to the project root.
 * Throws `credentials.invalid_environment` for a name that could not be a
 * plain file name.
 */
export function credentialsPaths(environment: string): CredentialsPaths {
  if (!isEnvironmentName(environment)) {
    throw new CredentialsErrors.Error('invalid_environment');
  }
  return {
    file: `${CREDENTIALS_DIR}/${environment}.enc`,
    keyFile: `${CREDENTIALS_DIR}/${environment}.key`,
  };
}

/** The bytes of the sealed document of `environment`, or `undefined` when there is none. */
export function readSealedDocument(rootDir: string, environment: string): Buffer | undefined {
  return readOptional(rootDir, credentialsPaths(environment).file);
}

/** The key ring in `environment`'s key file, or `undefined` when there is none. */
export function readKeyFile(rootDir: string, environment: string): KeyRing | undefined {
  const bytes = readOptional(rootDir, credentialsPaths(environment).keyFile);
  if (bytes === undefined) return undefined;
  const text = bytes.toString('utf8');
  return text.trim() === '' ? undefined : KeyRing.parse(text);
}

/** The SHA-256 of a sealed document's bytes, as hex: what the inheritance marker records. */
export function documentDigest(document: Buffer): string {
  return createHash('sha256').update(document).digest('hex');
}

/** The key id a sealed document names. Throws when the document is not v2. */
export function sealedKeyId(document: Buffer, environment: string): string {
  return parseDocument(document, environment).keyId;
}

/** Seal the dotenv `plaintext` for `environment` under the ring key `keyId`. */
export function sealCredentials(
  plaintext: string,
  ring: KeyRing,
  environment: string,
  keyId: string = ring.currentId,
): string {
  credentialsPaths(environment);
  const key = ring.encryptionKey(keyId);
  if (key === undefined) {
    throw new CredentialsErrors.Error('unknown_key', { environment, keyId });
  }
  parseCredentials(plaintext, environment);
  const header = `${FORMAT} v${VERSION} ${environment} ${keyId}`;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(header, 'utf8'));
  const body = Buffer.concat([
    iv,
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${header}\n${body.toString('base64url')}\n`;
}

/** What {@link openCredentials} returns: the plaintext and the key that opened it. */
export interface OpenedCredentials {
  readonly plaintext: string;
  readonly keyId: string;
}

/**
 * Open a sealed document of `environment` with whichever ring key it names.
 * Throws `credentials.invalid_document`, `unsupported_version`,
 * `environment_mismatch`, `unknown_key` or `decryption_failed`.
 */
export function openCredentials(
  document: Buffer,
  ring: KeyRing,
  environment: string,
): OpenedCredentials {
  const { header, keyId, body } = parseDocument(document, environment);
  const key = ring.encryptionKey(keyId);
  if (key === undefined) {
    throw new CredentialsErrors.Error('unknown_key', { environment, keyId });
  }
  if (body.length < IV_BYTES + TAG_BYTES) {
    throw new CredentialsErrors.Error('decryption_failed', { environment });
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(header, 'utf8'));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(body.subarray(IV_BYTES, body.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    return { plaintext, keyId };
  } catch {
    throw new CredentialsErrors.Error('decryption_failed', { environment });
  }
}

/**
 * Parse a decrypted document with dotenv's rules. Throws
 * `credentials.invalid_name` when it defines a name that is not a plain
 * variable name (dotenv also accepts `.` and `__proto__`), and
 * `credentials.reserved_key` when it defines a reserved key.
 */
export function parseCredentials(
  plaintext: string,
  environment: string,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(parseEnv(plaintext))) {
    if (value !== undefined) values[name] = value;
  }
  if (!Object.keys(values).every(isEnvKey)) throw new CredentialsErrors.Error('invalid_name');
  const reserved = firstReservedKey(Object.keys(values));
  if (reserved !== undefined) {
    throw new CredentialsErrors.Error('reserved_key', { environment, key: reserved });
  }
  return Object.freeze(values);
}

interface ParsedDocument {
  readonly header: string;
  readonly keyId: string;
  readonly body: Buffer;
}

function parseDocument(document: Buffer, environment: string): ParsedDocument {
  const text = document.toString('utf8').replace(/\r?\n$/, '');
  const newline = text.indexOf('\n');
  const header = newline === -1 ? text : text.slice(0, newline);
  const version = /^jsails-credentials v(\d+)(?: |$)/.exec(header)?.[1];
  if (version !== undefined && Number(version) !== VERSION) {
    throw new CredentialsErrors.Error('unsupported_version', { environment });
  }
  const match = HEADER.exec(header);
  if (match === null) throw new CredentialsErrors.Error('invalid_document', { environment });
  const [, sealed, keyId] = match as unknown as [string, string, string];
  if (sealed !== environment) {
    throw new CredentialsErrors.Error('environment_mismatch', { environment, sealed });
  }
  const encoded = newline === -1 ? '' : text.slice(newline + 1).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new CredentialsErrors.Error('invalid_document', { environment });
  }
  return { header, keyId, body: Buffer.from(encoded, 'base64url') };
}

/**
 * The bytes of `file` under `rootDir`, or `undefined` when it does not exist.
 * Any other failure is `environment.unreadable_file`.
 */
function readOptional(rootDir: string, file: string): Buffer | undefined {
  try {
    return readFileSync(join(rootDir, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new EnvironmentErrors.Error('unreadable_file', { file }, { cause: error });
  }
}
