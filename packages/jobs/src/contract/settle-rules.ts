/**
 * What every adapter decides the same way when it settles an attempt: which
 * of an outcome's follow-ups it stores, and how long a job it puts back
 * waits. Both run after {@link checkedAttemptOutcome}, on a checked outcome.
 */

import { decodeEnvelope } from '../envelope/codec.js';
import { MAX_JOB_DELAY_MS } from '../envelope/job-options.js';
import { isFinalFailure } from './final-failure.js';
import type { AttemptOutcome, JobFollowUp } from './outcome.js';

/**
 * The decoded follow-ups a settle of `outcome` stores: none for a release or
 * for a failure that is not final (`attemptsMade` failed attempts before this
 * one, of `attempts`), else each follow-up decoded as a current-version
 * envelope on a queue `hasQueue` accepts. `undefined` when one is not: the
 * adapter then applies `PROCESSOR_BROKE_CONTRACT` instead.
 */
export function checkedFollowUps(
  outcome: AttemptOutcome,
  attemptsMade: number,
  attempts: number | undefined,
  hasQueue: (queue: string) => boolean,
): readonly JobFollowUp[] | undefined {
  if (outcome.kind === 'released' || outcome.followUps === undefined) return [];
  if (outcome.kind === 'failed' && !isFinalFailure(attemptsMade, attempts, outcome.retryable)) {
    return [];
  }
  const checked: JobFollowUp[] = [];
  for (const { queue, envelope } of outcome.followUps) {
    const decoded = decodeEnvelope(envelope);
    if (!decoded.ok || !hasQueue(queue)) return undefined;
    checked.push(Object.freeze({ queue, envelope: decoded.envelope }));
  }
  return Object.freeze(checked);
}

/**
 * A wait a transport accepts: a whole number of milliseconds from 0 to one
 * year. A processor's release delay or an envelope's run time is not trusted
 * to be one; a fraction is rounded up so a job never runs early.
 */
export function boundedDelay(ms: number | undefined): number {
  if (ms === undefined || Number.isNaN(ms) || ms <= 0) return 0;
  return Math.min(Math.ceil(ms), MAX_JOB_DELAY_MS);
}
