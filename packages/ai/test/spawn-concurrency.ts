/**
 * Suite concurrency for this package's tests that spawn a child per case.
 */

/**
 * How many spawned cases (a child process each) a suite runs at once:
 * `JSAILS_TEST_SPAWN_CONCURRENCY`, which `scripts/run-tests.mjs` sets (2 by
 * default), else 2. The runner already runs several test files at once, so a
 * suite that started every child together multiplied into far more Node
 * processes than cores when every workspace ran.
 */
export const SPAWN_CONCURRENCY = spawnConcurrency(process.env);

function spawnConcurrency(env: NodeJS.ProcessEnv): number {
  const value = Number(env['JSAILS_TEST_SPAWN_CONCURRENCY']);
  return Number.isInteger(value) && value >= 1 ? value : 2;
}
