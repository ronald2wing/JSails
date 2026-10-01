/**
 * `testJobsAdapter`: registers the conformance scenarios as ordinary node:test
 * tests, one `describe` per group, against a driver factory.
 *
 * Every scenario gets a fresh driver. A scenario's own failure always stands;
 * closing the driver afterwards is bounded, and a close that fails or hangs
 * fails a scenario that otherwise passed. Scenarios that need virtual time
 * are registered only for a driver that provides it.
 *
 * The suite has no expected-failure switch of its own. In this repository a
 * known failure is listed in an expected-failure ledger
 * (`scripts/expected-failures/jobs.json`) by its test file and name path
 * `["jobs adapter conformance: <name>", "<group>", "<scenario>"]`; the file
 * registers the plan itself (see {@link conformancePlan}).
 */

import { describe, test } from 'node:test';

import { abortScenarios } from './abort.js';
import type { DriverFactory, DriverOptions } from './driver.js';
import { envelopeScenarios } from './envelope.js';
import { failedScenarios } from './failed.js';
import { flowScenarios } from './flows.js';
import { keyScenarios } from './keys.js';
import { outcomeScenarios } from './outcomes.js';
import { within } from './recorder.js';
import { createHarness, type Scenario, type ScenarioGroup } from './scenario.js';
import { scheduleScenarios } from './schedules.js';
import { skewScenarios } from './skew.js';

/** Every scenario group, in registration order. */
export const SCENARIO_GROUPS: readonly ScenarioGroup[] = Object.freeze([
  keyScenarios,
  envelopeScenarios,
  outcomeScenarios,
  abortScenarios,
  flowScenarios,
  failedScenarios,
  scheduleScenarios,
  skewScenarios,
]);

/** How long a drain lets in-flight attempts run before aborting them. */
export const DRAIN_DEADLINE_MS = 200;

const CLOSE_BOUND_MS = 5_000;

export interface TestJobsAdapterOptions {
  /** Whether the driver can run with virtual time (`driver.advance`). */
  readonly virtualTime: boolean;
}

/** The outer `describe` name for an implementation. */
export function suiteName(name: string): string {
  return `jobs adapter conformance: ${name}`;
}

/** Run one scenario on a fresh driver. */
export async function runScenario(
  scenario: Scenario,
  makeDriver: DriverFactory,
  virtualTime: boolean,
): Promise<void> {
  const options: DriverOptions = { drainDeadlineMs: DRAIN_DEADLINE_MS, virtualTime };
  const driver = await makeDriver(options);
  let passed = false;
  try {
    await scenario.run(createHarness(driver, options));
    passed = true;
  } finally {
    const closing = within(driver.close(), CLOSE_BOUND_MS, 'the driver did not close');
    if (passed) {
      await closing;
    } else {
      // The scenario's own failure is the result; a driver left wedged by it
      // (a hung worker) must not replace that failure with a close error.
      await closing.catch(() => undefined);
    }
  }
}

/** One registrable test: a scenario bound to a driver factory. */
export interface ConformanceTest {
  readonly name: string;
  run(): Promise<void>;
}

/** The tests of one scenario group. */
export interface ConformanceGroup {
  readonly name: string;
  readonly tests: readonly ConformanceTest[];
}

/**
 * Every scenario bound to `makeDriver`, grouped, without registering anything.
 * A runner that attributes results to the file that called `test()` (this
 * repository's does) needs the `describe`/`test` calls in the test file
 * itself; such a file loops over this plan. Others call {@link testJobsAdapter}.
 */
export function conformancePlan(
  makeDriver: DriverFactory,
  options: TestJobsAdapterOptions,
): readonly ConformanceGroup[] {
  return SCENARIO_GROUPS.map((group) => ({
    name: group.name,
    tests: group.scenarios
      .filter((scenario) => scenario.virtualTime !== true || options.virtualTime)
      .map((scenario) => ({
        name: scenario.name,
        run: () => runScenario(scenario, makeDriver, scenario.virtualTime === true),
      })),
  }));
}

/**
 * Hand a node:test registration promise back to the runner. It settles when
 * the test or suite finishes and never rejects (failures are reported by the
 * runner itself), so a rejection would be a runner defect; it is rethrown as
 * an uncaught exception rather than dropped.
 */
function scheduled(registration: Promise<void>): void {
  registration.catch((error: unknown) => {
    setImmediate(() => {
      throw error;
    });
  });
}

/** Register every scenario for one implementation. */
export function testJobsAdapter(
  name: string,
  makeDriver: DriverFactory,
  options: TestJobsAdapterOptions,
): void {
  scheduled(
    describe(suiteName(name), () => {
      for (const group of conformancePlan(makeDriver, options)) {
        scheduled(
          describe(group.name, () => {
            for (const entry of group.tests) scheduled(test(entry.name, () => entry.run()));
          }),
        );
      }
    }),
  );
}
