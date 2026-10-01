/**
 * The bench in check mode (`scripts/bench/`): every request and assembly
 * scenario is measured in its own process and compared with
 * `perf/budgets.json`. Exact counters (fs operations, zlib engines, response
 * and stream constructions, AsyncLocalStorage runs, modules, hashes, renders,
 * store round trips, response bytes) are ceilings; on CI a budget taken on
 * another Node line fails instead of being skipped (`strictNodeLine`). The
 * check's own cost (`costOf`: its children's CPU time over the concurrent
 * slots, or the longest child if that is longer, a lower bound on its wall
 * time on an idle machine) must stay under 30 seconds. This gate runs beside
 * every other gate (and, in `npm run check`, beside lint and the tests), so
 * neither its wall time nor its banded counters are its own: promises and
 * allocated bytes per request rise by about the width of their band when the
 * CPU is oversubscribed, so here a banded counter over its band is a note
 * (`contended`), and `node scripts/bench/index.mjs --check`, run alone (CI's
 * bench job), judges the banded counters and the wall time.
 */
import {
  compare,
  costOf,
  jobLimit,
  jobsOf,
  loadScenarios,
  measureJobs,
  readBudget,
  strictNodeLine,
} from '../bench/index.mjs';

export const name = 'bench';
export const description =
  'request and assembly exact counters stay within perf/budgets.json (banded ones are judged by bench --check run alone); the check costs under 30 s';
export const needsBuild = true;

const MAX_MS = 30_000;

/**
 * The bench's CPU slots under the machine budget (`scripts/run-gates.mjs`
 * leases them): its full default pool, as both need and want, because
 * `costOf` judges the check at the pool it ran with and a narrower grant
 * would raise that figure past its budget.
 */
export const jobs = Object.freeze({ need: jobLimit(), want: jobLimit() });

export async function run({ repoRoot }) {
  const started = performance.now();
  const measured = jobsOf(await loadScenarios());
  const limit = jobLimit();
  const results = await measureJobs(measured, { root: repoRoot, limit });
  const { failures, notes } = compare(results, readBudget(), {
    strictLine: strictNodeLine(),
    contended: true,
  });
  const elapsed = Math.round(performance.now() - started);
  const cost = costOf(results, limit);
  if (cost > MAX_MS) {
    failures.push(
      `the bench check needs at least ${cost} ms of wall time on an idle machine, above its budget of ${MAX_MS} ms`,
    );
  }
  for (const note of notes) console.log(`note: ${note}`);
  console.log(`${measured.length} measurements in ${elapsed} ms (at least ${cost} ms alone)`);
  return failures;
}
