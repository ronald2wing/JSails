/**
 * The check every adapter runs on what a processor resolved with, before it
 * applies the outcome or stores any part of it.
 *
 * A processor is total by contract, but an adapter does not trust that: an
 * outcome kind it does not know would leave the job neither waiting nor
 * settled, lost to every worker, and a summary with an extra field or an
 * unbounded stack would be stored as given. {@link checkedAttemptOutcome}
 * returns a frozen copy that carries only the known fields of a well-formed
 * outcome, so a processor can neither smuggle extra data into the failure
 * record nor change it after the adapter took it, and maps anything else to
 * {@link PROCESSOR_BROKE_CONTRACT}. Follow-ups are checked for their shape
 * and copied through JSON here; decoding each envelope and checking its queue
 * is the adapter's, as for an enqueue.
 */

import { isJobErrorSummary, runtimeSummary } from '../errors/error-summary.js';
import type { AttemptOutcome, JobErrorSummary, JobFollowUp } from './outcome.js';

/** The outcome of an attempt whose processor threw or resolved with a non-outcome: retried. */
export const PROCESSOR_BROKE_CONTRACT: AttemptOutcome = Object.freeze({
  kind: 'failed',
  error: runtimeSummary('processor_broke_contract'),
  retryable: true,
});

/** The most follow-ups one outcome carries: a batch finalizer's decided callback and `finally`. */
export const MAX_FOLLOW_UPS = 2;

const RELEASE_REASONS: ReadonlySet<string> = new Set(['shutdown', 'rate_limited', 'unknown_job']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An optional outcome flag: absent, or exactly `true`. */
function isFlag(value: unknown): value is true | undefined {
  return value === undefined || value === true;
}

/** A frozen copy of a checked summary, its known fields only. */
function summaryCopy(summary: JobErrorSummary): JobErrorSummary {
  return Object.freeze({
    ...(summary.code === undefined ? {} : { code: summary.code }),
    kind: summary.kind,
    name: summary.name,
    ...(summary.stack === undefined ? {} : { stack: summary.stack }),
    ...(summary.message === undefined ? {} : { message: summary.message }),
  });
}

/**
 * `{}` without follow-ups, `{ followUps }` with a frozen copy of 1 to
 * {@link MAX_FOLLOW_UPS} of them, each a queue name and an envelope copied
 * through JSON so the processor keeps no reference into it, or `undefined`
 * for anything else.
 */
function followUpsCopy(
  value: unknown,
): { readonly followUps?: readonly JobFollowUp[] } | undefined {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FOLLOW_UPS) {
    return undefined;
  }
  const copies: JobFollowUp[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry) || typeof entry.queue !== 'string' || !isRecord(entry.envelope)) {
      return undefined;
    }
    const envelope = JSON.parse(JSON.stringify(entry.envelope)) as JobFollowUp['envelope'];
    copies.push(Object.freeze({ queue: entry.queue, envelope }));
  }
  return { followUps: Object.freeze(copies) };
}

function checked(value: unknown): AttemptOutcome | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case 'completed': {
      const followUps = followUpsCopy(value.followUps);
      return followUps === undefined
        ? undefined
        : Object.freeze({ kind: 'completed', ...followUps });
    }
    case 'discarded': {
      const followUps = followUpsCopy(value.followUps);
      return isJobErrorSummary(value.error) && followUps !== undefined
        ? Object.freeze({ kind: 'discarded', error: summaryCopy(value.error), ...followUps })
        : undefined;
    }
    case 'failed': {
      const { error, retryable, catchFired, drop } = value;
      if (!isJobErrorSummary(error) || typeof retryable !== 'boolean') return undefined;
      if (!isFlag(catchFired) || !isFlag(drop)) return undefined;
      const followUps = followUpsCopy(value.followUps);
      // The flag says the follow-ups hold the catch, so it never comes without them.
      if (followUps === undefined || (catchFired === true && followUps.followUps === undefined)) {
        return undefined;
      }
      return Object.freeze({
        kind: 'failed',
        error: summaryCopy(error),
        retryable,
        ...(catchFired === true ? { catchFired } : {}),
        ...(drop === true ? { drop } : {}),
        ...followUps,
      });
    }
    case 'skipped': {
      const followUps = followUpsCopy(value.followUps);
      return value.reason === 'overlap' && followUps !== undefined
        ? Object.freeze({ kind: 'skipped', reason: 'overlap', ...followUps })
        : undefined;
    }
    case 'released': {
      const { reason, delayMs } = value;
      if (typeof reason !== 'string' || !RELEASE_REASONS.has(reason)) return undefined;
      if (delayMs !== undefined && (typeof delayMs !== 'number' || !Number.isFinite(delayMs))) {
        return undefined;
      }
      return Object.freeze({
        kind: 'released',
        reason: reason as 'shutdown' | 'rate_limited' | 'unknown_job',
        ...(delayMs === undefined ? {} : { delayMs }),
      });
    }
    default:
      return undefined;
  }
}

/**
 * A frozen, field-checked copy of `value`, or {@link PROCESSOR_BROKE_CONTRACT}
 * when it is not a well-formed attempt outcome. Never throws.
 */
export function checkedAttemptOutcome(value: unknown): AttemptOutcome {
  try {
    return checked(value) ?? PROCESSOR_BROKE_CONTRACT;
  } catch {
    // A getter or proxy that throws while the outcome is read is no outcome.
    return PROCESSOR_BROKE_CONTRACT;
  }
}
