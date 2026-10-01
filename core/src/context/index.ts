/**
 * `jsails/context`: the execution context, server-only.
 *
 * One ambient, immutable context per unit of work (a request, a job attempt,
 * a static-export render): its span ({@link TraceContext}, W3C Trace Context),
 * its request id, and typed values under keys from {@link createContextKey}.
 * {@link serializeContext} and {@link restoreContext} carry the span, the
 * request id, and every propagated value into a job or another process.
 */

export {
  CONTEXT_CARRIER_VERSION,
  restoreContext,
  serializeContext,
  type ContextCarrier,
} from './carrier.js';
export { ContextErrors } from './context-errors.js';
export {
  contextEntry,
  createContextKey,
  createExecutionContext,
  currentContext,
  extendContext,
  getContext,
  isRequestId,
  runInContext,
  withContext,
  type ContextCodec,
  type ContextEntry,
  type ContextKey,
  type ContextKeyOptions,
  type ContextValues,
  type ExecutionContext,
  type ExecutionContextInit,
} from './execution-context.js';
export {
  childTrace,
  continueTrace,
  createRootTrace,
  formatTraceparent,
  formatTracestate,
  isTraceSampled,
  parseTraceparent,
  parseTracestate,
  TRACE_FLAG_RANDOM,
  TRACE_FLAG_SAMPLED,
  traceFromHeaders,
  traceHeaders,
  type TraceContext,
  type TraceHeaders,
  type TraceParent,
  type TraceStateMember,
} from './trace-context.js';
