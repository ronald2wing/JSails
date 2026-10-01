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
  CommandJobError,
  commandJobPayload,
  defineCommandJob,
  type CommandJobErrorCode,
  type CommandJobOptions,
  type CommandJobRunContext,
  type CommandJobTarget,
} from './command-job.js';
export {
  defineJob,
  isJobDefinition,
  isJobName,
  jobSpec,
  type JobCall,
  type JobContext,
  type JobDefinition,
  type JobDefinitionInput,
  type JobErrorHandler,
  type JobHandler,
  type JobMiddleware,
  type JobSpec,
} from './define-job.js';
export {
  JobDefinitionError,
  JobDispatchError,
  type JobDefinitionErrorCode,
  type JobDispatchErrorCode,
  type JobErrorOptions,
} from './definition-error.js';
export {
  createProducer,
  type JobProducer,
  type Jobs,
  type ProducerOptions,
} from './jobs-service.js';
