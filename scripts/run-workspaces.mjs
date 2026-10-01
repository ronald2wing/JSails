/**
 * Runs one npm script in every workspace.
 *
 * `build` and `build:clean` follow the dependency graph derived from each
 * workspace's declared dependencies: a workspace starts only after the
 * workspaces it depends on, so adding a package never means editing a
 * hand-maintained chain, and an undeclared or cyclic edge fails loudly here
 * rather than working by accident of ordering. Every other script (`test`,
 * `typecheck`) reads already-built output and has no ordering need, so no
 * workspace waits for another's tests.
 *
 * Workspaces run concurrently up to `JSAILS_WORKSPACE_JOBS` at once (default:
 * the machine's available parallelism, at most 8; `1` runs them one at a time
 * in a stable topological order). Each workspace's run is a lane: before it
 * starts, it takes a lease from the machine-wide budget
 * (`scripts/machine-budget.mjs`), so several checkouts running at once share
 * the machine instead of each sizing its parallelism from the core count.
 * The lease's holder is this runner (`JSAILS_BUDGET_HOLDER`), so the
 * workspace's own processes take no lease of their own.
 *
 * - A test lane asks for its share of the CPU slots (twice the available
 *   parallelism; test files mostly wait on child processes and timers),
 *   decided when the workspace starts (`nextShare`): the free slots, split in
 *   proportion to test wall time in the previous timing record (or to the
 *   number of test files) among the workspaces that can start now, at least
 *   1, so the running shares never add up to more than the slots. Its memory
 *   is sized from recorded per-file peaks (`scripts/test-budget.mjs`), and the
 *   child gets `JSAILS_TEST_CONCURRENCY` (which `scripts/run-tests.mjs` passes
 *   to node as `--test-concurrency`) from the grant: its CPU slots, lowered to
 *   the number of typical files its memory holds. Setting
 *   `JSAILS_TEST_CONCURRENCY` yourself applies one value to every workspace.
 *   The heaviest suite starts first, so it is not starved.
 * - A build or typecheck lane leases its workspace's recorded tsc peak (core
 *   about 2 GB, a package 0.1-0.45 GB), so nine simultaneous clean builds do
 *   not ask for 18 GB at once.
 *
 * On Linux each lane's process tree is sampled from `/proc`; its peak is
 * recorded with the lane (and, for a build, kept as the next lease's size).
 *
 * Each workspace's output is buffered and printed whole when it finishes, so
 * concurrent logs never interleave. In a build the first failure stops the
 * run: no new workspace starts, including one still waiting for its lease
 * when the failure happens, and the running ones are terminated, since their
 * dependents could not run anyway. Any other script runs every workspace to the
 * end and lists each one that failed, so one run reports every failure (a new
 * CI platform leg yields all of its ledger drafts at once, and no workspace's
 * results are cut short by another's). A workspace without the script is
 * skipped (and counts as finished for its dependents). A termination signal
 * stops new workspaces from starting, including one still waiting for its
 * lease.
 *
 * A database-suite run (`test -- --suite=database`) fails before starting when
 * no workspace has a `test/**\/*.database.test.ts(x)` source: each workspace
 * would report an empty selection and pass, so a misnamed database test (or
 * none at all) would leave the database CI legs green while testing nothing.
 *
 * A test run writes `test-results/timings.json` (a coverage run
 * `timings-test-coverage.json`, so `npm run check` does not replace the
 * weights `npm test` uses; the database suite `timings-test-database.json`):
 * wall time per workspace with its lane's grant, wait and observed peak, and
 * the per-file wall and CPU times and memory peaks `run-tests.mjs` recorded,
 * with the slowest files printed. Other scripts write
 * `test-results/timings-<script>.json`.
 *
 * Usage: node scripts/run-workspaces.mjs <script> [-- <args forwarded to each workspace>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import { acquire } from './machine-budget.mjs';
import {
  DEFAULT_PEAK_MB,
  peakEstimate,
  readPeaks,
  recordPeaks,
  startTreeSampler,
} from './process-tree.mjs';
import { FORWARDED_SIGNALS, exitStatus, npm, run } from './subprocess.mjs';
import {
  TEST_BUDGET_FACTOR,
  laneConcurrency,
  laneOverheadMb,
  laneRequest,
  previousTimings,
  serialWallMs,
  timingsRecordName,
  workspaceEstimates,
} from './test-budget.mjs';
import { readWorkspaces, repoRoot, topologicalOrder, workspaceGraph } from './workspaces.mjs';

const MAX_DEFAULT_JOBS = 8;
const SLOWEST_SHOWN = 20;
const DEFAULT_RUN_TIMEOUT_MS = 900_000;
/** Scripts that emit what a dependent reads, and so run in dependency order. */
export const ORDERED_SCRIPTS = new Set(['build', 'build:clean']);
/** Scripts whose lane is one `tsc` of the workspace's program. */
export const TSC_SCRIPTS = new Set(['build', 'build:clean', 'typecheck']);

/** The concurrency bound: a positive integer from the environment, else the default. */
function jobLimit() {
  const raw = process.env.JSAILS_WORKSPACE_JOBS;
  if (raw === undefined || raw === '') {
    return Math.max(1, Math.min(availableParallelism(), MAX_DEFAULT_JOBS));
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error('JSAILS_WORKSPACE_JOBS must be a positive integer');
    process.exit(2);
  }
  return parsed;
}

/** The number of compiled test files under `<dir>/dist/test`. */
export function countTestFiles(dir) {
  const root = join(dir, 'dist', 'test');
  if (!existsSync(root)) return 0;
  let count = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.test.js')) count += 1;
    }
  };
  walk(root);
  return count;
}

/** The number of `*.database.test.ts(x)` sources under each `<dir>/test`. */
export function countDatabaseTests(dirs) {
  let count = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name));
      else if (entry.isFile() && /\.database\.test\.tsx?$/.test(entry.name)) count += 1;
    }
  };
  for (const dir of dirs) {
    if (existsSync(join(dir, 'test'))) walk(join(dir, 'test'));
  }
  return count;
}

/**
 * A starting workspace's `--test-concurrency` share: of the `free` slots, its
 * part in proportion to `weight` among `upcoming`, the weights of the
 * workspaces that can start now (itself included), rounded down, at least 1
 * and at most `free`; 0 when nothing is free, and the workspace then waits.
 * Shares decided this way never add up to more than the slots, and slots a
 * finished workspace frees go to the next ones.
 */
export function nextShare({ free, weight, upcoming }) {
  if (free <= 0) return 0;
  const total = upcoming.reduce((sum, value) => sum + value, 0);
  const share = total <= 0 ? free / Math.max(1, upcoming.length) : (free * weight) / total;
  return Math.min(free, Math.max(1, Math.floor(share)));
}

/**
 * Each workspace's test weight: its summed per-file wall time from the
 * previous timing record when that record covers it, else its test-file
 * count scaled to the record's average file time (or the count alone).
 */
export function testWeights(fileCounts, previous) {
  const walls = new Map();
  for (const file of previous?.files ?? []) {
    walls.set(file.workspace, (walls.get(file.workspace) ?? 0) + file.wallMs);
  }
  const recorded = previous?.files?.length ?? 0;
  const average = recorded === 0 ? 1 : [...walls.values()].reduce((a, b) => a + b, 0) / recorded;
  return new Map(
    [...fileCounts].map(([name, count]) => [name, walls.get(name) ?? count * average]),
  );
}

/**
 * The start order: dependency order for an ordered script; otherwise the
 * largest workspace first (it is the long pole), ties by name.
 */
export function startOrder(script, topological, weights) {
  if (ORDERED_SCRIPTS.has(script)) return topological;
  return [...topological].sort(
    (a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
  );
}

/** The dependency edges a script waits on: the declared graph, or none. */
export function schedulingGraph(script, declared) {
  if (ORDERED_SCRIPTS.has(script)) return declared;
  return new Map([...declared.keys()].map((name) => [name, new Set()]));
}

/** Per-file records `run-tests.mjs` wrote since `since` (older files are earlier runs). */
function testFileTimings(since) {
  const dir = join(repoRoot, 'test-results', 'timings', 'tests');
  if (!existsSync(dir)) return { files: [], runs: new Map() };
  const files = [];
  const runs = new Map();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!name.endsWith('.json') || statSync(path).mtimeMs < since) continue;
    const record = JSON.parse(readFileSync(path, 'utf8'));
    runs.set(record.workspace, record);
    for (const file of record.files) files.push({ workspace: record.workspace, ...file });
  }
  return { files: files.sort((a, b) => b.wallMs - a.wallMs), runs };
}

/**
 * The timing record's file: `timings.json` for a default-suite test run (the
 * record the next run weighs its concurrency by), `timings-test-coverage.json`
 * for a coverage run, `timings-test-database.json` for the database suite,
 * `timings-<script>.json` otherwise.
 */
export function timingsFileName(script, forwarded) {
  if (script === 'test') {
    return timingsRecordName({
      coverage: forwarded.includes('--coverage'),
      database: forwarded.includes('--suite=database'),
    });
  }
  return `timings-${script.replace(/[^a-z0-9]+/gi, '-')}.json`;
}

/** The lease label and memory estimate of a tsc lane. */
export function tscLease(workspace, peaks) {
  const label = `build:${workspace}`;
  const fallback =
    workspace === 'jsails' ? DEFAULT_PEAK_MB['build-core'] : DEFAULT_PEAK_MB['build-package'];
  return { label, mb: peakEstimate(peaks, label, fallback) };
}

/**
 * A test lane's lease request and how its grant turns into the child's
 * environment (see the module comment).
 */
export function testLane({ workspace, count, share, fixed, previous, coverage, runLimitMs }) {
  const estimates = workspaceEstimates(workspace, count, previous);
  const overheadMb = laneOverheadMb(workspace, previous, { coverage });
  const request = laneRequest({
    estimates,
    share,
    overheadMb,
    serialMs: serialWallMs(workspace, previous),
    runLimitMs,
    fixed,
  });
  return {
    request: { label: `test:${workspace}`, ...request },
    environment(grant) {
      const concurrency = fixed ?? laneConcurrency(grant, { estimates, overheadMb });
      return {
        concurrency,
        env: {
          ...grant.env,
          JSAILS_TEST_CONCURRENCY: String(concurrency),
        },
      };
    },
  };
}

/** Writes the timing record and prints the slowest test files. */
function writeTimings({ script, forwarded, startedAt, limit, tasks }) {
  const { files, runs } =
    script === 'test' ? testFileTimings(startedAt) : { files: [], runs: new Map() };
  const cpuByWorkspace = new Map();
  for (const file of files) {
    cpuByWorkspace.set(file.workspace, (cpuByWorkspace.get(file.workspace) ?? 0) + file.cpuMs);
  }
  const record = {
    script,
    forwarded,
    startedAt: new Date(startedAt).toISOString(),
    wallMs: Date.now() - startedAt,
    node: process.version,
    platform: process.platform,
    jobs: limit,
    // CPU is known only for test files (measured inside each test process);
    // a build task's CPU is not observable from here.
    tasks: [...tasks]
      .sort((a, b) => b.wallMs - a.wallMs)
      .map((task) => ({
        ...task,
        runnerMb: runs.get(task.workspace)?.runnerMb,
        cpuMs: cpuByWorkspace.get(task.workspace) ?? null,
      })),
    files,
  };
  const dir = join(repoRoot, 'test-results');
  const name = timingsFileName(script, forwarded);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(record, null, 2)}\n`);
  if (files.length > 0) {
    console.log(`\nSlowest test files across workspaces (wall / CPU ms):`);
    for (const file of files.slice(0, SLOWEST_SHOWN)) {
      console.log(`  ${file.wallMs} / ${file.cpuMs}  ${file.file}`);
    }
  }
  console.log(`\n"${script}" wall time: ${record.wallMs} ms (test-results/${name})`);
}

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`${name} must be a positive integer`);
    process.exit(2);
  }
  return parsed;
}

async function main(argv) {
  const [script, separator, ...forwarded] = argv;
  if (script === undefined || (separator !== undefined && separator !== '--')) {
    console.error('Usage: node scripts/run-workspaces.mjs <script> [-- <args>]');
    return 2;
  }
  const workspaces = readWorkspaces();
  const declared = workspaceGraph(workspaces);
  let topological;
  try {
    topological = topologicalOrder(declared);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  if (
    script === 'test' &&
    forwarded.includes('--suite=database') &&
    countDatabaseTests([...workspaces.values()].map(({ dir }) => dir)) === 0
  ) {
    console.error(
      'The database suite has no test/**/*.database.test.ts(x) file in any workspace; it would pass without testing anything.',
    );
    return 1;
  }
  const limit = jobLimit();
  const graph = schedulingGraph(script, declared);
  const coverage = forwarded.includes('--coverage');
  const fileCounts =
    script === 'test'
      ? new Map([...workspaces].map(([name, { dir }]) => [name, countTestFiles(dir)]))
      : new Map();
  const previous = script === 'test' ? previousTimings({ coverage }) : undefined;
  const weights = testWeights(fileCounts, previous);
  const order = startOrder(script, topological, weights);
  const fixed =
    script === 'test' ? positiveInteger('JSAILS_TEST_CONCURRENCY', undefined) : undefined;
  const slots = TEST_BUDGET_FACTOR * availableParallelism();
  const runLimitMs = positiveInteger('JSAILS_TEST_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS);
  const peaks = TSC_SCRIPTS.has(script) ? readPeaks() : {};
  const startedAt = Date.now();
  const tasks = [];
  const done = new Set();
  const running = new Map();
  const stopEarly = ORDERED_SCRIPTS.has(script);
  const failures = [];
  const builtPeaks = [];
  let failure;

  // A termination signal stops new workspaces from starting; `run` forwards
  // it to the running ones.
  const stop = new AbortController();
  const onSignal = (name) => {
    if (!stop.signal.aborted) stop.abort(name);
  };
  for (const name of FORWARDED_SIGNALS) process.on(name, onSignal);

  // Aborted the moment a build child fails, before its lease is released, so
  // a lane waiting for a lease stops waiting instead of starting once the
  // failed lane's slot frees (the failure is recorded later, in settleOne).
  const buildFailed = new AbortController();
  const leaseSignal = AbortSignal.any([stop.signal, buildFailed.signal]);
  const halted = () =>
    stop.signal.aborted || buildFailed.signal.aborted || (stopEarly && failure !== undefined);

  /** The workspaces whose dependencies have all finished, in start order; skips those without the script. */
  const ready = () => {
    const names = [];
    for (const name of order) {
      if (done.has(name) || running.has(name) || failures.includes(name)) continue;
      if (![...graph.get(name)].every((dep) => done.has(dep))) continue;
      if (workspaces.get(name).manifest.scripts?.[script] === undefined) {
        done.add(name);
        continue;
      }
      names.push(name);
    }
    return names;
  };

  /** The lease and child environment of `name`'s lane, or undefined when it must not start yet. */
  const leaseFor = async (name, candidates) => {
    if (script === 'test') {
      let share = fixed;
      if (share === undefined) {
        const held = [...running.values()].reduce(
          (sum, entry) => sum + (entry.concurrency ?? 0),
          0,
        );
        const upcoming = candidates
          .slice(0, limit - running.size)
          .map((entry) => weights.get(entry) ?? 0);
        share = nextShare({ free: slots - held, weight: weights.get(name) ?? 0, upcoming });
        if (share === 0) return undefined;
      }
      const lane = testLane({
        workspace: name,
        count: fileCounts.get(name) ?? 0,
        share,
        fixed,
        previous,
        coverage,
        runLimitMs,
      });
      const grant = await acquire(lane.request, { signal: leaseSignal });
      return { grant, ...lane.environment(grant) };
    }
    if (TSC_SCRIPTS.has(script)) {
      const { label, mb } = tscLease(name, peaks);
      const grant = await acquire(
        { label, mb: { need: mb, want: mb }, cpu: { need: 1, want: 1 } },
        { signal: leaseSignal },
      );
      return { grant, env: grant.env, label };
    }
    return { grant: { mb: 0, cpu: 0, waitedMs: 0, nested: true, env: {}, release() {} }, env: {} };
  };

  const start = (name, lease) => {
    const controller = new AbortController();
    const args = ['run', script, '--workspace', name];
    if (forwarded.length > 0) args.push('--', ...forwarded);
    let sampler;
    const ended = (failed) => {
      // A sibling this runner terminated is not a failure (as in settleOne).
      if (stopEarly && failed && !controller.signal.aborted) buildFailed.abort();
      // Released as soon as the child ends, not when the loop gets to it: a
      // lane waiting for its own lease must never wait on a finished sibling.
      lease.grant.release();
      const observed = sampler?.stop();
      const entry = running.get(name);
      if (entry !== undefined) entry.observedPeakMb = observed?.peakMb;
    };
    const outcome = run(npm, args, {
      cwd: repoRoot,
      env: { ...process.env, ...lease.env },
      signal: controller.signal,
      capture: limit > 1,
      onSpawn: (child) => {
        if (process.platform === 'linux') sampler = startTreeSampler(child.pid);
      },
    }).then(
      (result) => {
        ended(result.code !== 0);
        return result;
      },
      (error) => {
        ended(true);
        throw error;
      },
    );
    running.set(name, {
      controller,
      outcome,
      started: Date.now(),
      concurrency: lease.concurrency,
      grant: lease.grant,
      label: lease.label,
    });
  };

  /** Starts every workspace that can start, one lease at a time (leases are first come, first served). */
  const startReady = async () => {
    while (!halted() && running.size < limit) {
      const candidates = ready();
      const name = candidates[0];
      if (name === undefined) return;
      let lease;
      try {
        lease = await leaseFor(name, candidates);
      } catch (error) {
        if (halted()) return;
        throw error;
      }
      if (lease === undefined) return;
      if (halted()) {
        lease.grant.release();
        return;
      }
      start(name, lease);
    }
  };

  /** Wait for any running workspace and record its result. */
  const settleOne = async () => {
    const [name, result] = await Promise.race(
      [...running].map(([entry, { outcome }]) =>
        outcome.then(
          (value) => [entry, value],
          (error) => [entry, { code: 1, signal: null, output: `${error.message}\n` }],
        ),
      ),
    );
    const { controller, started, grant, observedPeakMb, label } = running.get(name);
    running.delete(name);
    const wallMs = Date.now() - started;
    tasks.push({
      workspace: name,
      wallMs,
      code: result.code,
      ...(grant.nested ? {} : { grantMb: grant.mb, grantCpu: grant.cpu, waitMs: grant.waitedMs }),
      ...(observedPeakMb === undefined ? {} : { observedPeakMb: Math.round(observedPeakMb) }),
    });
    if (result.output !== undefined && result.output !== '') {
      process.stdout.write(`\n── ${name} (${script}) ──\n${result.output}`);
    }
    // A sibling this runner terminated after the first failure is not a failure.
    if (controller.signal.aborted) return;
    if (result.code !== 0) {
      failures.push(name);
      console.error(`\n"${script}" failed in ${name}`);
      if (failure === undefined) {
        failure = result;
        if (stopEarly) for (const { controller: sibling } of running.values()) sibling.abort();
      }
      return;
    }
    if (label !== undefined && observedPeakMb !== undefined)
      builtPeaks.push([label, observedPeakMb]);
    done.add(name);
  };

  try {
    await startReady();
    while (running.size > 0) {
      await settleOne();
      await startReady();
    }
  } finally {
    for (const name of FORWARDED_SIGNALS) process.removeListener(name, onSignal);
  }
  recordPeaks(builtPeaks);
  writeTimings({ script, forwarded, startedAt, limit, tasks });

  if (stop.signal.aborted) {
    console.error(`"${script}" stopped by ${stop.signal.reason}`);
    return exitStatus({ code: null, signal: stop.signal.reason });
  }
  if (failure !== undefined) {
    if (failures.length > 1) {
      console.error(
        `\n"${script}" failed in ${failures.length} workspaces: ${failures.join(', ')}`,
      );
    }
    return exitStatus(failure);
  }
  if (done.size !== order.length) {
    console.error(`"${script}" did not reach every workspace`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
