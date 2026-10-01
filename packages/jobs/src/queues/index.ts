/**
 * Declared queues: per-queue concurrency and retention, the always-present
 * `default` queue, and the `<app>:<environment>` transport namespace.
 */

export {
  DEFAULT_QUEUE,
  DEFAULT_RETENTION,
  defineQueues,
  isQueueName,
  jobsNamespace,
  MAX_QUEUE_CONCURRENCY,
  MAX_RETAINED_JOBS,
  parseDuration,
  type Duration,
  type QueueOptions,
  type QueueSet,
  type RetentionOptions,
} from './queue-set.js';
