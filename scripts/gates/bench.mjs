/**
 * The bench in check mode (`scripts/bench/`): every request and assembly
 * scenario is measured in its own process and compared with
 * `perf/budgets.json`. Exact counters (fs operations, zlib engines, response
 * and stream constructions, AsyncLocalStorage runs, modules, hashes, renders,
 * store round trips, response bytes) are ceilings; promises and allocated
 * bytes per request are ceilings at the achieved median plus 15% on the Node
 * line they were taken on; on CI a budget taken on another Node line fails
 * instead of being skipped (`strictNodeLine`). The check's own cost (`costOf`:
 * its children's CPU time over the concurrent slots, or the longest child if
 * that is longer, a lower bound on its wall time on an idle machine) must stay
 * under 30 seconds. This gate runs beside every other gate, so its wall time
 * is not its own; `node scripts/bench/index.mjs --check`, run alone, enforces
 * the same budget on wall time.
 */
import {
  compare,
  costOf,
  jobsOf,
  loadScenarios,
  measureJobs,
  readBudget,
  strictNodeLine,
} from '../bench/index.mjs';

export const name = 'bench';
export const description =
  'request and assembly counters stay within perf/budgets.json; the check costs under 30 s';
export const needsBuild = true;

const MAX_MS = 30_000;

export async function run({ repoRoot }) {
  const started = performance.now();
  const jobs = jobsOf(await loadScenarios());
  const results = await measureJobs(jobs, { root: repoRoot });
  const { failures, notes } = compare(results, readBudget(), { strictLine: strictNodeLine() });
  const elapsed = Math.round(performance.now() - started);
  const cost = costOf(results);
  if (cost > MAX_MS) {
    failures.push(
      `the bench check needs at least ${cost} ms of wall time on an idle machine, above its budget of ${MAX_MS} ms`,
    );
  }
  for (const note of notes) console.log(`note: ${note}`);
  console.log(`${jobs.length} measurements in ${elapsed} ms (at least ${cost} ms alone)`);
  return failures;
}
