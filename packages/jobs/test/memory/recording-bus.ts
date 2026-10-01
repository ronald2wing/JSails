/**
 * A {@link SignalBus} that records the job signals a runtime worker emits as
 * the conformance suite's events: `jobs.completed` (a discarded failure
 * included) as `completed`, `jobs.skipped` as `skipped`, `jobs.released` as
 * `released`, and a final `jobs.failed` as `failed`. A retried failure is no
 * event, as the suite counts outcomes of jobs, not of attempts.
 */

import type { EventToken } from 'jsails/extensions';
import type { SignalBus } from 'jsails/signals';

import type { JobSignalBase } from '../../src/runtime/job-signals.js';
import type { JobEvent } from '../../src/testing/index.js';

export class RecordingSignalBus implements SignalBus {
  readonly #events: JobEvent[] = [];
  /** Every signal emitted, by token name, in order. */
  readonly emitted: { readonly name: string; readonly payload: unknown }[] = [];

  observe(): void {
    throw new Error('the recording bus takes no observers');
  }

  emit<TPayload>(event: EventToken<TPayload>, payload: TPayload): Promise<readonly unknown[]> {
    this.emitted.push({ name: event.name, payload });
    const signal = payload as JobSignalBase & { readonly final?: boolean };
    const kind = this.#kind(event.name, signal.final === true);
    if (kind !== undefined) {
      this.#events.push({ kind, name: signal.name ?? '', jobId: signal.id });
    }
    return Promise.resolve([]);
  }

  #kind(name: string, final: boolean): JobEvent['kind'] | undefined {
    switch (name) {
      case 'jobs.completed':
        return 'completed';
      case 'jobs.skipped':
        return 'skipped';
      case 'jobs.released':
        return 'released';
      case 'jobs.failed':
        return final ? 'failed' : undefined;
      default:
        return undefined;
    }
  }

  events(): readonly JobEvent[] {
    return [...this.#events];
  }
}
