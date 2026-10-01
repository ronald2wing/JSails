/**
 * The shape of one conformance scenario and the building blocks scenarios
 * share: the {@link Harness} a scenario receives, no-op and failing job
 * definitions, and a cooperative wait on an attempt's abort signal.
 */

import type { DriverOptions, JobsHarnessDriver, ScenarioJob } from './driver.js';
import { ExecutionLog } from './recorder.js';

/** What a scenario works with. */
export interface Harness {
  readonly driver: JobsHarnessDriver;
  readonly log: ExecutionLog;
  readonly options: DriverOptions;
  /** Define jobs on the driver with every handler instrumented by {@link log}. */
  define(jobs: readonly ScenarioJob[]): void;
}

/** One behaviour, stated as an executable check. */
export interface Scenario {
  /** The test name; stable, because expected-failure ledgers refer to it. */
  readonly name: string;
  /** Needs time to move only through `driver.advance`. */
  readonly virtualTime?: boolean;
  run(harness: Harness): Promise<void>;
}

/** A named group of scenarios, registered as one `describe`. */
export interface ScenarioGroup {
  readonly name: string;
  readonly scenarios: readonly Scenario[];
}

/** Build a harness around a driver. */
export function createHarness(driver: JobsHarnessDriver, options: DriverOptions): Harness {
  const log = new ExecutionLog();
  return {
    driver,
    log,
    options,
    define(jobs) {
      driver.define(jobs.map((job) => log.instrument(job)));
    },
  };
}

/** A job whose handler returns at once. */
export function noopJob(name: string, extra: Partial<ScenarioJob> = {}): ScenarioJob {
  return { name, ...extra, handle: () => Promise.resolve() };
}

/** Raised by scenario handlers that are meant to fail. */
export class ScenarioJobFailure extends Error {
  override readonly name = 'ScenarioJobFailure';
}

/** Resolve when `signal` aborts, then reject with its reason, as a cooperative handler does. */
export function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}
