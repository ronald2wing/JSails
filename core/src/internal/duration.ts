/**
 * Human-readable duration parsing.
 *
 * Accepts a single number + unit (`'1.5h'`, `'2 days'`, `'100ms'`) and returns
 * milliseconds, or `undefined` for anything that does not match. A missing unit
 * means milliseconds, matching `ms`.
 */

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  msec: 1,
  msecs: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
  // 365.25 days, the `ms` convention.
  y: 31_557_600_000,
  yr: 31_557_600_000,
  yrs: 31_557_600_000,
  year: 31_557_600_000,
  years: 31_557_600_000,
};

const DURATION_RE = /^(-?(?:\d+)?\.?\d+)\s*([a-z]+)?$/i;

/** Parse a single-value duration string into milliseconds. */
export function parseDurationMs(input: string): number | undefined {
  const match = DURATION_RE.exec(input.trim());
  if (match === null) return undefined;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;

  const unit = match[2]?.toLowerCase() ?? 'ms';
  const factor = UNIT_MS[unit];
  return factor === undefined ? undefined : value * factor;
}
