/**
 * `schedule(id, call, options)`: the one way to declare a schedule. It binds
 * an id to an inert job call and a repeat (an interval of 1 s to one year,
 * or a cron pattern in an IANA time zone, UTC by default), and checks all of
 * it at once, so a bad schedule fails where it is declared. The declaration
 * is held privately and read by `reconcileSchedules` through
 * {@link scheduleSpecOf}, which the package barrel does not export.
 *
 * A schedule's call takes its job options and tags only: each fire gets its
 * own key and dispatch time. A schedule's `overlap` keys its lease on
 * `schedule:<id>` by default; without one, the definition's own overlap
 * applies.
 */

import type { JobCall } from '../definition/define-job.js';
import { isJobDefinition } from '../definition/define-job.js';
import { JOB_OPTION_KEYS, validJobOptions, validTags } from '../envelope/job-options.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { resolveOverlapOption, type OverlapOption } from '../overlap/overlap-option.js';
import type { JobOptions, ScheduleRepeat } from '../contract/index.js';
import { parseCron } from './cron.js';
import { isScheduleId, isScheduleInterval } from './schedule-spec.js';
import { canonicalTimeZone } from './time-zone.js';

/** How a schedule repeats, and its overlap control. */
export interface ScheduleOptions {
  /** Fire every this many milliseconds (1 s to one year). Exclusive with `cron`. */
  readonly everyMs?: number;
  /** Fire on this cron pattern's occurrences. Exclusive with `everyMs`. */
  readonly cron?: string;
  /** The IANA time zone of `cron`. Defaults to UTC; refused with `everyMs`. */
  readonly timezone?: string;
  /** Never run a fire alongside another run holding the lease key (default `schedule:<id>`). */
  readonly overlap?: true | { readonly key?: string; readonly ttlMs?: number };
}

/** A declared schedule. */
export interface ScheduleDefinition {
  readonly id: string;
  /** The job the schedule runs. */
  readonly name: string;
}

/** What `reconcileSchedules` reads of a declaration. */
export interface ScheduleDeclaration {
  readonly id: string;
  readonly call: JobCall;
  /** The call's own job options, checked; the definition's fill the rest at reconcile. */
  readonly options: JobOptions;
  readonly tags: readonly string[] | undefined;
  readonly repeat: ScheduleRepeat;
  readonly overlap: OverlapOption | undefined;
}

type ScheduleRule =
  | 'shape'
  | 'id'
  | 'call'
  | 'options'
  | 'repeat'
  | 'interval'
  | 'cron'
  | 'cron_extension'
  | 'cron_day_conflict'
  | 'cron_never'
  | 'timezone'
  | 'overlap';

const OPTION_KEYS: ReadonlySet<string> = new Set(['everyMs', 'cron', 'timezone', 'overlap']);
const CALL_OPTION_KEYS: ReadonlySet<string> = new Set([...JOB_OPTION_KEYS, 'tags']);

const declarations = new WeakMap<object, ScheduleDeclaration>();

function invalid(rule: ScheduleRule): Error {
  return new JobsErrors.Error('invalid_schedule', { rule });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface CheckedCall {
  readonly call: JobCall;
  readonly options: JobOptions;
  readonly tags: readonly string[] | undefined;
}

function checkedCall(call: unknown): CheckedCall {
  if (!isRecord(call) || !isJobDefinition(call.definition)) throw invalid('call');
  const options = call.options ?? {};
  if (!isRecord(options)) throw invalid('options');
  const jobOptions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!CALL_OPTION_KEYS.has(key)) throw invalid('options');
    if (key !== 'tags' && value !== undefined) jobOptions[key] = value;
  }
  const checked = validJobOptions(jobOptions);
  const tags = options.tags === undefined ? undefined : validTags(options.tags);
  if (!checked.ok || (options.tags !== undefined && tags === undefined)) {
    throw invalid('options');
  }
  return { call: call as unknown as JobCall, options: checked.options, tags };
}

function checkedRepeat(options: Record<string, unknown>): ScheduleRepeat {
  const { everyMs, cron, timezone } = options;
  if ((everyMs === undefined) === (cron === undefined)) throw invalid('repeat');
  if (everyMs !== undefined) {
    if (!isScheduleInterval(everyMs)) throw invalid('interval');
    if (timezone !== undefined) throw invalid('timezone');
    return Object.freeze({ everyMs });
  }
  const parsed = parseCron(cron);
  if (!parsed.ok) throw invalid(parsed.problem);
  const tz = canonicalTimeZone(timezone ?? 'UTC');
  if (tz === undefined) throw invalid('timezone');
  return Object.freeze({ cron: (cron as string).trim(), tz });
}

function checkedOverlap(value: unknown): OverlapOption | undefined {
  if (isRecord(value) && typeof value.key === 'function') throw invalid('overlap');
  try {
    return resolveOverlapOption(value);
  } catch {
    // The option's own refusal names `overlap` as a job option; a schedule
    // reports it under its own code, with the same bounds in the suggestion.
    throw invalid('overlap');
  }
}

/**
 * Declare a schedule.
 *
 * @throws `jobs.invalid_schedule` naming the rule a part breaks,
 *   `jobs.unknown_option` for an option that is not one.
 */
export function schedule(id: string, call: JobCall, options: ScheduleOptions): ScheduleDefinition {
  if (!isScheduleId(id)) throw invalid('id');
  const checked = checkedCall(call);
  if (!isRecord(options)) throw invalid('shape');
  if (!Object.keys(options).every((key) => OPTION_KEYS.has(key))) {
    throw new JobsErrors.Error('unknown_option');
  }
  const declaration: ScheduleDeclaration = Object.freeze({
    id,
    call: checked.call,
    options: checked.options,
    tags: checked.tags,
    repeat: checkedRepeat(options),
    overlap: checkedOverlap(options.overlap),
  });
  const definition: ScheduleDefinition = Object.freeze({ id, name: checked.call.name });
  declarations.set(definition, declaration);
  return definition;
}

/** Whether `value` is a schedule built by {@link schedule}. */
export function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return typeof value === 'object' && value !== null && declarations.has(value);
}

/**
 * The private declaration of a schedule.
 *
 * @throws `jobs.invalid_schedule` with rule `shape` for a value
 *   {@link schedule} did not build.
 */
export function scheduleSpecOf(definition: ScheduleDefinition): ScheduleDeclaration {
  const declaration = declarations.get(definition);
  if (declaration === undefined) throw invalid('shape');
  return declaration;
}
