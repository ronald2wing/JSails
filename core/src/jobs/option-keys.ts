/**
 * The reserved dispatch-option keys: the `__jsails*` entries the framework
 * writes into a job's dispatch options to carry its own descriptors next to
 * the transport options (chain, batch, overlap, tags, execution context,
 * schedule description).
 *
 * They live in a leaf module of their own, importing nothing, because their
 * readers are spread across layers that should not load one another: the
 * dispatch allowlist (`queue.ts`), the failed-job history and the
 * `queue:failed` command read the chain and batch keys, and the transport
 * adapters read the overlap and description keys, none of which needs the
 * middleware, scheduler, or runtime that defines what the descriptors mean.
 */

/** Reserved dispatch-option key that carries the chain descriptor. */
export const CHAIN_OPTION_KEY = '__jsailsChain';

/** Reserved dispatch-option key that carries the batch descriptor. */
export const BATCH_OPTION_KEY = '__jsailsBatch';

/** Reserved dispatch-option key carrying the resolved overlap descriptor. */
export const OVERLAP_OPTION_KEY = '__jsailsOverlap';

/**
 * Reserved dispatch-option key carrying a job's monitoring tags. The dispatch
 * allowlist forwards the value verbatim; the worker-side reader normalizes it.
 */
export const TAG_OPTION_KEY = '__jsailsTags';

/**
 * Reserved dispatch-option key carrying the dispatching unit's execution
 * context as a `ContextCarrier` (its span, request id, locale, and tenant).
 * The provider stores it with the job's other options; the worker restores it
 * for the attempt and exposes the request id as `JobContext.requestId`.
 */
export const CONTEXT_OPTION_KEY = '__jsailsContext';

/** Reserved dispatch-option key carrying a schedule's human-readable description. */
export const DESCRIPTION_OPTION_KEY = '__jsailsDescription';
