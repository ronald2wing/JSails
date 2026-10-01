/**
 * Job lifecycle event tokens and payload.
 *
 * Four signals — `jobPushed`, `jobCompleted`, `jobFailed`, `jobRetried` —
 * are emitted at well-defined boundaries by the provider-neutral job runtime.
 * Payloads never carry job data or options: name, jobId, attemptsMade, and on
 * failure the final-attempt flag plus a bounded error summary (class, code,
 * truncated message).
 */
import { defineEvent } from '../extensions/interceptors.js';

/**
 * A failure summary: the error's class, its stable `code` when it has one, and
 * its message truncated to {@link MAX_JOB_ERROR_MESSAGE}. Never a stack, a
 * cause chain, or the job payload.
 */
export interface JobErrorSummary {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

/** Upper bound on the message carried by a {@link JobErrorSummary}. */
export const MAX_JOB_ERROR_MESSAGE = 500;

/** Summarize a thrown value for events and logs. */
export function summarizeJobError(error: unknown): JobErrorSummary {
  const name = error instanceof Error ? error.name : 'Error';
  const raw = error instanceof Error ? error.message : String(error);
  const message =
    raw.length > MAX_JOB_ERROR_MESSAGE ? `${raw.slice(0, MAX_JOB_ERROR_MESSAGE)}…` : raw;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? { name, message, code } : { name, message };
}

/** Value-free snapshot of a job lifecycle event. */
export interface JobEventPayload {
  /** The registered job name. */
  readonly name: string;
  /** The provider's job id, when the provider reported one. */
  readonly jobId: string | undefined;
  /** Attempts made so far (failed/retried events only). */
  readonly attemptsMade?: number;
  /** Failed events only: `true` when no further attempt follows. */
  readonly final?: boolean;
  /** Failed events only: why the attempt failed. */
  readonly error?: JobErrorSummary;
}

/** Emitted after a successful `producer.dispatch` inside the runtime. */
export const jobPushed = defineEvent<JobEventPayload>('job.pushed');

/** Emitted after the handler resolves successfully. */
export const jobCompleted = defineEvent<JobEventPayload>('job.completed');

/** Emitted when an attempt fails, before the error is handed back to the transport. */
export const jobFailed = defineEvent<JobEventPayload>('job.failed');

/**
 * Emitted together with `jobFailed` when another attempt will follow (attempts
 * remain and the error is retryable).
 */
export const jobRetried = defineEvent<JobEventPayload>('job.retried');
