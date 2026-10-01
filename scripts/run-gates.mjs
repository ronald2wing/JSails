/**
 * Runs the repository gates: every module in `scripts/gates/`. A new check is a
 * new file there, never an edit to `package.json` or CI; `npm run check` runs
 * them all through `npm run gates`.
 *
 * Gate contract (`scripts/gates/<name>.mjs`, `<name>` kebab-case):
 *
 *   export const name = '<name>';             // equals the file name
 *   export const description = 'One line.';
 *   export const needsBuild = false;          // true: reads workspace dist/ output
 *   export const jobs = { need: 1, want: 4 }; // optional: an inner pool's CPU slots
 *   export async function run({ repoRoot }) { return []; }   // failure messages
 *
 * `run` returns (or resolves to) the list of failures; an empty list passes and
 * a throw fails. A ratcheting gate keeps today's violations in a gate ledger
 * (`scripts/expected-failures/<name>.json`, kind "gate") and compares through
 * `ratchet()` from `scripts/expected-failures.mjs`. A gate that runs a pool of
 * processes declares its CPU slots in `jobs` and sizes the pool with
 * `jobShare(jobs.want)` (`scripts/machine-budget.mjs`), which reads the grant
 * this runner passes down as `JSAILS_JOBS`.
 *
 * Each gate runs in its own process (a crash or `process.exit` in one cannot
 * hide another's result), at most six at once ({@link GATE_LANES}, within the
 * CPU grant of an enclosing budget holder), with its output printed whole.
 * Each takes a lease from the machine budget before it starts, sized from its
 * recorded peak (500 MiB without a record, 1000 with an inner pool). The
 * longest gates start first, by the wall times in
 * `test-results/timings-gates.json`, which every run rewrites with each
 * gate's wall time and, on Linux, its peak memory; a gate without a record
 * starts last.
 *
 * Usage: node scripts/run-gates.mjs [<name> ...]   run all gates, or the named ones
 *        node scripts/run-gates.mjs --list         list gates
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runBudgeted } from './budgeted.mjs';
import { jobShare } from './machine-budget.mjs';
import { DEFAULT_PEAK_MB } from './process-tree.mjs';
import { exitStatus } from './subprocess.mjs';
import { repoRoot, workspaceDirs } from './workspaces.mjs';

export const GATES_DIR = join(repoRoot, 'scripts', 'gates');
/** At most this many gates run at once. */
export const GATE_LANES = 6;
/** Each gate's last wall time and peak, which orders the next run. */
export const GATE_TIMINGS = join(repoRoot, 'test-results', 'timings-gates.json');
const GATE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SINGLE = Object.freeze({ need: 1, want: 1 });

/** Gate module files in `dir`, by name. */
export function gateFiles(dir = GATES_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.mjs'))
    .sort()
    .map((file) => join(dir, file));
}

function validJobs(jobs) {
  return (
    jobs !== null &&
    typeof jobs === 'object' &&
    Number.isInteger(jobs.need) &&
    Number.isInteger(jobs.want) &&
    jobs.need >= 1 &&
    jobs.want >= jobs.need
  );
}

/** Imports a gate module and checks it against the contract. */
export async function loadGate(file) {
  const module = await import(pathToFileURL(file).href);
  const expected = basename(file, '.mjs');
  const problems = [];
  if (!GATE_NAME.test(expected)) problems.push('the file name must be kebab-case');
  if (module.name !== expected) problems.push(`\`name\` must be "${expected}"`);
  if (typeof module.description !== 'string' || module.description === '') {
    problems.push('`description` is required');
  }
  if (typeof module.needsBuild !== 'boolean') problems.push('`needsBuild` must be a boolean');
  if (typeof module.run !== 'function') problems.push('`run` must be a function');
  if (module.jobs !== undefined && !validJobs(module.jobs)) {
    problems.push('`jobs` must be { need, want } with 1 <= need <= want');
  }
  if (problems.length > 0) {
    throw new Error(`${basename(file)} breaks the gate contract: ${problems.join('; ')}`);
  }
  return {
    file,
    name: module.name,
    description: module.description,
    needsBuild: module.needsBuild,
    jobs: module.jobs ?? SINGLE,
    run: module.run,
  };
}

/** Whether every workspace has its `dist/src` output. */
function isBuilt() {
  return workspaceDirs().every((dir) => existsSync(join(dir, 'dist', 'src')));
}

/** Runs one gate in this process; returns the exit status. */
export async function runGate(gate, { root = repoRoot, built = isBuilt } = {}) {
  if (gate.needsBuild && !built()) {
    console.error(`${gate.name}: needs built workspaces; run "npm run build" first`);
    return 1;
  }
  const failures = await gate.run({ repoRoot: root });
  if (!Array.isArray(failures)) {
    console.error(`${gate.name}: run() must return a list of failure messages`);
    return 1;
  }
  for (const failure of failures) console.error(`${gate.name}: ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

/** The gate timing record, `{ <name>: { wallMs, peakMb? } }` (empty when missing or unreadable). */
export function readGateTimings(file = GATE_TIMINGS) {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return record?.gates !== null && typeof record?.gates === 'object' ? record.gates : {};
  } catch {
    return {};
  }
}

/** `gates` in start order: the longest recorded first, then the unrecorded by name. */
export function gateOrder(gates, timings) {
  const wall = (gate) => timings[gate.name]?.wallMs;
  return [...gates].sort((a, b) => {
    const [x, y] = [wall(a), wall(b)];
    if (x !== undefined && y !== undefined) return y - x || (a.name < b.name ? -1 : 1);
    if (x !== undefined) return -1;
    if (y !== undefined) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** A gate's lease default (MiB) when its peak was never recorded. */
export function gateDefaultMb(gate) {
  return gate.jobs.want > 1 ? DEFAULT_PEAK_MB['gate-pool'] : DEFAULT_PEAK_MB.gate;
}

async function runAll(names) {
  const gates = [];
  for (const file of gateFiles()) gates.push(await loadGate(file));
  const unknown = names.filter((name) => !gates.some((gate) => gate.name === name));
  if (unknown.length > 0) {
    console.error(`Unknown gate(s): ${unknown.join(', ')}`);
    return 2;
  }
  const selected = names.length === 0 ? gates : gates.filter((gate) => names.includes(gate.name));
  const previous = readGateTimings();
  const queue = gateOrder(selected, previous);
  const failed = [];
  const timings = { ...previous };
  const worker = async () => {
    for (let gate = queue.shift(); gate !== undefined; gate = queue.shift()) {
      const started = Date.now();
      const outcome = await runBudgeted({
        label: `gate:${gate.name}`,
        defaultMb: gateDefaultMb(gate),
        cpu: gate.jobs,
        command: process.execPath,
        args: [import.meta.filename, '--run', gate.file],
        options: { cwd: repoRoot, capture: true },
      });
      // Time spent waiting for the lease is not the gate's: it would reorder the next run.
      const wallMs = Date.now() - started - (outcome.grant?.waitedMs ?? 0);
      const status = exitStatus(outcome);
      const verdict = status === 0 ? 'passed' : 'FAILED';
      process.stdout.write(`\n── gate ${gate.name} ${verdict} (${wallMs} ms) ──\n`);
      if (outcome.output !== '') process.stdout.write(outcome.output);
      if (status !== 0) failed.push(gate.name);
      timings[gate.name] = {
        wallMs,
        ...(outcome.peakMb === undefined ? {} : { peakMb: Math.round(outcome.peakMb) }),
      };
    }
  };
  const lanes = jobShare(GATE_LANES);
  await Promise.all(Array.from({ length: Math.min(lanes, selected.length) }, worker));
  mkdirSync(dirname(GATE_TIMINGS), { recursive: true });
  writeFileSync(GATE_TIMINGS, `${JSON.stringify({ gates: timings }, null, 2)}\n`);
  if (failed.length > 0) {
    console.error(`\nFailed gate(s): ${failed.sort().join(', ')}`);
    return 1;
  }
  console.log(`\nAll ${selected.length} gate(s) passed.`);
  return 0;
}

async function main(argv) {
  if (argv[0] === '--run') return runGate(await loadGate(argv[1]));
  if (argv[0] === '--list') {
    for (const file of gateFiles()) {
      const gate = await loadGate(file);
      console.log(`${gate.name}${gate.needsBuild ? ' (needs build)' : ''}: ${gate.description}`);
    }
    return 0;
  }
  return runAll(argv);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
