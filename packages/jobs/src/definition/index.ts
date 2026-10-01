/**
 * Job definitions and dispatch: `defineJob` and its inert typed `JobCall`,
 * `defineCommandJob`, the job catalog that checks definitions against the
 * declared queues, and the `Jobs` service with its producer.
 *
 * `jobSpec` (the private half of a definition) is exported here for the
 * package's own runtime and is deliberately absent from the package barrel.
 */

export { createJobCatalog, type JobCatalog } from './catalog.js';
export {
  commandJobPayload,
  defineCommandJob,
  type CommandJobOptions,
  type CommandJobTarget,
} from './command-job.js';
export {
  defineJob,
  isJobDefinition,
  jobSpec,
  type JobActor,
  type JobCall,
  type JobContext,
  type JobDefinition,
  type JobDefinitionInput,
  type JobErrorHandler,
  type JobFlowPosition,
  type JobHandler,
  type JobMeta,
  type JobMiddleware,
  type JobSpec,
} from './define-job.js';
export {
  createProducer,
  type BatchHandle,
  type BatchOptions,
  type ChainHandle,
  type ChainOptions,
  type JobProducer,
  type Jobs,
  type ProducerOptions,
} from './jobs-service.js';
