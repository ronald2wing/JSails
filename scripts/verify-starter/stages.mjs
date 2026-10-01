/**
 * The stage ledger: runs each named stage once its prerequisites have passed,
 * records every outcome (`ok`, `expected-failure`, `failed`, or `skipped` with
 * its reason), dispatches independent stages concurrently, and restores the
 * declared pipeline order for the report.
 *
 * A stage that needs the browser is recorded as a skip under `--skip-browser`
 * without running or probing anything; a stage that needs the database is
 * recorded as a skip when MariaDB is not configured. The database gate is
 * evaluated first, so a missing MariaDB is always reported as the database
 * skip even under `--skip-browser`. A negative proof "succeeds" only when its
 * temporary failure happens exactly as expected, and is recorded under the
 * distinct `expected-failure` status, never `ok`, so it can never count as a
 * pass.
 */
import { availableParallelism } from 'node:os';

import { DATABASE_SKIP_REASON, hasDatabase } from './database.mjs';

export const log = (line) => process.stdout.write(`[verify:starter] ${line}\n`);

/**
 * How many independent stages may run at once.
 *
 * Each fixture `npm run check` is a `tsc` + `vite` build, and `tsc` 7 (native)
 * already saturates several cores on its own, measured at ~600% CPU on a
 * 12-core box. Concurrency is therefore capped at a quarter of the available
 * parallelism: on 12 cores that is 3, which measured 1.49x faster than serial,
 * while 4 concurrent builds measured no faster than 4 serial ones (8756 ms vs
 * 8680 ms) because the extra build only oversubscribes. The floor of 1 keeps
 * single-core CI machines on the sequential path.
 */
const STAGE_CONCURRENCY = Math.max(1, Math.floor(availableParallelism() / 4));

/**
 * The declared pipeline order, used to re-sort results after concurrent
 * dispatch. An explicit list rather than the call order, because concurrent
 * chains finish in any order; a stage missing from the list still reports, at
 * the end, so an omission is visible rather than silent.
 */
const STAGE_ORDER = [
  'build-root',
  'pack',
  'generate-fixture',
  'generate-blog-fixture',
  'check-blog-fixture',
  'generate-saas-fixture',
  'check-saas-fixture',
  'write-editor-fixture',
  'packaged-import',
  'check-fixture',
  'static-export',
  'native-test',
  'native-test-fail-proof',
  'auth-migrate',
  'user-create',
  'browser-test-pass',
  'browser-test-fail-proof',
  'browser-serve',
  'browser-static',
  'browser-auth',
  'dev-server',
];

/** Creates the ledger for one run. */
export function createStageLedger({ skipBrowser }) {
  const results = [];

  const skip = (name, detail) => {
    results.push({ name, status: 'skipped', detail, durationMs: 0 });
  };

  /**
   * Runs `fn` as the stage `name` and records its outcome. `after` names the
   * stages that must have passed first; `needs` lists `browser` and/or
   * `database`; `proof` marks a negative proof.
   */
  const run = async (name, { after = [], needs = [], proof = false }, fn) => {
    if (needs.includes('database') && !hasDatabase) {
      skip(name, DATABASE_SKIP_REASON);
      log(`stage ${name} SKIPPED — ${DATABASE_SKIP_REASON}`);
      return;
    }
    if (needs.includes('browser') && skipBrowser) {
      skip(name, `--skip-browser: browser ${proof ? 'negative proof' : 'stage'} not run`);
      log(`stage ${name} SKIPPED — --skip-browser`);
      return;
    }
    const blockedBy = after.find((prerequisite) => {
      const state = results.find((entry) => entry.name === prerequisite);
      return state === undefined || state.status !== 'ok';
    });
    if (blockedBy !== undefined) {
      skip(name, `prerequisite "${blockedBy}" not satisfied`);
      return;
    }
    log(`stage ${name} ...`);
    const started = Date.now();
    try {
      const detail = (await fn()) ?? '';
      const durationMs = Date.now() - started;
      results.push({ name, status: proof ? 'expected-failure' : 'ok', detail, durationMs });
      const verdict = proof ? 'EXPECTED FAILURE PROVEN' : 'OK';
      log(`stage ${name} ${verdict}${detail ? ` — ${detail}` : ''} (${durationMs} ms)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name, status: 'failed', detail: message, durationMs: Date.now() - started });
      log(`stage ${name} FAILED — ${message}`);
    }
  };

  /**
   * Runs independent chains concurrently, bounded by the stage concurrency.
   * Each chain is a function that awaits its own `run` calls, so gating,
   * logging, and recording are identical to the sequential path. Only chains
   * whose resources are isolated may be grouped: the fixture chains each own
   * a directory, and the read-only browser QA stages each own a `PORT=0`
   * server and an isolated browser context (they share one Chromium, which is
   * why its launch is a promise singleton). `results` is appended to from
   * concurrent callbacks, which is safe because `push` is atomic.
   */
  const parallel = async (chains) => {
    const queue = [...chains];
    const workers = Array.from({ length: Math.min(STAGE_CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        await next();
      }
    });
    await Promise.all(workers);
  };

  /** The outcomes in declared pipeline order; unlisted stages keep their relative order at the end. */
  const outcomes = () => {
    const rank = (name) => {
      const index = STAGE_ORDER.indexOf(name);
      return index === -1 ? STAGE_ORDER.length : index;
    };
    return [...results].sort((a, b) => rank(a.name) - rank(b.name));
  };

  return { run, parallel, outcomes };
}
