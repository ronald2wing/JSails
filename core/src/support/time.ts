/**
 * The `Time` namespace: date resolution, duration parsing and formatting, arithmetic, and diffing over date-fns.
 */

// Per-function subpaths: the `date-fns` root barrel loads ~300 modules and
// costs about a second at import, which every CLI command and boot would pay.
import { add as dfAdd } from 'date-fns/add';
import { differenceInDays } from 'date-fns/differenceInDays';
import { differenceInHours } from 'date-fns/differenceInHours';
import { differenceInMilliseconds } from 'date-fns/differenceInMilliseconds';
import { differenceInMinutes } from 'date-fns/differenceInMinutes';
import { differenceInMonths } from 'date-fns/differenceInMonths';
import { differenceInSeconds } from 'date-fns/differenceInSeconds';
import { differenceInWeeks } from 'date-fns/differenceInWeeks';
import { differenceInYears } from 'date-fns/differenceInYears';
import { endOfDay } from 'date-fns/endOfDay';
import { endOfHour } from 'date-fns/endOfHour';
import { endOfMinute } from 'date-fns/endOfMinute';
import { endOfMonth } from 'date-fns/endOfMonth';
import { endOfSecond } from 'date-fns/endOfSecond';
import { endOfWeek } from 'date-fns/endOfWeek';
import { endOfYear } from 'date-fns/endOfYear';
import { isFuture } from 'date-fns/isFuture';
import { isPast } from 'date-fns/isPast';
import { isToday } from 'date-fns/isToday';
import { parseISO } from 'date-fns/parseISO';
import { startOfDay } from 'date-fns/startOfDay';
import { startOfHour } from 'date-fns/startOfHour';
import { startOfMinute } from 'date-fns/startOfMinute';
import { startOfMonth } from 'date-fns/startOfMonth';
import { startOfSecond } from 'date-fns/startOfSecond';
import { startOfWeek } from 'date-fns/startOfWeek';
import { startOfYear } from 'date-fns/startOfYear';
import { sub as dfSub } from 'date-fns/sub';
import { parseDurationMs } from './duration.js';
import prettyMs from 'pretty-ms';

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

const TIME_ERRORS = {
  invalid_date: {
    kind: 'invalid',
    message: 'cannot resolve input to a valid date',
  },
  non_finite_duration: {
    kind: 'internal',
    message: 'Time.duration: expected a finite number of milliseconds',
  },
  expected_duration_string: {
    kind: 'internal',
    message: 'Time.parseDuration: expected a non-empty string',
  },
  invalid_duration: {
    kind: 'invalid',
    message: 'Time.parseDuration: cannot parse the value as a duration',
  },
} as const;

/**
 * The `Time` namespace's codes, `time.*`: input that resolves to no date or
 * duration (`invalid`) and an argument of the wrong type (`internal`). None
 * echoes the value.
 *
 * @public
 */
export const TimeErrors: ErrorRegistry<'time', typeof TIME_ERRORS> = defineErrors(
  'time',
  TIME_ERRORS,
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimeUnit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second' | 'ms';

/** A value that can be resolved to a `Date`. */
export type DateInput = Date | number | string;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Day/month tables for the RFC 822 wire format (UTC).
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type PrettyMsOptions = NonNullable<Parameters<typeof prettyMs>[1]>;

/** Resolve a `DateInput` to a `Date`. Throws `time.invalid_date` on invalid input. */
function toDate(input: DateInput): Date {
  if (input instanceof Date) {
    if (isNaN(input.getTime())) {
      throw new TimeErrors.Error('invalid_date');
    }
    return input;
  }

  if (typeof input === 'number') {
    const d = new Date(input);
    if (isNaN(d.getTime())) {
      throw new TimeErrors.Error('invalid_date');
    }
    return d;
  }

  // string — try ISO first, then native parse
  let d = parseISO(input);
  if (isNaN(d.getTime())) {
    d = new Date(input);
  }
  if (isNaN(d.getTime())) {
    throw new TimeErrors.Error('invalid_date');
  }
  return d;
}

// date-fns Duration property map for units other than 'ms'.
const UNIT_DURATION_KEY = {
  year: 'years',
  month: 'months',
  week: 'weeks',
  day: 'days',
  hour: 'hours',
  minute: 'minutes',
  second: 'seconds',
} as const;

type DiffFn = (a: Date, b: Date) => number;

const DIFF_MAP: Record<TimeUnit, DiffFn> = {
  ms: differenceInMilliseconds,
  second: differenceInSeconds,
  minute: differenceInMinutes,
  hour: differenceInHours,
  day: differenceInDays,
  week: differenceInWeeks,
  month: differenceInMonths,
  year: differenceInYears,
};

type BoundaryFn = (date: Date) => Date;

const START_OF_MAP: Record<TimeUnit, BoundaryFn> = {
  ms: startOfSecond,
  second: startOfSecond,
  minute: startOfMinute,
  hour: startOfHour,
  day: startOfDay,
  week: startOfWeek,
  month: startOfMonth,
  year: startOfYear,
};

const END_OF_MAP: Record<TimeUnit, BoundaryFn> = {
  ms: endOfSecond,
  second: endOfSecond,
  minute: endOfMinute,
  hour: endOfHour,
  day: endOfDay,
  week: endOfWeek,
  month: endOfMonth,
  year: endOfYear,
};

// Thresholds for automatic unit selection in `relative`.
const RELATIVE_THRESHOLDS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'year', ms: 365.25 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: (365.25 / 12) * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
  { unit: 'second', ms: 1000 },
];

function bestRelativeUnit(diffMs: number): {
  value: number;
  unit: Intl.RelativeTimeFormatUnit;
} {
  const absMs = Math.abs(diffMs);
  for (const entry of RELATIVE_THRESHOLDS) {
    if (absMs >= entry.ms) {
      return { value: Math.trunc(diffMs / entry.ms), unit: entry.unit };
    }
  }
  return { value: Math.trunc(diffMs / 1000), unit: 'second' };
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Format milliseconds as a human-readable duration string.
 *
 * Wraps {@link https://github.com/sindresorhus/pretty-ms | pretty-ms}.
 */
export function duration(ms: number, options?: PrettyMsOptions): string {
  if (typeof ms !== 'number' || !isFinite(ms)) {
    throw new TimeErrors.Error('non_finite_duration');
  }
  return prettyMs(ms, options);
}

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Accepts strings like
 * `'2 days'`, `'1h'`, `'3 minutes'`.
 *
 * @throws `time.invalid_duration` if the input cannot be parsed.
 */
export function parseDuration(input: string): number {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new TimeErrors.Error('expected_duration_string');
  }
  const result = parseDurationMs(input);
  if (result === undefined) {
    throw new TimeErrors.Error('invalid_duration');
  }
  return result;
}

/**
 * Parse a date from a `string`, `number` (timestamp), or `Date`.
 *
 * Uses `date-fns/parseISO` for string input; falls back to the platform
 * `Date` parser.
 *
 * @throws `time.invalid_date` if the input cannot be resolved to a valid date.
 */
export function parse(input: DateInput): Date {
  return toDate(input);
}

/**
 * Return the difference between two dates in the given unit.
 *
 * Default unit is `'ms'`. The result is `a - b` (positive when `a` is later).
 *
 * Wraps the `differenceIn*` family from date-fns.
 */
export function diff(a: DateInput, b: DateInput, unit: TimeUnit = 'ms'): number {
  const da = toDate(a);
  const db = toDate(b);
  const fn = DIFF_MAP[unit];
  return fn(da, db);
}

/**
 * Add `amount` of `unit` to a date.
 *
 * Wraps `date-fns/add`.
 */
export function add(value: DateInput, amount: number, unit: TimeUnit): Date {
  const d = toDate(value);
  if (unit === 'ms') {
    return new Date(d.getTime() + amount);
  }
  return dfAdd(d, { [UNIT_DURATION_KEY[unit]]: amount });
}

/**
 * Subtract `amount` of `unit` from a date.
 *
 * Wraps `date-fns/sub`.
 */
export function subtract(value: DateInput, amount: number, unit: TimeUnit): Date {
  const d = toDate(value);
  if (unit === 'ms') {
    return new Date(d.getTime() - amount);
  }
  return dfSub(d, { [UNIT_DURATION_KEY[unit]]: amount });
}

/**
 * Return the start of `unit` for the given date.
 *
 * Wraps the `startOf*` family from date-fns.
 */
export function startOf(value: DateInput, unit: TimeUnit): Date {
  const d = toDate(value);
  return START_OF_MAP[unit](d);
}

/**
 * Return the end of `unit` for the given date.
 *
 * Wraps the `endOf*` family from date-fns.
 */
export function endOf(value: DateInput, unit: TimeUnit): Date {
  const d = toDate(value);
  return END_OF_MAP[unit](d);
}

/**
 * Format a date using `Intl.DateTimeFormat`.
 */
export function format(
  value: DateInput,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  const d = toDate(value);
  return new Intl.DateTimeFormat(locale, options).format(d);
}

/**
 * Return a human-readable relative time string (e.g. "3 days ago").
 *
 * Uses `Intl.RelativeTimeFormat`. `base` defaults to the current time.
 * The unit is chosen automatically as the largest unit where the rounded
 * absolute difference is at least 1.
 */
export function relative(value: DateInput, base?: DateInput, locale?: string): string {
  const dv = toDate(value);
  const db = base !== undefined ? toDate(base) : new Date();
  const diffMs = dv.getTime() - db.getTime();
  const { value: relValue, unit: relUnit } = bestRelativeUnit(diffMs);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return rtf.format(relValue, relUnit);
}

/**
 * Format a `Date` as an RFC 822 datetime string (`Thu, 01 Jan 1970 00:00:00 +0000`).
 *
 * Used for RSS `<pubDate>`. The caller resolves the input to a `Date`
 * (falling back to the epoch itself when the input is absent or unparseable);
 * this function never parses strings.
 */
export function rfc822(date: Date): string {
  const day = WEEKDAYS[date.getUTCDay()]!;
  const d = String(date.getUTCDate()).padStart(2, '0');
  const month = MONTHS[date.getUTCMonth()]!;
  const y = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${day}, ${d} ${month} ${y} ${hh}:${mm}:${ss} +0000`;
}

/**
 * Format a `Date` as a canonical ISO 8601 UTC string (`2026-01-02T15:04:05.000Z`).
 *
 * Used for Atom `<updated>`. The caller resolves the input to a `Date`; this
 * function never parses strings.
 */
export function iso8601(date: Date): string {
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

// Predicate helpers are re-exported bare so the module satisfies the
// named-export contract (design §4.1) as well as the namespace object.
export { isFuture, isPast, isToday };

export const Time: Readonly<{
  add: typeof add;
  diff: typeof diff;
  duration: typeof duration;
  endOf: typeof endOf;
  format: typeof format;
  isFuture: typeof isFuture;
  isPast: typeof isPast;
  isToday: typeof isToday;
  iso8601: typeof iso8601;
  parse: typeof parse;
  parseDuration: typeof parseDuration;
  relative: typeof relative;
  rfc822: typeof rfc822;
  startOf: typeof startOf;
  subtract: typeof subtract;
}> = Object.freeze({
  add,
  diff,
  duration,
  endOf,
  format,
  isFuture,
  isPast,
  isToday,
  iso8601,
  parse,
  parseDuration,
  relative,
  rfc822,
  startOf,
  subtract,
});
