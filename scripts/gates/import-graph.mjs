/**
 * The loaded-set gate: every public entry of every workspace and three
 * scenario processes (`jsails --help`, and `jsails serve` plus a first request
 * without and with the database plugin) run in fresh processes that record
 * every module they load, ESM and CommonJS, eager dynamic imports included
 * (`scripts/import-graph/`). It fails on a module count above its ceiling in
 * `scripts/import-graph/budgets.json`, on a package an entry's tier does not
 * allow, on a browser-tier closure reaching a builtin or a server package, and
 * on a browser-tier subpath core does not declare browser-safe, unless the
 * violation is listed in `scripts/expected-failures/import-graph.json`. The
 * ledger and the ceilings only move down.
 */
import { readGateLedger } from '../expected-failures.mjs';
import { readBudgets } from '../import-graph/index.mjs';
import { judge } from '../import-graph/judge.mjs';
import { measure } from '../import-graph/measure.mjs';
import { ENTRIES, SCENARIOS } from '../import-graph/policy.mjs';

export const name = 'import-graph';
export const description =
  'what each public entry and scenario process loads stays within its tier and module ceiling';
export const needsBuild = true;
/** CPU slots: the probe pool runs up to eight fresh processes at once (`pool`). */
export const jobs = Object.freeze({ need: 1, want: 8 });

export async function run({ repoRoot }) {
  const measurement = await measure({ root: repoRoot });
  const { failures, notes } = judge(measurement, {
    entries: ENTRIES,
    scenarios: SCENARIOS,
    budgets: readBudgets(),
    ledger: readGateLedger(name, { root: repoRoot }),
  });
  for (const note of notes) console.log(`note: ${note}`);
  return failures;
}
