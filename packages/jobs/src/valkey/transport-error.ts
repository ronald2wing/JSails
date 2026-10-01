/**
 * The value-free face of a transport failure. A BullMQ or ioredis error
 * message can quote a key, a job id or a server reply, so an error that
 * leaves the Valkey transport is either already a framework error (a
 * `jobs.*` refusal, the connection provider's `valkey` errors, all
 * value-free) or `jobs.transport_failed`, which keeps the original only as
 * its cause, never in its message.
 */

import { isJsailsError } from 'jsails/errors';

import { JobsErrors } from '../errors/jobs-errors.js';

/** `error` when it is a framework error, else `jobs.transport_failed` caused by it. */
export function transportError(error: unknown): Error {
  if (isJsailsError(error)) return error;
  return new JobsErrors.Error('transport_failed', undefined, { cause: error });
}

/** Run `operation`, turning any failure into {@link transportError}. */
export async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw transportError(error);
  }
}
