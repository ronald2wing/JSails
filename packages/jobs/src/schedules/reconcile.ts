/**
 * `reconcileSchedules`: make the declared schedules the whole stored set, as
 * a release does, keeping each stored schedule's pause state.
 *
 * It validates everything first (definitions, payloads, repeats, the
 * capabilities a schedule needs), then reads the stored set with its stamp
 * and revision, diffs, and applies the new and changed schedules, the pruned
 * ids and the reconcile stamp in one compare-and-set on that revision. A
 * reconcile that raced another one finds the revision changed, applies
 * nothing, and reads again, so it never prunes from a stale snapshot nor
 * passes the owner check against a stamp that is no longer there. The stamp
 * is written even when nothing changed, so it always shows the last
 * reconcile; a namespace last reconciled by another app is refused unless
 * `adopt` says the takeover is deliberate (an app rename).
 *
 * `pauseSchedules` and `resumeSchedules` change only the stored pause state,
 * which no reconcile touches. A resume skips the fire times missed while
 * paused.
 */

import { createHash } from 'node:crypto';

import {
  requireCapability,
  type JobsAdapter,
  type ScheduleCapability,
  type ScheduleSpec,
  type StoredSchedule,
} from '../contract/index.js';
import { jobSpec } from '../definition/define-job.js';
import { buildEnvelope } from '../envelope/codec.js';
import { isPlainJson } from '../envelope/plain-json.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { overlapFor } from '../overlap/overlap-option.js';
import { systemClock, type JobsClock } from '../timing/long-timer.js';
import {
  isScheduleDefinition,
  scheduleSpecOf,
  type ScheduleDefinition,
} from './define-schedule.js';
import { isScheduleId, MAX_SCHEDULES } from './schedule-spec.js';

/** Options of {@link reconcileSchedules}. */
export interface ReconcileOptions {
  /** The app reconciling, recorded in the stamp and compared with the stored one. */
  readonly app: string;
  /** Who reconciled (a deploy, a host), recorded in the stamp. */
  readonly by: string;
  /** The clock the stamp and the envelopes' dispatch time are read from. Defaults to the system clock. */
  readonly clock?: JobsClock;
  /** Take over a namespace another app reconciled last. */
  readonly adopt?: boolean;
}

/** What a reconcile changed, by schedule id, each list sorted. */
export interface ReconcileResult {
  readonly upserted: readonly string[];
  readonly pruned: readonly string[];
  readonly unchanged: readonly string[];
}

/** How many times a reconcile reads and applies before it gives up on a namespace others keep changing. */
export const MAX_RECONCILE_ROUNDS = 5;

const OPTION_KEYS: ReadonlySet<string> = new Set(['app', 'by', 'clock', 'adopt']);
const STAMP_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON with every object's keys sorted, so equal values serialize equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The parts of a spec that decide what it does: everything but the build time. */
function canonicalSpec(spec: ScheduleSpec): string {
  const { envelope } = spec;
  return canonicalJson({
    id: spec.id,
    queue: spec.queue,
    name: envelope.name,
    payload: envelope.payload,
    options: envelope.options,
    tags: envelope.meta.tags,
    overlap: envelope.meta.overlap,
    repeat: spec.repeat,
  });
}

/** A SHA-256 hex digest of the canonical form of `specs`, whatever their order. */
export function scheduleFingerprint(specs: readonly ScheduleSpec[]): string {
  const canonical = specs.map((spec) => canonicalSpec(spec)).sort();
  return createHash('sha256')
    .update(`[${canonical.join(',')}]`)
    .digest('hex');
}

interface CheckedOptions {
  readonly app: string;
  readonly by: string;
  readonly clock: JobsClock;
  readonly adopt: boolean;
}

function checkedOptions(value: unknown): CheckedOptions {
  if (!isRecord(value)) throw new JobsErrors.Error('invalid_option', { option: 'options' });
  if (!Object.keys(value).every((key) => OPTION_KEYS.has(key))) {
    throw new JobsErrors.Error('unknown_option');
  }
  const { app, by, clock, adopt } = value;
  if (typeof app !== 'string' || !STAMP_NAME.test(app)) {
    throw new JobsErrors.Error('invalid_option', { option: 'app' });
  }
  if (typeof by !== 'string' || !STAMP_NAME.test(by)) {
    throw new JobsErrors.Error('invalid_option', { option: 'by' });
  }
  if (
    clock !== undefined &&
    (!isRecord(clock) || typeof clock.now !== 'function' || typeof clock.setTimer !== 'function')
  ) {
    throw new JobsErrors.Error('invalid_option', { option: 'clock' });
  }
  if (adopt !== undefined && typeof adopt !== 'boolean') {
    throw new JobsErrors.Error('invalid_option', { option: 'adopt' });
  }
  return { app, by, clock: (clock as JobsClock | undefined) ?? systemClock, adopt: adopt === true };
}

function checkedDeclared(declared: unknown): readonly ScheduleDefinition[] {
  if (!Array.isArray(declared)) throw new JobsErrors.Error('invalid_schedule', { rule: 'shape' });
  if (declared.length > MAX_SCHEDULES) {
    throw new JobsErrors.Error('invalid_schedule', { rule: 'too_many' });
  }
  const ids = new Set<string>();
  for (const entry of declared as unknown[]) {
    if (!isScheduleDefinition(entry)) {
      throw new JobsErrors.Error('invalid_schedule', { rule: 'shape' });
    }
    if (ids.has(entry.id)) throw new JobsErrors.Error('duplicate_schedule', { schedule: entry.id });
    ids.add(entry.id);
  }
  return declared as ScheduleDefinition[];
}

/** The stored spec of one declared schedule, its payload validated by the job's schema. */
async function specOf(definition: ScheduleDefinition, now: number): Promise<ScheduleSpec> {
  const { id, call, options, tags, repeat, overlap } = scheduleSpecOf(definition);
  const spec = jobSpec(call.definition);
  if (!isPlainJson(call.payload)) throw new JobsErrors.Error('payload_not_json');
  const snapshot = JSON.parse(JSON.stringify(call.payload)) as unknown;
  const parsed = await spec.schema.safeParseAsync(snapshot);
  if (!parsed.success) throw new JobsErrors.Error('invalid_payload');
  const own = overlap ?? spec.overlap;
  const lease =
    own === undefined
      ? undefined
      : overlapFor(own, overlap === undefined ? spec.name : `schedule:${id}`, parsed.data);
  const envelope = buildEnvelope({
    name: spec.name,
    payload: snapshot,
    options: { ...spec.options, ...options },
    ...(tags === undefined ? {} : { tags }),
    ...(lease === undefined ? {} : { overlap: lease }),
    dispatchedAt: now,
  });
  return Object.freeze({ id, queue: spec.queue, envelope, repeat });
}

/**
 * Make `declared` the whole stored schedule set of `adapter`.
 *
 * @throws (as a rejection) `jobs.capability_missing` without the schedules
 *   capability (or without leases when a schedule has overlap control),
 *   `jobs.invalid_option` or `jobs.unknown_option` for bad options,
 *   `jobs.invalid_schedule` or `jobs.duplicate_schedule` for a bad set,
 *   `jobs.flow_item_refused` naming the first schedule whose call is refused
 *   (its refusal as the cause), `jobs.schedule_owner_mismatch` when
 *   another app reconciled last and `adopt` is not set, and
 *   `jobs.schedule_conflict` when other reconciles changed the set every one
 *   of {@link MAX_RECONCILE_ROUNDS} times this one tried to apply.
 */
export async function reconcileSchedules(
  adapter: Pick<JobsAdapter, 'capabilities'>,
  declared: readonly ScheduleDefinition[],
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const schedules = requireCapability(adapter, 'schedules');
  const { app, by, clock, adopt } = checkedOptions(options);
  const definitions = checkedDeclared(declared);
  const now = clock.now();
  const results = await Promise.allSettled(definitions.map((entry) => specOf(entry, now)));
  const specs: ScheduleSpec[] = [];
  for (const [item, result] of results.entries()) {
    if (result.status === 'rejected') {
      throw new JobsErrors.Error('flow_item_refused', { item }, { cause: result.reason });
    }
    specs.push(result.value);
  }
  if (specs.some((spec) => spec.envelope.meta.overlap !== undefined)) {
    requireCapability(adapter, 'leases');
  }
  const fingerprint = scheduleFingerprint(specs);
  for (let round = 0; round < MAX_RECONCILE_ROUNDS; round += 1) {
    const result = await applyRound(schedules, specs, { app, by, clock, adopt, fingerprint });
    if (result !== undefined) return result;
  }
  throw new JobsErrors.Error('schedule_conflict');
}

/** Read the stored set, check its owner, and apply the diff; `undefined` when the set changed meanwhile. */
async function applyRound(
  schedules: ScheduleCapability,
  specs: readonly ScheduleSpec[],
  options: CheckedOptions & { readonly fingerprint: string },
): Promise<ReconcileResult | undefined> {
  const { app, by, clock, adopt, fingerprint } = options;
  const set = await schedules.read();
  if (set.stamp !== undefined && set.stamp.app !== app && !adopt) {
    throw new JobsErrors.Error('schedule_owner_mismatch');
  }
  const stored = new Map<string, StoredSchedule>(set.schedules.map((entry) => [entry.id, entry]));
  const changed: ScheduleSpec[] = [];
  const unchanged: string[] = [];
  for (const spec of specs) {
    const current = stored.get(spec.id);
    if (current !== undefined && canonicalSpec(current) === canonicalSpec(spec)) {
      unchanged.push(spec.id);
    } else {
      changed.push(spec);
    }
  }
  const declaredIds = new Set(specs.map((spec) => spec.id));
  const pruned = [...stored.keys()].filter((id) => !declaredIds.has(id));
  const applied = await schedules.apply(
    { upsert: changed, remove: pruned, stamp: { app, fingerprint, appliedAt: clock.now(), by } },
    set.revision,
  );
  if (!applied) return undefined;
  return Object.freeze({
    upserted: Object.freeze(changed.map((spec) => spec.id).sort()),
    pruned: Object.freeze(pruned.sort()),
    unchanged: Object.freeze(unchanged.sort()),
  });
}

function checkedIds(ids: unknown): readonly string[] {
  if (!Array.isArray(ids) || !(ids as unknown[]).every((id) => isScheduleId(id))) {
    throw new JobsErrors.Error('invalid_schedule', { rule: 'id' });
  }
  return ids as string[];
}

/**
 * Pause the stored schedules `ids`; unknown ids are ignored.
 *
 * @throws (as a rejection) `jobs.capability_missing` without schedules,
 *   `jobs.invalid_schedule` for an id that is not one.
 */
export async function pauseSchedules(
  adapter: Pick<JobsAdapter, 'capabilities'>,
  ids: readonly string[],
): Promise<void> {
  const schedules = requireCapability(adapter, 'schedules');
  await schedules.setPaused(checkedIds(ids), true);
}

/**
 * Resume the stored schedules `ids`, skipping the fire times they missed;
 * unknown ids are ignored.
 *
 * @throws (as a rejection) `jobs.capability_missing` without schedules,
 *   `jobs.invalid_schedule` for an id that is not one.
 */
export async function resumeSchedules(
  adapter: Pick<JobsAdapter, 'capabilities'>,
  ids: readonly string[],
): Promise<void> {
  const schedules = requireCapability(adapter, 'schedules');
  await schedules.setPaused(checkedIds(ids), false);
}
