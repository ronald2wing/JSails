/**
 * The failure record the Valkey transport stores as a BullMQ job's
 * `failedReason`: `{"v":1,"name":<job name>,"error":<JobErrorSummary>}`.
 *
 * BullMQ keeps the reason on the job and, for a batch child, in its
 * finalizer's record of failed children, which outlives the child (a dropped
 * child, a child evicted by retention), so the record carries the job name a
 * batch's failure list reports. The summary is the checked, value-free one
 * the outcome carried; the thrown error has no stack, so BullMQ's stack list
 * stays empty. A reason this transport did not write (a job failed by
 * another BullMQ client on the same keys) reads as a `jobs.transport_failed`
 * summary, never as its text.
 */

import type { JobErrorSummary } from '../contract/index.js';
import { isJobErrorSummary, runtimeSummary } from '../errors/error-summary.js';

const RECORD_VERSION = 1;

/** A decoded failure record. */
export interface FailureRecord {
  /** The job's name, or `undefined` for a failure BullMQ recorded itself. */
  readonly name: string | undefined;
  readonly error: JobErrorSummary;
}

/** The `failedReason` of a failure of job `name`. */
export function encodeFailure(name: string, error: JobErrorSummary): string {
  return JSON.stringify({ v: RECORD_VERSION, name, error });
}

/** `error` with its stack cleared, so BullMQ keeps none of it when the processor throws it. */
export function stackless(error: Error): Error {
  error.stack = '';
  return error;
}

function parsed(reason: string): unknown {
  try {
    return JSON.parse(reason) as unknown;
  } catch {
    // Not a record this transport wrote: a failure BullMQ stored itself.
    return undefined;
  }
}

/** Read a stored `failedReason`. Never throws. */
export function decodeFailure(reason: unknown): FailureRecord {
  if (typeof reason === 'string') {
    const value = parsed(reason);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (
        record.v === RECORD_VERSION &&
        typeof record.name === 'string' &&
        isJobErrorSummary(record.error)
      ) {
        return Object.freeze({ name: record.name, error: record.error });
      }
    }
  }
  return Object.freeze({
    name: undefined,
    error: runtimeSummary('transport_failed'),
  });
}
