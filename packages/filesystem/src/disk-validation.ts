/**
 * The validators and error reducers every disk implementation shares: key and
 * prefix shape, `put` data and options, the `maxBytes` option, signed-URL
 * options, and the value-free `io` failure.
 */

import {
  DISK_URL_DEFAULT_EXPIRES_IN,
  DISK_URL_MAX_EXPIRES_IN,
  DiskError,
  type DiskData,
  type DiskUrlOptions,
} from 'jsails/filesystem';
import { isNonNegativeInteger, sanitizeBackendError } from 'jsails/plugin-sdk';
import { CONTROL_CHARS, Url } from 'jsails/support';

const WINDOWS_DRIVE = /^[A-Za-z]:/;

/**
 * Reject any key that is not a relative POSIX-style path. Conservative: empty,
 * absolute, drive-prefixed, backslashed, control-bearing, and any
 * empty/`.`/`..` segment are all refused with a value-free `DiskError` (the key
 * is never echoed).
 */
export function assertDiskKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new DiskError('invalid_key', 'disk keys must be non-empty strings');
  }
  if (CONTROL_CHARS.test(key)) {
    throw new DiskError('invalid_key', 'disk keys must not contain control characters');
  }
  if (key.includes('\\')) {
    throw new DiskError('invalid_key', 'disk keys must use forward slashes');
  }
  if (key.startsWith('/') || WINDOWS_DRIVE.test(key)) {
    throw new DiskError('invalid_key', 'disk keys must be relative POSIX paths');
  }
  for (const segment of key.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new DiskError('invalid_key', 'disk keys must not contain empty, ".", or ".." segments');
    }
  }
}

/** Validate a `list` prefix: `undefined`/`''` means "all", otherwise a valid key. */
export function assertDiskPrefix(prefix: unknown): asserts prefix is string | undefined {
  if (prefix === undefined || prefix === '') {
    return;
  }
  assertDiskKey(prefix);
}

/** Normalize accepted `put` data to bytes (a UTF-8 encode for strings). */
export function toDiskBytes(data: DiskData): Uint8Array {
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  return data;
}

/** Validate the advisory `contentType`, when supplied. */
export function assertContentType(contentType: unknown): void {
  if (contentType === undefined) {
    return;
  }
  if (typeof contentType !== 'string' || contentType.trim() === '') {
    throw new TypeError('contentType must be a non-empty string');
  }
}

/** Validate a `maxBytes` option: `undefined` or a non-negative integer. */
export function validateMaxBytes(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isNonNegativeInteger(value)) {
    throw new TypeError('maxBytes must be a non-negative integer');
  }
  return value;
}

/**
 * A media type with optional parameters (`text/plain; charset=utf-8`), in RFC
 * 9110 token syntax (parameter values unquoted, optional whitespace only space
 * or tab). Signed-URL content types travel to the store as a query parameter
 * it echoes into a response header, so anything looser, a CR or LF above all,
 * is refused.
 */
const MEDIA_TYPE =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:[ \t]*;[ \t]*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/;

/** Signed-URL options, validated and reduced to what a store signs. */
export interface ResolvedDiskUrlOptions {
  /** Lifetime in seconds, within `1..DISK_URL_MAX_EXPIRES_IN`. */
  readonly expiresIn: number;
  /** The full `Content-Disposition` header value, when requested. */
  readonly contentDisposition: string | undefined;
  readonly contentType: string | undefined;
}

/**
 * Validate {@link DiskUrlOptions}: a lifetime within the bound (default 15
 * minutes), a known disposition, a filename only alongside a disposition, and
 * a well-formed media type. Mistakes throw a value-free `TypeError`, as the
 * other per-call option checks do.
 */
export function resolveDiskUrlOptions(options: DiskUrlOptions | undefined): ResolvedDiskUrlOptions {
  if (options === undefined) {
    return {
      expiresIn: DISK_URL_DEFAULT_EXPIRES_IN,
      contentDisposition: undefined,
      contentType: undefined,
    };
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('url options must be an object');
  }
  const expiresIn = options.expiresIn ?? DISK_URL_DEFAULT_EXPIRES_IN;
  if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > DISK_URL_MAX_EXPIRES_IN) {
    throw new TypeError(
      `expiresIn must be an integer number of seconds from 1 to ${DISK_URL_MAX_EXPIRES_IN}`,
    );
  }
  const { disposition, filename, contentType } = options;
  if (disposition !== undefined && disposition !== 'inline' && disposition !== 'attachment') {
    throw new TypeError('disposition must be inline or attachment');
  }
  if (filename !== undefined) {
    if (disposition === undefined) {
      throw new TypeError('filename requires a disposition');
    }
    if (typeof filename !== 'string' || filename === '' || CONTROL_CHARS.test(filename)) {
      throw new TypeError('filename must be a non-empty string without control characters');
    }
  }
  if (
    contentType !== undefined &&
    (typeof contentType !== 'string' || !MEDIA_TYPE.test(contentType))
  ) {
    throw new TypeError('contentType must be a valid media type');
  }
  return {
    expiresIn,
    contentDisposition:
      disposition === undefined
        ? undefined
        : Url.contentDisposition(filename ?? '', { type: disposition }),
    contentType,
  };
}

/**
 * Reduce a backend failure to a value-free `io_failed` {@link DiskError}: only an
 * errno code is carried over, never a path, key, bucket, or payload.
 */
export function toDiskIoError(error: unknown): Error {
  return sanitizeBackendError(error, 'disk I/O', (message) => new DiskError('io_failed', message));
}
