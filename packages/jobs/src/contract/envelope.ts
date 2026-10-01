/**
 * The framework-owned job envelope: the one value a transport stores for a
 * job. Callers never build it; the runtime does, from a typed job call and its
 * dispatch options, so `meta` cannot be supplied from outside.
 *
 * The shape is a wire format shared by every process that reads a queue, so a
 * change to it bumps {@link JOB_ENVELOPE_VERSION}. A worker that meets a newer
 * version, or a job name it does not know, releases the job instead of failing
 * it, which keeps a rolling deploy or a rollback from spending retries. Such a
 * worker never writes into an envelope it cannot read: how often a job was
 * released that way is counted by the transport
 * (`TransportJob.unknownReleases`), not stored in `meta`.
 *
 * Every field is plain JSON, so an envelope survives any transport that
 * serializes it; `src/envelope/` builds and decodes it.
 */

/** The envelope wire version. Bumped on any change to {@link JobEnvelope}'s shape. */
export const JOB_ENVELOPE_VERSION = 2;

/** Retry spacing between attempts. */
export interface JobBackoff {
  readonly type: 'fixed' | 'exponential';
  /** Base delay in milliseconds; exponential doubles it per failed attempt. */
  readonly delayMs: number;
}

/** Per-job execution options, declared on a definition and narrowed per dispatch. */
export interface JobOptions {
  /** Total attempts, the first run included. */
  readonly attempts?: number;
  readonly backoff?: JobBackoff;
  /** Per-attempt deadline in milliseconds; past it the attempt fails and its signal aborts. */
  readonly timeoutMs?: number;
  /** Lower runs first among waiting jobs of one queue. */
  readonly priority?: number;
}

/**
 * Options accepted by a dispatch. A `key` deduplicates every dispatch of the
 * same key on the same queue for `keyWindowMs`, whatever state the first job
 * is in, including after the transport evicted it.
 */
export interface DispatchOptions extends JobOptions {
  readonly delayMs?: number;
  readonly runAt?: Date;
  readonly key?: string;
  readonly keyWindowMs?: number;
  readonly tags?: readonly string[];
}

/** Overlap control carried by a job that must not run alongside itself. */
export interface JobOverlap {
  readonly key: string;
  readonly ttlMs: number;
}

/**
 * A flow member stored for later: everything its envelope is built from
 * except the key, the flow membership, the execution context and the times,
 * which the runtime adds when it enqueues the member.
 */
export interface JobFlowStep {
  /** A declared queue. */
  readonly queue: string;
  readonly name: string;
  /** The schema input, validated when the flow was dispatched. */
  readonly payload: unknown;
  /** Resolved options: the definition defaults with the call's overrides applied. */
  readonly options: JobOptions;
  readonly tags?: readonly string[];
  readonly overlap?: JobOverlap;
}

/**
 * Where a job sits in a flow.
 *
 * - `chain`: step `step` of chain `id`. The envelope carries the steps after
 *   it and the catch call, so the worker that completes it can enqueue the
 *   next step on any transport, after a retry or a producer restart alike.
 * - `batch`: child `index` of batch `id`; the transport keeps the batch.
 * - `callback`: a chain's catch, or a batch's then, catch or finally.
 */
export type JobFlowMembership =
  | {
      readonly kind: 'chain';
      readonly id: string;
      /** Zero-based step index. */
      readonly step: number;
      /** Steps after this one, in order. */
      readonly next: readonly JobFlowStep[];
      /** Enqueued once when this step, or a later one, fails for good. */
      readonly catch?: JobFlowStep;
      /**
       * Set once the chain's catch fired: by the transport on the step whose
       * final failure fired it, and carried to every step built after it (a
       * forced retry continues the chain), so the catch never fires twice.
       */
      readonly catchFired?: true;
    }
  | {
      readonly kind: 'batch';
      readonly id: string;
      /** Zero-based child index. */
      readonly index: number;
    }
  | {
      readonly kind: 'callback';
      readonly flow: 'chain' | 'batch';
      readonly id: string;
      readonly callback: 'then' | 'catch' | 'finally';
    };

/** Framework-owned metadata. Never supplied by a caller. */
export interface JobEnvelopeMeta {
  /** Idempotency key; the transport deduplicates it per queue for {@link keyWindowMs}. */
  readonly key?: string;
  /** Present exactly when {@link key} is. */
  readonly keyWindowMs?: number;
  readonly tags?: readonly string[];
  /** Opaque serialized execution context (trace, request id, locale, tenant). */
  readonly context?: unknown;
  readonly overlap?: JobOverlap;
  readonly flow?: JobFlowMembership;
  /** Epoch milliseconds before which the job must not run; absent for an immediate job. */
  readonly runAt?: number;
  /** Epoch milliseconds of the dispatch. */
  readonly dispatchedAt: number;
}

/**
 * The value a transport stores for one job. `payload` is the job's schema
 * input as dispatched (validated, never transformed), so the worker's schema
 * parses it exactly once; `options` are the resolved definition defaults with
 * the dispatch's overrides applied.
 */
export interface JobEnvelope<TPayload = unknown> {
  readonly v: typeof JOB_ENVELOPE_VERSION;
  readonly name: string;
  readonly payload: TPayload;
  readonly options: JobOptions;
  readonly meta: JobEnvelopeMeta;
}

/** What a dispatch returns. */
export interface JobHandle {
  readonly id: string;
  /** True when the key was already taken inside its window and nothing was enqueued. */
  readonly deduplicated: boolean;
}
