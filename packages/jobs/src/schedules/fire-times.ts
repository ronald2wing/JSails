/**
 * When a schedule fires and what it enqueues, computed by one implementation
 * for every transport.
 *
 * - `everyMs` fires at `anchor + k * everyMs` for k >= 1;
 * - `cron` fires at its occurrences strictly after the anchor, in its zone.
 *
 * Each fire enqueues the stored envelope with its own key,
 * `schedule:<id>:<fire time>`, and the time it fired as `dispatchedAt`; a
 * fire carries no execution context, since no request or command caused it.
 */

import type { JobEnvelope, ScheduleRepeat } from '../contract/index.js';
import { buildEnvelope } from '../envelope/codec.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { FLOW_KEY_WINDOW_MS, scheduleFireKey } from '../flows/flow-limits.js';
import { nextCronFire, parseCron, type CronSpec } from './cron.js';

const PARSED_CACHE_LIMIT = 1_000;
const parsedPatterns = new Map<string, CronSpec>();

/**
 * The parsed form of `pattern`, cached.
 *
 * @throws `jobs.invalid_schedule` naming the pattern's problem.
 */
export function cronSpecOf(pattern: string): CronSpec {
  const cached = parsedPatterns.get(pattern);
  if (cached !== undefined) return cached;
  const result = parseCron(pattern);
  if (!result.ok) throw new JobsErrors.Error('invalid_schedule', { rule: result.problem });
  if (parsedPatterns.size >= PARSED_CACHE_LIMIT) parsedPatterns.clear();
  parsedPatterns.set(pattern, result.spec);
  return result.spec;
}

/**
 * The first fire time strictly after `after` of a schedule anchored at
 * `anchor`.
 *
 * @throws `jobs.invalid_schedule` for a cron pattern that does not parse.
 */
export function nextFireAfter(repeat: ScheduleRepeat, anchor: number, after: number): number {
  if ('everyMs' in repeat) {
    const { everyMs } = repeat;
    if (after < anchor) return anchor + everyMs;
    return anchor + (Math.floor((after - anchor) / everyMs) + 1) * everyMs;
  }
  return nextCronFire(cronSpecOf(repeat.cron), Math.max(after, anchor), repeat.tz);
}

/** What the fire of a schedule at `slot` enqueues, dispatched at `now`. */
export function firedEnvelope(
  stored: JobEnvelope,
  id: string,
  slot: number,
  now: number,
): JobEnvelope {
  const { tags, overlap } = stored.meta;
  return buildEnvelope({
    name: stored.name,
    payload: stored.payload,
    options: stored.options,
    key: { value: scheduleFireKey(id, slot), windowMs: FLOW_KEY_WINDOW_MS },
    ...(tags === undefined ? {} : { tags }),
    ...(overlap === undefined ? {} : { overlap }),
    dispatchedAt: now,
  });
}

/** Whether two repeats are the same rule. */
export function repeatEquals(a: ScheduleRepeat, b: ScheduleRepeat): boolean {
  if ('everyMs' in a) return 'everyMs' in b && a.everyMs === b.everyMs;
  return 'cron' in b && a.cron === b.cron && a.tz === b.tz;
}
