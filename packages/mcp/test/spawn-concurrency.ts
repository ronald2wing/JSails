/**
 * Suite concurrency for this package's tests: how many cases of one suite
 * overlap, for spawned children and for in-process endpoints.
 */

/**
 * How many spawned cases (a child process each) a suite runs at once:
 * `JSAILS_TEST_SPAWN_CONCURRENCY`, which `scripts/run-tests.mjs` sets (2 by
 * default), else 2. The runner already runs several test files at once, so a
 * suite that started every child together multiplied into far more Node
 * processes than cores when every workspace ran.
 */
export const SPAWN_CONCURRENCY = spawnConcurrency(process.env);

/**
 * How many in-process cases (a client and an HTTP endpoint in the test
 * process) a suite runs at once: each mostly waits on its loopback socket and
 * costs a few MiB, so more overlap than spawned cases, but a bound rather than
 * all at once keeps a large suite's heap from growing with its case count.
 */
export const IN_PROCESS_CONCURRENCY = 8;

function spawnConcurrency(env: NodeJS.ProcessEnv): number {
  const value = Number(env['JSAILS_TEST_SPAWN_CONCURRENCY']);
  return Number.isInteger(value) && value >= 1 ? value : 2;
}
