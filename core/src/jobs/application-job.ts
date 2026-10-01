/**
 * Base class for class-based jobs.
 *
 * A job class declares a static schema and a typed `handle`; the runtime
 * instantiates it with a {@link JobContext} for each run. The base class exposes
 * the context tools a job actually uses — logging, progress, attempt info, and
 * nested dispatch — without threading `ctx` through every helper.
 *
 * Inheritance is deliberately one thin level: `ApplicationJob` for tools, then
 * the concrete job. Shared business behavior belongs in services or middleware,
 * not in a deep job hierarchy.
 */

import type { z } from 'zod';

import { facade } from '../facades/facade.js';
import { jobsToken } from './plugin.js';
import type { JobClass, JobContext, JobErrorPolicy } from './registry.js';

/** Raised when a job context or static dispatch is misconfigured. Value-free. */
export class JobContextError extends Error {
  readonly code: 'dispatch_unavailable' | 'missing_job_name';

  constructor(code: 'dispatch_unavailable' | 'missing_job_name', message: string) {
    super(message);
    this.name = 'JobContextError';
    this.code = code;
  }
}

/** The base class for class-based jobs. */
export abstract class ApplicationJob<TPayload = unknown> {
  /** Static queue name. The loader falls back to the class/file name. */
  static readonly jobName?: string;
  /** Payload schema. Subclasses must assign a concrete Zod schema. */
  static readonly schema: z.ZodType;
  /** Per-job error policy. */
  static readonly onError?: JobErrorPolicy;

  protected readonly context: JobContext;

  constructor(context: JobContext) {
    this.context = context;
  }

  /** Run the job with a validated payload. */
  abstract handle(payload: TPayload): void | Promise<void>;

  /** Enqueue another job from this worker. */
  static dispatch<TPayload>(
    this: JobClass<TPayload>,
    payload: TPayload,
    opts?: unknown,
  ): Promise<unknown> {
    const name = this.jobName;
    if (name === undefined || name.trim() === '') {
      throw new JobContextError(
        'missing_job_name',
        'static dispatch requires a static jobName on the job class',
      );
    }
    return facade(jobsToken).dispatch(name, payload, opts);
  }

  protected get jobId(): string | undefined {
    return this.context.jobId;
  }

  protected get jobName(): string {
    return this.context.name;
  }

  protected get attemptsMade(): number {
    return this.context.attemptsMade;
  }

  protected get attemptsStarted(): number {
    return this.context.attemptsStarted;
  }

  /** True on the first processing attempt. */
  protected get isFirstAttempt(): boolean {
    return this.context.attemptsMade === 0;
  }

  protected log(message: string): Promise<void> {
    return this.context.log(message);
  }

  protected updateProgress(progress: number | Record<string, unknown>): Promise<void> {
    return this.context.updateProgress(progress);
  }

  protected dispatch<T>(job: JobClass<T>, payload: T, opts?: unknown): Promise<unknown>;
  protected dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown>;
  protected dispatch(
    jobOrName: JobClass<unknown> | string,
    payload: unknown,
    opts?: unknown,
  ): Promise<unknown> {
    const dispatch = this.context.dispatch;
    if (dispatch === undefined) {
      throw new JobContextError(
        'dispatch_unavailable',
        'dispatch is not available in this job context',
      );
    }
    if (typeof jobOrName === 'string') {
      return dispatch(jobOrName, payload, opts);
    }
    const name = jobOrName.jobName;
    if (name === undefined || name.trim() === '') {
      throw new JobContextError(
        'missing_job_name',
        'dispatching a job class requires a static jobName',
      );
    }
    return dispatch(name, payload, opts);
  }
}
