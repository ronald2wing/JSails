/**
 * The option checks every disk in this package shares: write, list and
 * signed-URL options, the per-disk quota, and the reduction of a backend
 * failure to `disk.io_failed`. Every refusal is a value-free `disk.*` error
 * naming only the offending option.
 */

import {
  assertMaxBytes,
  DISK_LIST_MAX_LIMIT,
  DiskErrors,
  SIGNED_URL_MAX_EXPIRES_IN_MS,
  type DiskOperation,
  type DiskListOptions,
  type DiskWriteOptions,
  type DiskSignedUrlOptions,
} from 'jsails/filesystem';
import { CONTROL_CHARS, Url } from 'jsails/support';

/**
 * A media type with optional parameters (`text/plain; charset=utf-8`), in RFC
 * 9110 token syntax (parameter values unquoted, optional whitespace only space
 * or tab). Stores echo a content type into a response header, so anything
 * looser, a CR or LF above all, is refused.
 */
const MEDIA_TYPE =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:[ \t]*;[ \t]*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/;

function invalid(option: string): Error {
  return new DiskErrors.Error('invalid_option', { option });
}

/** True for a plain options object (not null, not an array). */
export function isOptionsObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Check a stored media type: absent, or RFC 9110 syntax. */
export function assertContentType(contentType: unknown): asserts contentType is string | undefined {
  if (contentType === undefined) return;
  if (typeof contentType !== 'string' || !MEDIA_TYPE.test(contentType)) {
    throw invalid('contentType');
  }
}

/** Check a write's options: `maxBytes` required, the rest well formed when present. */
export function assertWriteOptions(options: unknown): asserts options is DiskWriteOptions {
  if (!isOptionsObject(options)) throw invalid('options');
  assertMaxBytes(options.maxBytes);
  assertContentType(options.contentType);
  if (options.ifAbsent !== undefined && typeof options.ifAbsent !== 'boolean') {
    throw invalid('ifAbsent');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw invalid('signal');
  }
}

/** Check a read's abort signal, when present. */
export function assertReadSignal(signal: unknown): asserts signal is AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalid('signal');
}

/** Check a list page request: an integer `limit` from 1 to 1000 and a string cursor. */
export function assertListOptions(options: unknown): asserts options is DiskListOptions {
  if (!isOptionsObject(options)) throw invalid('options');
  const { limit, cursor } = options;
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > DISK_LIST_MAX_LIMIT
  ) {
    throw invalid('limit');
  }
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor === '')) {
    throw new DiskErrors.Error('invalid_cursor');
  }
}

/** Validate an optional per-disk byte quota: absent, or a non-negative safe integer. */
export function quotaOption(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid('maxBytes');
  }
  return value;
}

/** Validate an optional positive integer option, returning `fallback` when absent. */
export function positiveIntegerOption(value: unknown, option: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(option);
  }
  return value;
}

/** Signed-URL options, validated and reduced to what a store signs. */
export interface ResolvedSignedUrlOptions {
  /** Whole seconds, at least 1 and at most 7 days. */
  readonly expiresInSeconds: number;
  /** The full `Content-Disposition` header value. */
  readonly contentDisposition: string;
  readonly contentType: string;
}

/**
 * Validate {@link DiskSignedUrlOptions}: a lifetime from 1 second to 7 days, a known
 * disposition type with an optional control-free filename, and a well-formed
 * media type. The lifetime is rounded up to whole seconds, SigV4's unit.
 */
export function resolveSignedUrlOptions(options: unknown): ResolvedSignedUrlOptions {
  if (!isOptionsObject(options)) throw invalid('options');
  const { expiresInMs, contentDisposition, contentType } = options as Partial<
    Record<keyof DiskSignedUrlOptions, unknown>
  >;
  if (
    typeof expiresInMs !== 'number' ||
    !Number.isSafeInteger(expiresInMs) ||
    expiresInMs < 1000 ||
    expiresInMs > SIGNED_URL_MAX_EXPIRES_IN_MS
  ) {
    throw invalid('expiresInMs');
  }
  if (!isOptionsObject(contentDisposition)) throw invalid('contentDisposition');
  const { type, filename } = contentDisposition;
  if (type !== 'inline' && type !== 'attachment') throw invalid('contentDisposition');
  if (
    filename !== undefined &&
    (typeof filename !== 'string' || filename === '' || CONTROL_CHARS.test(filename))
  ) {
    throw invalid('contentDisposition');
  }
  if (contentType === undefined) throw invalid('contentType');
  assertContentType(contentType);
  return {
    expiresInSeconds: Math.ceil(expiresInMs / 1000),
    contentDisposition: Url.contentDisposition(filename ?? '', { type }),
    contentType,
  };
}

/**
 * Reduce a backend failure to `disk.io_failed` for `operation`, keeping it as
 * the cause; a `disk.*` error passes through unchanged.
 */
export function diskIoError(operation: DiskOperation, cause: unknown): Error {
  if (DiskErrors.is(cause)) return cause;
  return new DiskErrors.Error('io_failed', { operation }, { cause });
}
