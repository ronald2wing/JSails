/**
 * What the suite observes on its own, independent of the driver: every
 * handler execution (start, end, outcome, how many runs of the same job
 * overlapped), plus the latches and bounded waits scenarios are built from.
 *
 * Waits use timers captured when this module loads, so a driver that fakes
 * the global timers for virtual time cannot stall the suite's own deadlines.
 */

import { AssertionError } from 'node:assert';

import type { ScenarioJob, ScenarioJobContext } from './driver.js';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Wait `ms` of real time. */
export function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

/** Yield to every queued promise reaction and I/O callback once. */
export function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Settle as `work` does, or reject with an `AssertionError` of `message` when
 * it takes longer than `ms` of real time.
 */
export function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = realSetTimeout(() => reject(new AssertionError({ message })), ms);
    work.finally(() => realClearTimeout(timer)).then(resolve, reject);
  });
}

/** Poll `condition` until it holds; false after `ms` of real time. */
export async function eventually(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await realDelay(2);
  }
  return true;
}

/** A one-shot gate a handler can wait on and a scenario can open. */
export interface Latch {
  readonly promise: Promise<void>;
  readonly opened: boolean;
  open(): void;
}

export function latch(): Latch {
  let release: () => void = () => undefined;
  let opened = false;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    get opened() {
      return opened;
    },
    open() {
      opened = true;
      release();
    },
  };
}

/** One handler execution. */
export interface Execution {
  readonly name: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly payload: unknown;
  /** Runs of the same job id in flight when this one started, itself included. */
  readonly concurrent: number;
  outcome: 'running' | 'returned' | 'threw';
}

/** Records every execution of every instrumented job. */
export class ExecutionLog {
  readonly #executions: Execution[] = [];
  readonly #running = new Map<string, number>();
  #maxConcurrent = 0;

  /** Wrap `job` so its handler executions are recorded. */
  instrument(job: ScenarioJob): ScenarioJob {
    const handle = async (payload: unknown, context: ScenarioJobContext): Promise<void> => {
      const running = (this.#running.get(context.jobId) ?? 0) + 1;
      this.#running.set(context.jobId, running);
      this.#maxConcurrent = Math.max(this.#maxConcurrent, running);
      const execution: Execution = {
        name: job.name,
        jobId: context.jobId,
        attempt: context.attempt,
        payload,
        concurrent: running,
        outcome: 'running',
      };
      this.#executions.push(execution);
      try {
        await job.handle(payload, context);
        execution.outcome = 'returned';
      } catch (error) {
        execution.outcome = 'threw';
        throw error;
      } finally {
        this.#running.set(context.jobId, (this.#running.get(context.jobId) ?? 1) - 1);
      }
    };
    return { ...job, handle };
  }

  /** Every execution of `name`, in start order. */
  of(name: string): readonly Execution[] {
    return this.#executions.filter((execution) => execution.name === name);
  }

  /** How many executions of `name` started. */
  count(name: string): number {
    return this.of(name).length;
  }

  /** The most runs of one job id ever in flight together. */
  get maxConcurrent(): number {
    return this.#maxConcurrent;
  }
}
