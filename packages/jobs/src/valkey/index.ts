/**
 * `@jsails/jobs/valkey`: the shared transport on Valkey through BullMQ.
 * Importing it loads nothing; `bullmq` (an optional peer) is loaded when the
 * app builds the adapter.
 */

export { valkeyJobs, ValkeyJobsAdapter } from './valkey-adapter.js';
export type { ValkeyJobsOptions } from './valkey-options.js';
export type { BullmqModule } from './bullmq-surface.js';
