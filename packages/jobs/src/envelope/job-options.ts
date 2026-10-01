/**
 * The bounds of every job option and job name and the one validator for
 * each, shared by `defineJob` (definition defaults), dispatch (per-call
 * overrides), and the envelope decoder (what a transport hands back). A validator returns the
 * option's normalized value or `undefined` for a value it refuses, so each
 * caller raises its own value-free error and the decoder can report a
 * malformed envelope without throwing.
 */

import type { JobBackoff, JobOptions } from '../contract/index.js';

/** Total attempts a job may have, the first run included. */
export const MAX_ATTEMPTS = 25;

/**
 * The longest delay, retry backoff, attempt deadline, key window, or schedule
 * interval: one year. Anything longer is almost always a unit mistake, and work
 * due that far ahead belongs in a database row that a schedule sweeps.
 */
export const MAX_JOB_DELAY_MS: number = 365 * 86_400_000;

/** The largest priority; lower runs first, `0` is the default and the most urgent. */
export const MAX_PRIORITY = 2_097_152;

/** The longest idempotency key, in UTF-16 code units. */
export const MAX_KEY_LENGTH = 512;

/** At most this many tags per job, each at most {@link MAX_TAG_LENGTH} long. */
export const MAX_TAGS = 32;
export const MAX_TAG_LENGTH = 128;

/** The shortest overlap lease, in milliseconds. */
export const MIN_OVERLAP_TTL_MS = 1_000;
/** The longest overlap lease, in milliseconds: one hour. */
export const MAX_OVERLAP_TTL_MS = 3_600_000;
/** The overlap lease a job gets unless it states its own: five minutes. */
export const DEFAULT_OVERLAP_TTL_MS = 300_000;

/** The longest job name. */
export const MAX_JOB_NAME_LENGTH = 128;

const JOB_NAME = /^[A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)*$/;

/** The options every definition gets unless it states its own. */
export const DEFAULT_JOB_OPTIONS: Readonly<{ attempts: number; backoff: JobBackoff }> =
  Object.freeze({
    attempts: 3,
    backoff: Object.freeze({ type: 'exponential', delayMs: 1_000 }),
  });

/** The key window a keyed dispatch gets when neither the call nor the definition states one. */
export const DEFAULT_KEY_WINDOW_MS = 86_400_000;

/** The keys of {@link JobOptions}, in wire order. */
export const JOB_OPTION_KEYS: readonly (keyof JobOptions)[] = Object.freeze([
  'attempts',
  'backoff',
  'timeoutMs',
  'priority',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

/**
 * Whether `name` is a valid job name: letters and digits in segments joined
 * by `.`, `:`, `_` or `-`, starting with a letter, at most 128 characters.
 */
export function isJobName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= MAX_JOB_NAME_LENGTH && JOB_NAME.test(name);
}

export function validAttempts(value: unknown): number | undefined {
  return integerIn(value, 1, MAX_ATTEMPTS);
}

/** A delay in milliseconds, `0` included. */
export function validDelay(value: unknown): number | undefined {
  return integerIn(value, 0, MAX_JOB_DELAY_MS);
}

/** A duration in milliseconds that must be at least 1. */
export function validDuration(value: unknown): number | undefined {
  return integerIn(value, 1, MAX_JOB_DELAY_MS);
}

/** An overlap lease TTL in milliseconds. */
export function validOverlapTtl(value: unknown): number | undefined {
  return integerIn(value, MIN_OVERLAP_TTL_MS, MAX_OVERLAP_TTL_MS);
}

export function validPriority(value: unknown): number | undefined {
  return integerIn(value, 0, MAX_PRIORITY);
}

export function validBackoff(value: unknown): JobBackoff | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('delayMs')) return undefined;
  if (value.type !== 'fixed' && value.type !== 'exponential') return undefined;
  const delayMs = validDelay(value.delayMs);
  if (delayMs === undefined) return undefined;
  return Object.freeze({ type: value.type, delayMs });
}

export function validKey(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH
    ? value
    : undefined;
}

export function validTags(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_TAGS) return undefined;
  const tags: string[] = [];
  for (const tag of value as unknown[]) {
    if (typeof tag !== 'string' || tag.length === 0 || tag.length > MAX_TAG_LENGTH) {
      return undefined;
    }
    tags.push(tag);
  }
  return Object.freeze(tags);
}

/** The option a {@link validJobOptions} call refused, or `unknown` for a key that is not an option. */
export type JobOptionsProblem = keyof JobOptions | 'unknown' | 'shape';

/**
 * Validate a {@link JobOptions} record: only known keys, each in bounds.
 * Absent and `undefined` fields are left out of the result.
 */
export function validJobOptions(
  value: unknown,
):
  | { readonly ok: true; readonly options: JobOptions }
  | { readonly ok: false; readonly problem: JobOptionsProblem } {
  if (!isRecord(value)) return { ok: false, problem: 'shape' };
  const options: { -readonly [K in keyof JobOptions]: JobOptions[K] } = {};
  for (const key of Object.keys(value)) {
    if (!(JOB_OPTION_KEYS as readonly string[]).includes(key))
      return { ok: false, problem: 'unknown' };
  }
  for (const key of JOB_OPTION_KEYS) {
    const raw = value[key];
    if (raw === undefined) continue;
    switch (key) {
      case 'attempts': {
        const attempts = validAttempts(raw);
        if (attempts === undefined) return { ok: false, problem: key };
        options.attempts = attempts;
        break;
      }
      case 'backoff': {
        const backoff = validBackoff(raw);
        if (backoff === undefined) return { ok: false, problem: key };
        options.backoff = backoff;
        break;
      }
      case 'timeoutMs': {
        const timeoutMs = validDuration(raw);
        if (timeoutMs === undefined) return { ok: false, problem: key };
        options.timeoutMs = timeoutMs;
        break;
      }
      case 'priority': {
        const priority = validPriority(raw);
        if (priority === undefined) return { ok: false, problem: key };
        options.priority = priority;
        break;
      }
    }
  }
  return { ok: true, options: Object.freeze(options) };
}

/** The delay before attempt `attemptsMade + 1`, after `attemptsMade` failed attempts. */
export function backoffDelay(backoff: JobBackoff | undefined, attemptsMade: number): number {
  if (backoff === undefined) return 0;
  if (backoff.type === 'fixed') return backoff.delayMs;
  const factor = 2 ** Math.max(0, attemptsMade - 1);
  return Math.min(backoff.delayMs * factor, MAX_JOB_DELAY_MS);
}
