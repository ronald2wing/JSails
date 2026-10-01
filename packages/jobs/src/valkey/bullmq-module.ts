/**
 * The one place BullMQ is loaded.
 *
 * `bullmq` is an optional peer: an app that never selects the Valkey
 * transport does not install it, and importing `@jsails/jobs/valkey` loads
 * nothing. {@link loadBullmq} imports it when an adapter is built and turns
 * its absence into a value-free `jobs.missing_dependency`. The real module is
 * mapped onto the transport's own `BullmqModule` interface here, so the
 * compiler checks every call against BullMQ's own types. This module is
 * internal: its declaration names BullMQ's types, which no public
 * declaration may reach.
 */

import type * as Bullmq from 'bullmq';

import { JobsErrors } from '../errors/jobs-errors.js';
import type {
  BullConnectionOptions,
  BullFlowProducer,
  BullmqModule,
  BullProcessor,
  BullQueue,
  BullWorker,
  BullWorkerOptions,
  BullJob,
} from './bullmq-surface.js';

function mapped(module: typeof Bullmq): BullmqModule {
  return Object.freeze({
    createQueue: (name: string, options: BullConnectionOptions): BullQueue => {
      const queue = new module.Queue(name, {
        connection: options.connection,
        prefix: options.prefix,
      });
      return {
        add: (jobName, data, jobOptions) => queue.add(jobName, data, { ...jobOptions }),
        getJob: (id) => queue.getJob(id),
        waitUntilReady: () => queue.waitUntilReady(),
        close: () => queue.close(),
        on: (event, listener) => queue.on(event, listener),
      };
    },
    createWorker: (
      name: string,
      processor: BullProcessor,
      options: BullWorkerOptions,
    ): BullWorker => {
      const worker = new module.Worker(name, (job, token) => processor(job, token), {
        connection: options.connection,
        prefix: options.prefix,
        concurrency: options.concurrency,
        lockDuration: options.lockDuration,
        stalledInterval: options.stalledInterval,
        maxStalledCount: options.maxStalledCount,
        settings: {
          backoffStrategy: (attemptsMade, type, error, job) =>
            options.settings.backoffStrategy(attemptsMade, type, error, job),
        },
      });
      const wrapped: BullWorker = {
        waitUntilReady: () => worker.waitUntilReady(),
        close: (force) => worker.close(force),
        on: (event: 'error' | 'completed' | 'failed', listener: (value: never) => void) => {
          if (event === 'error') worker.on('error', listener as (error: Error) => void);
          else if (event === 'completed')
            worker.on('completed', listener as (job: BullJob) => void);
          else worker.on('failed', listener as (job: BullJob | undefined) => void);
          return wrapped;
        },
      };
      return wrapped;
    },
    createFlowProducer: (options: BullConnectionOptions): BullFlowProducer => {
      const producer = new module.FlowProducer({
        connection: options.connection,
        prefix: options.prefix,
      });
      return {
        addBulk: async (jobs) => {
          const added: readonly unknown[] | undefined = await producer.addBulk(
            jobs.map((job) => ({
              name: job.name,
              queueName: job.queueName,
              data: job.data,
              opts: { ...job.opts },
            })),
          );
          // A closing producer (the adapter is closing) adds nothing and
          // resolves undefined, which the caller must not take for stored.
          if (added === undefined) throw new JobsErrors.Error('adapter_closed');
        },
        waitUntilReady: () => producer.waitUntilReady(),
        close: () => producer.close(),
        on: (event, listener) => producer.on(event, listener),
      };
    },
    unrecoverable: (message: string): Error => new module.UnrecoverableError(message),
    waiting: (): Error => new module.WaitingError(),
    delayed: (): Error => new module.DelayedError(),
  });
}

function isModuleNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
    typeof message === 'string' &&
    message.includes("'bullmq'")
  );
}

/**
 * Import BullMQ (through `importModule`, a test seam).
 *
 * @throws (as a rejection) `jobs.missing_dependency` naming `bullmq` when it
 *   is not installed; a failure inside an installed BullMQ (one of its own
 *   dependencies missing included) propagates as is.
 */
export async function loadBullmq(
  importModule: () => Promise<typeof Bullmq> = () => import('bullmq'),
): Promise<BullmqModule> {
  try {
    return mapped(await importModule());
  } catch (error) {
    if (isModuleNotFound(error)) {
      throw new JobsErrors.Error('missing_dependency', { dependency: 'bullmq' });
    }
    throw error;
  }
}
