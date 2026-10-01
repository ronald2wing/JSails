/**
 * The in-memory job transport, for development and tests: process reach,
 * windowed key deduplication, long-timer delays, the failed-job records, and
 * all four capabilities (batches, failed jobs, schedules with their ticker,
 * and leases).
 */

export {
  memoryJobs,
  MemoryJobsAdapter,
  type MemoryJobsOptions,
  type MemoryQueueCounts,
} from './memory-adapter.js';
