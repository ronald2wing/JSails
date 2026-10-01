/**
 * The bounds of chains and batches and the keys their members are enqueued
 * under. A leaf: the envelope codec reads {@link isFlowId} from here, so it
 * imports nothing.
 *
 * Every follow-up a flow enqueues (a chain's next step or catch, a batch
 * child or callback, a schedule's fire) carries one of these keys with
 * {@link FLOW_KEY_WINDOW_MS}, so a redelivered step or finalizer, or two
 * firing components racing, enqueue it once. The keys live under
 * {@link RESERVED_KEY_PREFIX}, which a dispatch key may not use, so no job of
 * the app can take a flow's key and swallow its member.
 */

/** The most steps a chain may have. */
export const MAX_CHAIN_STEPS = 100;
/** The most children of a batch stored in one atomic operation. */
export const MAX_BATCH_ITEMS = 1_000;
/** The most children of a chunked batch. */
export const MAX_CHUNKED_BATCH_ITEMS = 100_000;
/** The largest chain head or batch finalizer envelope, in UTF-8 bytes of its JSON. */
export const MAX_FLOW_BYTES = 262_144;
/** The most failed children one `childFailures` read returns. */
export const MAX_CHILD_FAILURES = 100;
/**
 * The window of every flow and schedule key: one day. A key only has to
 * outlive a redelivery of an already-settled step or finalizer, which lock
 * expiry bounds to minutes. A retry of a failed step or finalizer never
 * collides: its follow-ups are stored only in the operation that settles it
 * for good, so a failed one stored none, and whether a chain's catch already
 * fired is carried in the envelopes, not in a key.
 */
export const FLOW_KEY_WINDOW_MS = 86_400_000;
/** How long a settled batch's status stays readable, at least. */
export const BATCH_STATUS_RETENTION_MS: number = 7 * 86_400_000;
/** Job names under this prefix belong to the framework (the batch finalizer). */
export const RESERVED_JOB_PREFIX = 'jsails.';

/** Dispatch keys under this prefix belong to the framework (flow and schedule keys). */
export const RESERVED_KEY_PREFIX = 'jsails:';

const FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Whether `value` is a flow id: letters and digits joined by `.`, `:`, `_` or `-`, at most 128 characters. */
export function isFlowId(value: unknown): value is string {
  return typeof value === 'string' && FLOW_ID.test(value);
}

/** Whether `key` is under {@link RESERVED_KEY_PREFIX}, where only the framework's keys live. */
export function isReservedKey(key: string): boolean {
  return key.startsWith(RESERVED_KEY_PREFIX);
}

/** The key of step `step` of chain `id`. */
export function chainStepKey(id: string, step: number): string {
  return `${RESERVED_KEY_PREFIX}chain:${id}:${step}`;
}

/** The key of the catch of chain `id`. */
export function chainCatchKey(id: string): string {
  return `${RESERVED_KEY_PREFIX}chain:${id}:catch`;
}

/** The key of child `index` of batch `id`. */
export function batchChildKey(id: string, index: number): string {
  return `${RESERVED_KEY_PREFIX}batch:${id}:${index}`;
}

/** The key of one callback of batch `id`. */
export function batchCallbackKey(id: string, callback: 'then' | 'catch' | 'finally'): string {
  return `${RESERVED_KEY_PREFIX}batch:${id}:${callback}`;
}

/** The key of the fire of schedule `id` at fire time `slot` (epoch milliseconds). */
export function scheduleFireKey(id: string, slot: number): string {
  return `${RESERVED_KEY_PREFIX}schedule:${id}:${slot}`;
}
