/**
 * The secrets file a release reads: format v1 and the mount convention.
 *
 * An app container receives its secret channel as one JSON document,
 * `{ "v": 1, "values": { "NAME": "value" } }`, which the JSails environment
 * resolver reads as the layer just below the real environment
 * (`JSAILS_SECRETS_FILE`, core's `environment/secrets-file.ts`). A JSON string
 * carries every value byte for byte (a PEM block, a backslash, `$`, quotes,
 * non-ASCII), which a Docker env file cannot: its line format ends a value at
 * the first newline. Two things no JSON file can hand to a process
 * environment are refused when the env resolves, before anything is built or
 * sent, naming only the key: a NUL (an environment variable ends at it) and
 * an unpaired UTF-16 surrogate (no UTF-8 encoding exists, and Node would
 * rewrite it to U+FFFD on its way into `process.env`).
 *
 * Each release has its own file on the host,
 * `.jamal/apps/<app>/releases/<release>/secrets/secrets.json`, written through
 * `writeRemoteFile`: the release directory is created `0700` and owned by the
 * ssh user, so no other host user can reach the file; `secrets/` is `0755`
 * and the file `0444`, so whatever uid the image runs as can read the
 * directory, which the container mounts read-only at
 * {@link CONTAINER_SECRETS_DIR} by its absolute path under the home the
 * server reported (`host-home.ts`), never a `./` source, which a Docker CLI
 * before 23 refuses. The release is told where it is with
 * `JSAILS_SECRETS_FILE`.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';
import { CREDENTIALS_KEY_ENV, RESERVED_KEYS } from 'jsails/internal';

import { isForbiddenKey } from '../object-shape.js';
import { absoluteHostPath, hostSecretsDir, hostSecretsFilePath } from './host-layout.js';

/** The format version this module writes, the one core's resolver reads. */
export const SECRETS_FILE_VERSION = 1;

/** Where an app container mounts its release's secrets directory, read-only. */
export const CONTAINER_SECRETS_DIR = '/run/jsails/secrets';

/** The file's name inside the secrets directory. */
const SECRETS_FILE_NAME = 'secrets.json';

/** The `JSAILS_SECRETS_FILE` a release container is started with. */
export const CONTAINER_SECRETS_FILE: string = `${CONTAINER_SECRETS_DIR}/${SECRETS_FILE_NAME}`;

/** The secrets file's mode on the host: readable by any uid, written by none. */
export const SECRETS_FILE_MODE = 0o444;

/** The secrets directory's mode on the host: any uid may list and enter it. */
export const SECRETS_DIRECTORY_MODE = 0o755;

const SECRETS_FILE_ERRORS = {
  invalid_key: {
    kind: 'invalid',
    message: 'a secrets-file key must be an environment variable name: [A-Za-z_][A-Za-z0-9_]*',
  },
  reserved_key: {
    kind: 'invalid',
    message:
      '{key} is reserved by the JSails environment resolver, which refuses it in a secrets file',
    context: { key: 'identifier' },
  },
  unrepresentable_value: {
    kind: 'invalid',
    message:
      'the value of {key} contains a NUL or an unpaired UTF-16 surrogate, which no process environment can receive',
    context: { key: 'identifier' },
    suggestion: 'remove the NUL or the broken character from that secret',
  },
} as const;

/** `jamal_secrets_file.*`: a resolved secret cannot be written to the secrets file. */
export const SecretsFileErrors: ErrorRegistry<'jamal_secrets_file', typeof SECRETS_FILE_ERRORS> =
  defineErrors('jamal_secrets_file', SECRETS_FILE_ERRORS);

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A NUL, or (with the `u` flag) a surrogate code unit that has no partner. */
const UNREPRESENTABLE = /[\0\p{Cs}]/u;

/**
 * The secrets file holding `values`, as UTF-8 bytes: keys sorted, so the
 * same secrets give the same bytes. A key the resolver reserves is refused
 * here, as the app would refuse it at boot; the credentials key ring is the
 * one it accepts, and lifts out of the values. Throws
 * `jamal_secrets_file.invalid_key`, `reserved_key`, or
 * `unrepresentable_value` (naming the key only).
 */
export function encodeSecretsFile(values: Readonly<Record<string, string>>): Uint8Array {
  const sorted: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(values).sort()) {
    if (!ENV_KEY.test(key) || isForbiddenKey(key)) {
      throw new SecretsFileErrors.Error('invalid_key');
    }
    if (key !== CREDENTIALS_KEY_ENV && RESERVED_KEYS.includes(key)) {
      throw new SecretsFileErrors.Error('reserved_key', { key });
    }
    const value = values[key] as string;
    if (UNREPRESENTABLE.test(value)) {
      throw new SecretsFileErrors.Error('unrepresentable_value', { key });
    }
    sorted[key] = value;
  }
  return Buffer.from(`${JSON.stringify({ v: SECRETS_FILE_VERSION, values: sorted })}\n`, 'utf8');
}

/** Where a release's secrets live on the host, and how its container reaches them. */
export interface ReleaseSecretsLayout {
  /** The secrets file, relative to the ssh user's home: where it is written. */
  readonly hostFile: string;
  /** The `docker run` flags that mount its directory and point the app at it. */
  readonly runFlags: readonly string[];
}

/**
 * The secrets layout of the release `release` (its container name) of
 * `service` at `destination`, on a server whose ssh user's home is `home`
 * (absolute, as `readHostHome` read it, or the plan preview's stand-in). The
 * file is written relative to the home, where the ssh session starts; the
 * bind source is the same directory as an absolute path, the only form every
 * Docker CLI version passes to the daemon as a host directory.
 */
export function releaseSecretsLayout(
  service: string,
  destination: string | undefined,
  release: string,
  home: string,
): ReleaseSecretsLayout {
  const source = absoluteHostPath(home, hostSecretsDir(service, destination, release));
  return {
    hostFile: hostSecretsFilePath(service, destination, release, SECRETS_FILE_NAME),
    runFlags: [
      '-v',
      `${source}:${CONTAINER_SECRETS_DIR}:ro`,
      '-e',
      `JSAILS_SECRETS_FILE=${CONTAINER_SECRETS_FILE}`,
    ],
  };
}
