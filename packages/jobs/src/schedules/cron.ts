/**
 * Cron patterns: a strict parser and the evaluator every transport fires
 * schedules with.
 *
 * The grammar is the five classic fields (minute, hour, day of month, month,
 * day of week) with an optional leading seconds field, month and weekday
 * names (three letters, any case), ranges, steps (a `/n` after `*`, a range
 * or a start value), lists, `?` in the two day fields, weekday 7 as Sunday, and the lower-case
 * `@` aliases. Three things are refused rather than guessed at, because they
 * are where cron implementations disagree:
 *
 * - the `L`, `W`, `#` and `H` extensions (`cron_extension`);
 * - a pattern that restricts both day of month and day of week, which some
 *   implementations match as either and others as both (`cron_day_conflict`);
 * - a pattern that never fires within eight years, such as 30 February
 *   (`cron_never`); 29 February is kept.
 *
 * {@link nextCronFire} finds the first fire strictly after an instant: the
 * next matching wall time in the schedule's zone, searched field by field,
 * then resolved to an instant (a wall time in a daylight-saving gap fires at
 * the gap's end; one that occurs twice fires once, at its first occurrence).
 */

import { JobsErrors } from '../errors/jobs-errors.js';
import { instantOf, utcFields, utcOf, zonedFields, type LocalTime } from './time-zone.js';

/** A parsed pattern: the matching values of each field, ascending. */
export interface CronSpec {
  readonly seconds: readonly number[];
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: readonly number[];
  readonly months: readonly number[];
  /** 0 (Sunday) to 6. */
  readonly weekdays: readonly number[];
  /** Which day field the pattern restricts; at most one may be. */
  readonly dayRestricted: 'month' | 'week' | 'none';
}

/** Why a pattern was refused. */
export type CronProblem = 'cron' | 'cron_extension' | 'cron_day_conflict' | 'cron_never';

/** What {@link parseCron} found. */
export type ParsedCron =
  | { readonly ok: true; readonly spec: CronSpec }
  | { readonly ok: false; readonly problem: CronProblem };

/** The longest pattern accepted. */
export const MAX_CRON_LENGTH = 256;

/** How far ahead a pattern must fire, in years. */
export const CRON_HORIZON_YEARS = 8;

const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '@yearly': '0 0 0 1 1 *',
  '@annually': '0 0 0 1 1 *',
  '@monthly': '0 0 0 1 * *',
  '@weekly': '0 0 0 * * 0',
  '@daily': '0 0 0 * * *',
  '@hourly': '0 0 * * * *',
  '@minutely': '0 * * * * *',
  '@secondly': '* * * * * *',
  '@weekdays': '0 0 0 * * 1-5',
  '@weekends': '0 0 0 * * 0,6',
});

const MONTH_NAMES: Readonly<Record<string, number>> = Object.freeze({
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
});

const DAY_NAMES: Readonly<Record<string, number>> = Object.freeze({
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
});

interface FieldRule {
  readonly min: number;
  readonly max: number;
  readonly names?: Readonly<Record<string, number>>;
  /** Whether `?` may stand for "any". */
  readonly day?: true;
}

/** Seconds, minutes, hours, day of month, month, day of week. */
const FIELDS: readonly FieldRule[] = [
  { min: 0, max: 59 },
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31, day: true },
  { min: 1, max: 12, names: MONTH_NAMES },
  { min: 0, max: 7, names: DAY_NAMES, day: true },
];

const INTEGER = /^\d{1,4}$/;
const EXTENSION_TOKEN = /^[lwh]+$/i;

type FieldResult =
  | { readonly ok: true; readonly values: readonly number[] }
  | { readonly ok: false; readonly problem: CronProblem };

function fail(problem: CronProblem): { readonly ok: false; readonly problem: CronProblem } {
  return { ok: false, problem };
}

/** The values of one list item (`*`, `?`, `n`, `a-b`, each with an optional `/step`), or `undefined`. */
function itemValues(item: string, rule: FieldRule): number[] | undefined {
  const parts = item.split('/');
  if (parts.length > 2) return undefined;
  const [range = '', stepText] = parts;
  let step = 1;
  if (stepText !== undefined) {
    if (!INTEGER.test(stepText) || Number(stepText) < 1) return undefined;
    step = Number(stepText);
  }
  let low: number;
  let high: number;
  if (range === '*' || (range === '?' && rule.day === true)) {
    low = rule.min;
    high = rule.max;
  } else {
    const bounds = range.split('-');
    if (bounds.length > 2 || !bounds.every((bound) => INTEGER.test(bound))) return undefined;
    low = Number(bounds[0]);
    high = bounds.length === 2 ? Number(bounds[1]) : stepText === undefined ? low : rule.max;
    if (low < rule.min || high > rule.max || low > high) return undefined;
  }
  const values: number[] = [];
  for (let value = low; value <= high; value += step) values.push(value);
  return values;
}

function parseField(text: string, rule: FieldRule): FieldResult {
  let problem: CronProblem | undefined;
  const resolved = text.replace(/[a-z]+/gi, (token) => {
    const named = rule.names?.[token.toLowerCase()];
    if (named !== undefined) return String(named);
    problem ??= EXTENSION_TOKEN.test(token) ? 'cron_extension' : 'cron';
    return token;
  });
  if (problem !== undefined) return fail(problem);
  if (resolved.includes('#')) return fail('cron_extension');
  const values = new Set<number>();
  for (const item of resolved.split(',')) {
    const itemSet = itemValues(item, rule);
    if (itemSet === undefined) return fail('cron');
    // Weekday 7 is Sunday.
    for (const value of itemSet) values.add(rule.max === 7 && value === 7 ? 0 : value);
  }
  return { ok: true, values: [...values].sort((a, b) => a - b) };
}

/** The first value of ascending `values` that is at least `from`. */
function atLeast(values: readonly number[], from: number): number | undefined {
  return values.find((value) => value >= from);
}

function daysInMonth(year: number, month: number): number {
  return new Date(
    utcOf({ year, month: month + 1, day: 0, hour: 0, minute: 0, second: 0 }),
  ).getUTCDate();
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (spec.dayRestricted !== 'week') return spec.days.includes(day);
  const weekday = new Date(utcOf({ year, month, day, hour: 0, minute: 0, second: 0 })).getUTCDay();
  return spec.weekdays.includes(weekday);
}

/**
 * The first wall time at or after `start` that `spec` matches, searching up
 * to the end of `lastYear`; `undefined` when there is none.
 */
export function nextLocalMatch(
  spec: CronSpec,
  start: LocalTime,
  lastYear: number,
): LocalTime | undefined {
  let { year, month, day, hour, minute, second } = start;
  const nextDay = (): void => {
    day += 1;
    hour = 0;
    minute = 0;
    second = 0;
  };
  while (year <= lastYear) {
    const nextMonth = atLeast(spec.months, month);
    if (nextMonth === undefined) {
      year += 1;
      month = 1;
      day = 1;
      hour = 0;
      minute = 0;
      second = 0;
      continue;
    }
    if (nextMonth !== month) {
      month = nextMonth;
      day = 1;
      hour = 0;
      minute = 0;
      second = 0;
    }
    if (day > daysInMonth(year, month)) {
      month += 1;
      day = 1;
      hour = 0;
      minute = 0;
      second = 0;
      continue;
    }
    if (!dayMatches(spec, year, month, day)) {
      nextDay();
      continue;
    }
    const nextHour = atLeast(spec.hours, hour);
    if (nextHour === undefined) {
      nextDay();
      continue;
    }
    if (nextHour !== hour) {
      hour = nextHour;
      minute = 0;
      second = 0;
    }
    const nextMinute = atLeast(spec.minutes, minute);
    if (nextMinute === undefined) {
      hour += 1;
      minute = 0;
      second = 0;
      if (hour > 23) nextDay();
      continue;
    }
    if (nextMinute !== minute) {
      minute = nextMinute;
      second = 0;
    }
    const nextSecond = atLeast(spec.seconds, second);
    if (nextSecond === undefined) {
      minute += 1;
      second = 0;
      if (minute > 59) {
        minute = 0;
        hour += 1;
        if (hour > 23) nextDay();
      }
      continue;
    }
    return { year, month, day, hour, minute, second: nextSecond };
  }
  return undefined;
}

const NEVER_PROBE: LocalTime = { year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0 };

/** Parse a cron pattern strictly. Never throws. */
export function parseCron(pattern: unknown): ParsedCron {
  if (typeof pattern !== 'string' || pattern.length > MAX_CRON_LENGTH) return fail('cron');
  const trimmed = pattern.trim();
  const expanded = trimmed.startsWith('@') ? ALIASES[trimmed] : trimmed;
  if (expanded === undefined) return fail('cron');
  const texts = expanded.split(/\s+/);
  if (texts.length === 5) texts.unshift('0');
  if (texts.length !== FIELDS.length) return fail('cron');
  const values: (readonly number[])[] = [];
  for (const [index, rule] of FIELDS.entries()) {
    const parsed = parseField(texts[index]!, rule);
    if (!parsed.ok) return parsed;
    values.push(parsed.values);
  }
  const unrestricted = (text: string): boolean => text === '*' || text === '?';
  const monthDays = !unrestricted(texts[3]!);
  const weekDays = !unrestricted(texts[5]!);
  if (monthDays && weekDays) return fail('cron_day_conflict');
  const spec: CronSpec = Object.freeze({
    seconds: values[0]!,
    minutes: values[1]!,
    hours: values[2]!,
    days: values[3]!,
    months: values[4]!,
    weekdays: values[5]!,
    dayRestricted: monthDays ? 'month' : weekDays ? 'week' : 'none',
  });
  if (nextLocalMatch(spec, NEVER_PROBE, NEVER_PROBE.year + CRON_HORIZON_YEARS) === undefined) {
    return fail('cron_never');
  }
  return { ok: true, spec };
}

/**
 * The first fire of `spec` strictly after `afterMs`, in canonical zone `tz`.
 *
 * @throws `jobs.invalid_schedule` with rule `cron_never` when none falls
 *   within eight years (unreachable for a pattern {@link parseCron} accepted).
 */
export function nextCronFire(spec: CronSpec, afterMs: number, tz: string): number {
  const from = afterMs - (((afterMs % 1_000) + 1_000) % 1_000) + 1_000;
  let local: LocalTime = zonedFields(from, tz);
  const lastYear = local.year + CRON_HORIZON_YEARS;
  for (;;) {
    const wall = nextLocalMatch(spec, local, lastYear);
    if (wall === undefined) {
      throw new JobsErrors.Error('invalid_schedule', { rule: 'cron_never' });
    }
    const { instant } = instantOf(wall, tz);
    if (instant > afterMs) return instant;
    // The first pass of a repeated hour, or a gap mapped back: go on past it.
    local = utcFields(utcOf(wall) + 1_000);
  }
}
