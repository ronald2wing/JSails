/**
 * Bounded suite concurrency in tests.
 *
 * `scripts/run-tests.mjs` already runs several test files at once, each in its
 * own process, under a lease from the machine budget. A suite declared with
 * `{ concurrency: true }` starts every one of its cases together, and when
 * each case spawns a child (a CLI, a stdio server, a module-graph probe) that
 * multiplied into hundreds of Node processes, past any lease, once every
 * workspace ran. `jsails/no-unbounded-test-concurrency` therefore bans the
 * literal `true` as a `concurrency` value in every test tree: a suite states
 * its bound, for spawned cases through `JSAILS_TEST_SPAWN_CONCURRENCY` (core's
 * `CLI_SUITE_CONCURRENCY`, a package's `test/spawn-concurrency.ts`).
 */

const TEST_FILES = [
  'core/test/**/*.{ts,tsx}',
  'packages/*/test/**/*.{ts,tsx}',
  'scripts/test/**/*.mjs',
];

export const restrictedSyntax = [
  {
    name: 'no-unbounded-test-concurrency',
    files: TEST_FILES,
    selector: "Property[key.name='concurrency'][value.value=true]",
    message:
      'Give the suite a bound (CLI_SUITE_CONCURRENCY, SPAWN_CONCURRENCY, or a number), not concurrency: true: the runner already runs test files in parallel.',
  },
];

export default [];
