/**
 * The bounds of a schedule and the check a transport runs on a
 * {@link ScheduleSpec} before it stores one, so the memory adapter and a
 * shared transport refuse the same specs: a schedule id, a declared queue,
 * an envelope with no key, flow, run time or context (each fire adds its
 * own), and a repeat that is an interval of 1 s to one year or a cron
 * pattern that parses, in a canonical zone; and the check of a whole
 * `ScheduleChange` (its specs, removed ids and reconcile stamp) a
 * transport runs before its compare-and-set apply writes anything.
 */

import type { ReconcileStamp, ScheduleRepeat, ScheduleSpec } from '../contract/index.js';
import { decodeEnvelope } from '../envelope/codec.js';
import { isJobName, MAX_JOB_DELAY_MS } from '../envelope/job-options.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { cronSpecOf } from './fire-times.js';
import { canonicalTimeZone } from './time-zone.js';

/** The most schedules an app may declare. */
export const MAX_SCHEDULES = 1_000;
/** The shortest schedule interval. */
export const MIN_SCHEDULE_INTERVAL_MS = 1_000;

type ScheduleRule = 'shape' | 'id' | 'repeat' | 'interval' | 'timezone';

function invalid(rule: ScheduleRule): Error {
  return new JobsErrors.Error('invalid_schedule', { rule });
}

/** Whether `value` is a schedule id: shaped like a job name, at most 128 characters. */
export function isScheduleId(value: unknown): value is string {
  return isJobName(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is an interval a schedule may repeat at. */
export function isScheduleInterval(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_SCHEDULE_INTERVAL_MS &&
    value <= MAX_JOB_DELAY_MS
  );
}

function checkedRepeat(value: unknown): ScheduleRepeat {
  if (!isRecord(value)) throw invalid('repeat');
  const keys = Object.keys(value).sort().join(',');
  if (keys === 'everyMs') {
    if (!isScheduleInterval(value.everyMs)) throw invalid('interval');
    return Object.freeze({ everyMs: value.everyMs });
  }
  if (keys !== 'cron,tz' || typeof value.cron !== 'string') throw invalid('repeat');
  cronSpecOf(value.cron);
  if (typeof value.tz !== 'string' || canonicalTimeZone(value.tz) !== value.tz) {
    throw invalid('timezone');
  }
  return Object.freeze({ cron: value.cron, tz: value.tz });
}

/**
 * A frozen copy of `value` when it is a spec a transport may store.
 *
 * @throws `jobs.unknown_queue` for a queue `hasQueue` refuses;
 *   `jobs.invalid_schedule` naming the rule for anything else malformed.
 */
export function checkedScheduleSpec(
  value: unknown,
  hasQueue: (queue: string) => boolean,
): ScheduleSpec {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'envelope,id,queue,repeat') {
    throw invalid('shape');
  }
  if (!isScheduleId(value.id)) throw invalid('id');
  if (typeof value.queue !== 'string' || !hasQueue(value.queue)) {
    throw new JobsErrors.Error('unknown_queue');
  }
  const decoded = decodeEnvelope(value.envelope);
  if (!decoded.ok) throw invalid('shape');
  const { meta } = decoded.envelope;
  if (
    meta.key !== undefined ||
    meta.flow !== undefined ||
    meta.runAt !== undefined ||
    meta.context !== undefined
  ) {
    throw invalid('shape');
  }
  return Object.freeze({
    id: value.id,
    queue: value.queue,
    envelope: decoded.envelope,
    repeat: checkedRepeat(value.repeat),
  });
}

/** A checked `ScheduleChange`. */
export interface CheckedScheduleChange {
  readonly specs: readonly ScheduleSpec[];
  readonly removed: readonly string[];
  readonly stamp: ReconcileStamp;
}

function isStampText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function checkedStamp(value: unknown): ReconcileStamp {
  if (!isRecord(value)) throw invalid('shape');
  const { app, fingerprint, appliedAt, by } = value;
  if (!isStampText(app) || !isStampText(fingerprint) || !isStampText(by)) throw invalid('shape');
  if (typeof appliedAt !== 'number' || !Number.isSafeInteger(appliedAt) || appliedAt < 0) {
    throw invalid('shape');
  }
  return Object.freeze({ app, fingerprint, appliedAt, by });
}

/**
 * `ids` when it is an array of schedule ids.
 *
 * @throws `jobs.invalid_schedule` naming `id`.
 */
export function checkedScheduleIds(ids: unknown): readonly string[] {
  if (!Array.isArray(ids) || !(ids as unknown[]).every((id) => isScheduleId(id))) {
    throw invalid('id');
  }
  return ids as string[];
}

/**
 * Check a whole change and its expected revision before a transport writes
 * any of it: every spec ({@link checkedScheduleSpec}), the removed ids, the
 * stamp, each id once, and no id both upserted and removed. Whether the set
 * would then hold more than {@link MAX_SCHEDULES} depends on what is stored,
 * so the transport checks that itself.
 *
 * @throws `jobs.unknown_queue` for a spec on a queue `hasQueue` refuses;
 *   `jobs.invalid_schedule` naming the rule for anything else malformed.
 */
export function checkedScheduleChange(
  change: unknown,
  expectedRevision: unknown,
  hasQueue: (queue: string) => boolean,
): CheckedScheduleChange {
  if (!isRecord(change) || !Array.isArray(change.upsert)) throw invalid('shape');
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision)) {
    throw invalid('shape');
  }
  const specs = (change.upsert as unknown[]).map((spec) => checkedScheduleSpec(spec, hasQueue));
  const removed = checkedScheduleIds(change.remove);
  const stamp = checkedStamp(change.stamp);
  const ids = new Set(specs.map((spec) => spec.id));
  if (ids.size !== specs.length || removed.some((id) => ids.has(id))) throw invalid('shape');
  return { specs, removed, stamp };
}
