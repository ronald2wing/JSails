/**
 * The in-memory job transport, for development and tests: process reach,
 * windowed key deduplication, and long-timer delays.
 */

export {
  memoryJobs,
  MemoryJobsAdapter,
  MemoryJobsError,
  type MemoryJobsErrorCode,
  type MemoryJobsOptions,
  type MemoryQueueCounts,
} from './memory-adapter.js';
