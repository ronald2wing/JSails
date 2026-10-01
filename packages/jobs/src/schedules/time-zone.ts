/**
 * Wall time in an IANA time zone, on `Intl` alone: the canonical name of a
 * zone, the local fields of an instant, a zone's offset, and the instant of a
 * local wall time, with the two daylight-saving cases resolved one way:
 *
 * - a wall time in a spring-forward gap maps to the end of the gap, the first
 *   instant whose local time is later than it;
 * - a wall time that occurs twice maps to its first occurrence.
 *
 * `UTC` takes a fast path that never touches `Intl`. Times are whole seconds:
 * cron has no finer field.
 */

/** A wall time: calendar fields with no zone. `month` is 1 to 12. */
export interface LocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** A wall time with its day of the week, 0 (Sunday) to 6. */
export interface ZonedFields extends LocalTime {
  readonly weekday: number;
}

/** How a wall time maps to an instant. */
export interface ResolvedInstant {
  readonly instant: number;
  /** `gap`: the wall time does not occur; `ambiguous`: it occurs twice. */
  readonly kind: 'exact' | 'gap' | 'ambiguous';
}

const DAY_MS = 86_400_000;
const MAX_ZONE_LENGTH = 64;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The canonical name of time zone `value` (`utc` reads `UTC`), or `undefined` for one `Intl` does not know. */
export function canonicalTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ZONE_LENGTH) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    // A RangeError is how Intl says the zone is unknown; the caller refuses it value-free.
    return undefined;
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  let format = formatters.get(tz);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, format);
  }
  return format;
}

/** The epoch milliseconds of `local` read as UTC, over the proleptic Gregorian calendar. */
export function utcOf(local: LocalTime): number {
  const date = new Date(0);
  date.setUTCFullYear(local.year, local.month - 1, local.day);
  date.setUTCHours(local.hour, local.minute, local.second, 0);
  return date.getTime();
}

/** The UTC fields of `instant`. */
export function utcFields(instant: number): ZonedFields {
  const date = new Date(instant);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    weekday: date.getUTCDay(),
  };
}

/** The wall time of `instant` in `tz`, a canonical zone name. */
export function zonedFields(instant: number, tz: string): ZonedFields {
  if (tz === 'UTC') return utcFields(instant);
  const fields: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatter(tz).formatToParts(instant)) fields[part.type] = part.value;
  const local: LocalTime = {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
  };
  return { ...local, weekday: new Date(utcOf(local)).getUTCDay() };
}

function wholeSecond(instant: number): number {
  return instant - (((instant % 1_000) + 1_000) % 1_000);
}

/** The offset of `tz` at `instant`: local wall time less UTC, in milliseconds. */
export function offsetAt(instant: number, tz: string): number {
  if (tz === 'UTC') return 0;
  const second = wholeSecond(instant);
  return utcOf(zonedFields(second, tz)) - second;
}

/** The instant of wall time `local` in `tz` (see the module doc for gaps and repeats). */
export function instantOf(local: LocalTime, tz: string): ResolvedInstant {
  const wall = utcOf(local);
  if (tz === 'UTC') return { instant: wall, kind: 'exact' };
  const offsets = [
    ...new Set([offsetAt(wall - DAY_MS, tz), offsetAt(wall, tz), offsetAt(wall + DAY_MS, tz)]),
  ];
  const valid = offsets
    .map((offset) => wall - offset)
    .filter((instant) => utcOf(zonedFields(instant, tz)) === wall)
    .sort((a, b) => a - b);
  const first = valid[0];
  if (first !== undefined) {
    return { instant: first, kind: valid.length > 1 ? 'ambiguous' : 'exact' };
  }
  // In a gap: local time jumps past `wall` at a transition between the
  // largest and the smallest candidate instants. Search it to the second.
  let low = wall - Math.max(...offsets);
  let high = wall - Math.min(...offsets);
  while (high - low > 1_000) {
    const middle = low + Math.floor((high - low) / 2_000) * 1_000;
    if (utcOf(zonedFields(middle, tz)) > wall) high = middle;
    else low = middle;
  }
  return { instant: high, kind: 'gap' };
}
