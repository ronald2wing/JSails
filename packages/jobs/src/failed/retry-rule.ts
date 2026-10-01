/**
 * The part of a failed-job retry every transport decides the same way: which
 * stored envelopes a retry refuses. A transport runs it inside its own atomic
 * retry operation, after it found the job failed, so the memory adapter and
 * a shared transport agree on every case.
 */

import { decodeEnvelope } from '../envelope/codec.js';

/**
 * `'not_retryable'` when the stored envelope does not decode as the current
 * or a newer version (a newer one is retried: a newer worker reads it), or
 * when it is a step of a chain whose catch already fired (by this step or an
 * earlier one) and `force` is not set; `undefined` when the retry may
 * proceed.
 */
export function retryRefusal(storedEnvelope: unknown, force: boolean): 'not_retryable' | undefined {
  const decoded = decodeEnvelope(storedEnvelope);
  if (!decoded.ok) return decoded.reason === 'newer_version' ? undefined : 'not_retryable';
  const flow = decoded.envelope.meta.flow;
  return flow?.kind === 'chain' && flow.catchFired === true && !force ? 'not_retryable' : undefined;
}
