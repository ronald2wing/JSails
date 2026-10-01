/**
 * The `overlap` option of a job definition or a schedule, resolved once when
 * it is declared, and the {@link JobOverlap} a dispatch stores from it: the
 * lease key (the option's own, one computed from the parsed payload, or the
 * job name or schedule id) and the lease TTL.
 */

import type { JobOverlap } from '../contract/index.js';
import { DEFAULT_OVERLAP_TTL_MS, validKey, validOverlapTtl } from '../envelope/job-options.js';
import { JobsErrors } from '../errors/jobs-errors.js';

/** A resolved overlap option. */
export interface OverlapOption {
  /** A fixed key, a function of the parsed payload, or `undefined` for the fallback key. */
  readonly key: string | ((payload: unknown) => string) | undefined;
  readonly ttlMs: number;
}

/** Every lease key of overlap control starts with this, apart from other leases of a namespace. */
export const OVERLAP_LEASE_PREFIX = 'overlap:';

const OPTION_KEYS: ReadonlySet<string> = new Set(['key', 'ttlMs']);

function refuse(cause?: unknown): Error {
  return new JobsErrors.Error(
    'invalid_option',
    { option: 'overlap' },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Resolve an `overlap` option: `true` takes the fallback key and the default
 * TTL (five minutes); a record holds only `key` (a string, or a function of
 * the parsed payload) and `ttlMs` (1,000 to 3,600,000).
 *
 * @throws `jobs.invalid_option` naming `overlap` for anything else.
 */
export function resolveOverlapOption(value: unknown): OverlapOption | undefined {
  if (value === undefined) return undefined;
  if (value === true) return Object.freeze({ key: undefined, ttlMs: DEFAULT_OVERLAP_TTL_MS });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw refuse();
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => OPTION_KEYS.has(key))) throw refuse();
  let ttlMs = DEFAULT_OVERLAP_TTL_MS;
  if (record.ttlMs !== undefined) {
    const ttl = validOverlapTtl(record.ttlMs);
    if (ttl === undefined) throw refuse();
    ttlMs = ttl;
  }
  const key = record.key;
  if (key !== undefined && typeof key !== 'function' && validKey(key) === undefined) {
    throw refuse();
  }
  return Object.freeze({ key: key as OverlapOption['key'], ttlMs });
}

/**
 * The overlap a job stores: the option's key, or its function's value for
 * the `parsed` payload, else `fallbackKey`.
 *
 * @throws `jobs.invalid_option` naming `overlap` when the key function throws
 *   (the cause carries its error) or yields no valid key (1 to 512 characters).
 */
export function overlapFor(
  option: OverlapOption,
  fallbackKey: string,
  parsed: unknown,
): JobOverlap {
  let raw: unknown = option.key ?? fallbackKey;
  if (typeof option.key === 'function') {
    try {
      raw = option.key(parsed);
    } catch (error) {
      throw refuse(error);
    }
  }
  const key = validKey(raw);
  if (key === undefined) throw refuse();
  return Object.freeze({ key, ttlMs: option.ttlMs });
}
