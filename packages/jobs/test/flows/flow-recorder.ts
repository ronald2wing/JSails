/**
 * A transport for flow tests: records every enqueue (queue and envelope),
 * deduplicates keys as a transport does, and can be told to refuse the next
 * enqueue or to report a batch status.
 */

import type {
  BatchStatus,
  FlowTransport,
  JobEnvelope,
  JobHandle,
  JobsAdapter,
} from '../../src/contract/index.js';
import type { QueueSet } from '../../src/queues/queue-set.js';

export interface Enqueued {
  readonly queue: string;
  readonly envelope: JobEnvelope;
}

export class FlowRecorder implements Pick<JobsAdapter, 'enqueue' | 'capabilities'> {
  readonly enqueued: Enqueued[] = [];
  readonly #keys = new Set<string>();
  #refuseNext: Error | undefined;
  status: BatchStatus | undefined | Error;
  capabilities: JobsAdapter['capabilities'];

  constructor(options: { readonly flows?: boolean } = {}) {
    const flows: FlowTransport = {
      enqueueBatch: () => Promise.reject(new Error('not used')),
      batchStatus: () =>
        this.status instanceof Error ? Promise.reject(this.status) : Promise.resolve(this.status),
      childFailures: () => Promise.resolve([]),
    };
    this.capabilities = options.flows === false ? {} : { flows };
  }

  /** Make the next enqueue reject with `error`. */
  refuseNext(error: Error): void {
    this.#refuseNext = error;
  }

  enqueue(queue: string, envelope: JobEnvelope): Promise<JobHandle> {
    const refusal = this.#refuseNext;
    if (refusal !== undefined) {
      this.#refuseNext = undefined;
      return Promise.reject(refusal);
    }
    const key = envelope.meta.key;
    if (key !== undefined && this.#keys.has(`${queue}:${key}`)) {
      return Promise.resolve({ id: 'dup', deduplicated: true });
    }
    if (key !== undefined) this.#keys.add(`${queue}:${key}`);
    this.enqueued.push({ queue, envelope });
    return Promise.resolve({ id: String(this.enqueued.length), deduplicated: false });
  }
}

/** A queue set holding `names`. */
export function queuesOf(...names: string[]): Pick<QueueSet, 'has'> {
  const set = new Set(names);
  return { has: (name): name is string => set.has(name) };
}
