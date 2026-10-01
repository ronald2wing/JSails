/**
 * The suite's own contract: scenario names are unique (ledgers address them by
 * name), a scenario's failure is never replaced by a close error, a close
 * failure fails a scenario that passed, and the driver gets virtual time
 * exactly when the scenario asks for it.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  SCENARIO_GROUPS,
  conformancePlan,
  runScenario,
  suiteName,
  type DriverOptions,
  type JobsHarnessDriver,
  type Scenario,
} from '../../src/testing/index.js';
import { createReferenceDriver } from './reference-driver.js';

const REGISTRATION_FIXTURE = fileURLToPath(
  new URL('./fixtures/register-reference.js', import.meta.url),
);

/** Run a test file in its own process with the TAP reporter. */
function runTap(file: string): Promise<{ readonly status: number | null; readonly tap: string }> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--test-reporter=tap', file], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let tap = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    tap += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, tap }));
  });
}

/**
 * The name path of every leaf test a TAP stream reports, from its
 * `# Subtest:` lines (indented four spaces per level, in start order).
 */
function leafPaths(tap: string): string[] {
  const stack: string[] = [];
  const paths: string[][] = [];
  for (const line of tap.split('\n')) {
    const match = /^( *)# Subtest: (.*)$/.exec(line);
    if (match === null) continue;
    const depth = match[1]!.length / 4;
    stack.length = depth;
    stack.push(match[2]!.replaceAll('\\#', '#').replaceAll('\\\\', '\\'));
    paths.push([...stack]);
  }
  return paths
    .filter(
      (path, index) =>
        !paths.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.length > path.length &&
            path.every((part, at) => other[at] === part),
        ),
    )
    .map((path) => path.join(' > '));
}

/** A reference driver whose close does what the test says. */
function driverClosingWith(
  close: () => Promise<void>,
  seen: DriverOptions[] = [],
): (options: DriverOptions) => JobsHarnessDriver {
  return (options) => {
    seen.push(options);
    const driver = createReferenceDriver(options);
    return Object.assign(Object.create(driver) as JobsHarnessDriver, { close });
  };
}

describe('jobs conformance suite', () => {
  test('group names and scenario names are unique', () => {
    const groups = SCENARIO_GROUPS.map((group) => group.name);
    assert.equal(new Set(groups).size, groups.length);
    for (const group of SCENARIO_GROUPS) {
      const names = group.scenarios.map((scenario) => scenario.name);
      assert.equal(new Set(names).size, names.length, `duplicate scenario in ${group.name}`);
      assert.ok(names.length > 0, `group ${group.name} is empty`);
    }
  });

  test('the plan leaves out virtual-time scenarios for a driver without virtual time', () => {
    const names = (virtualTime: boolean) =>
      conformancePlan(createReferenceDriver, { virtualTime }).flatMap((group) =>
        group.tests.map((entry) => entry.name),
      );
    const virtual = SCENARIO_GROUPS.flatMap((group) =>
      group.scenarios.filter((scenario) => scenario.virtualTime === true).map((s) => s.name),
    );
    assert.ok(virtual.length > 0);
    assert.deepEqual(
      names(false),
      names(true).filter((name) => !virtual.includes(name)),
    );
  });

  test('the outer describe names the implementation', () => {
    assert.equal(suiteName('legacy-memory'), 'jobs adapter conformance: legacy-memory');
  });

  test('testJobsAdapter registers every planned scenario under suite > group > scenario', async () => {
    const { status, tap } = await runTap(REGISTRATION_FIXTURE);
    const expected = conformancePlan(createReferenceDriver, { virtualTime: true }).flatMap(
      (group) =>
        group.tests.map((entry) => `${suiteName('reference')} > ${group.name} > ${entry.name}`),
    );
    assert.deepEqual(leafPaths(tap), expected);
    assert.equal(status, 0, `the registered suite failed:\n${tap.slice(-2000)}`);
    assert.match(tap, new RegExp(`^# pass ${String(expected.length)}$`, 'm'));
    assert.match(tap, /^# fail 0$/m);
  });

  test('a failing scenario keeps its own error when close also fails', async () => {
    const scenario: Scenario = {
      name: 'fails',
      run: () => Promise.reject(new Error('scenario failure')),
    };
    await assert.rejects(
      runScenario(
        scenario,
        driverClosingWith(() => Promise.reject(new Error('close failure'))),
        false,
      ),
      /scenario failure/,
    );
  });

  test('a close failure fails a scenario that passed', async () => {
    const scenario: Scenario = { name: 'passes', run: () => Promise.resolve() };
    await assert.rejects(
      runScenario(
        scenario,
        driverClosingWith(() => Promise.reject(new Error('close failure'))),
        false,
      ),
      /close failure/,
    );
  });

  test('the driver runs with virtual time only when the scenario asks for it', async () => {
    const seen: DriverOptions[] = [];
    const factory = driverClosingWith(() => Promise.resolve(), seen);
    await runScenario({ name: 'real', run: () => Promise.resolve() }, factory, false);
    await runScenario(
      { name: 'virtual', virtualTime: true, run: () => Promise.resolve() },
      factory,
      true,
    );
    assert.deepEqual(
      seen.map((options) => options.virtualTime),
      [false, true],
    );
  });
});
