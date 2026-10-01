/**
 * A {@link JobsAdapter} that works deliveries a parent process sends over the
 * IPC channel, for the spawned poisoned-worker test. The parent holds the
 * real transport (a memory adapter) and plays a shared transport's lock: a
 * delivery stays held until this process reports its outcome or dies. The
 * bridge tells the parent when its worker stops fetching, so the parent
 * stops delivering.
 */

import type {
  AdapterWorker,
  AttemptOutcome,
  JobHandle,
  JobsAdapter,
  ProcessJob,
  TransportJob,
} from '../../../src/contract/index.js';

/** A message from the parent. */
export type ParentMessage =
  { readonly type: 'deliver'; readonly job: TransportJob } | { readonly type: 'stop' };

/** A message to the parent. */
export type ChildMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'started'; readonly name: string; readonly attempt: number }
  | { readonly type: 'outcome'; readonly id: string; readonly outcome: AttemptOutcome }
  | { readonly type: 'stopping' };

export function send(message: ChildMessage): void {
  process.send?.(message);
}

class BridgeWorker implements AdapterWorker {
  readonly #process: ProcessJob;
  readonly #controllers = new Set<AbortController>();
  readonly #inFlight = new Set<Promise<void>>();
  #stopped = false;

  constructor(process: ProcessJob) {
    this.#process = process;
  }

  deliver(job: TransportJob): void {
    const controller = new AbortController();
    if (this.#stopped) controller.abort();
    this.#controllers.add(controller);
    const run = this.#process(job, controller.signal).then((outcome) => {
      this.#controllers.delete(controller);
      this.#inFlight.delete(run);
      send({ type: 'outcome', id: job.id, outcome });
    });
    this.#inFlight.add(run);
  }

  #stop(): void {
    if (!this.#stopped) send({ type: 'stopping' });
    this.#stopped = true;
  }

  async drain(): Promise<void> {
    this.#stop();
    await Promise.all(this.#inFlight);
  }

  async abort(): Promise<void> {
    this.#stop();
    for (const controller of this.#controllers) controller.abort();
    await Promise.all(this.#inFlight);
  }
}

/** The bridge adapter. It only works deliveries; this process never enqueues. */
export function bridgeAdapter(): JobsAdapter {
  return {
    name: 'bridge',
    reach: 'shared',
    capabilities: Object.freeze({}),
    enqueue: (): Promise<JobHandle> => Promise.reject(new Error('the bridge does not enqueue')),
    startWorker: (_options, process) => {
      const worker = new BridgeWorker(process);
      globalThis.process.on('message', (message: ParentMessage) => {
        if (message.type === 'deliver') worker.deliver(message.job);
      });
      return Promise.resolve(worker);
    },
    close: () => Promise.resolve(),
  };
}
