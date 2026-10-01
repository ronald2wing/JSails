/**
 * Chains and batches: their bounds and keys, the chain advance and catch the
 * processor builds as follow-ups when a step settles, and the built-in batch
 * finalizer.
 *
 * The bounds and `BATCH_FINALIZER_JOB` reach the package barrel; the flow
 * actions, `withCatchFired` and the key builders are exported here for the
 * package's own runtime and adapters only.
 */

export {
  BATCH_FINALIZER_JOB,
  decodeFinalizerPayload,
  FINALIZER_OPTIONS,
  finalizerEnvelope,
  runBatchFinalizer,
  type FinalizerInput,
  type FinalizerPayload,
} from './batch-finalizer.js';
export {
  chainAdvance,
  chainCatch,
  chainQueuesDeclared,
  stepEnvelope,
  stepFollowUp,
  withCatchFired,
  type StepParts,
} from './chain-advance.js';
export {
  BATCH_STATUS_RETENTION_MS,
  batchCallbackKey,
  batchChildKey,
  chainCatchKey,
  chainStepKey,
  FLOW_KEY_WINDOW_MS,
  isFlowId,
  isReservedKey,
  MAX_BATCH_ITEMS,
  MAX_CHAIN_STEPS,
  MAX_CHILD_FAILURES,
  MAX_CHUNKED_BATCH_ITEMS,
  MAX_FLOW_BYTES,
  RESERVED_JOB_PREFIX,
  RESERVED_KEY_PREFIX,
  scheduleFireKey,
} from './flow-limits.js';
