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
 * in a stable topological order). That is one concurrency budget: each child
 * also gets `JSAILS_TEST_CONCURRENCY`, which `scripts/run-tests.mjs` passes to
 * node as `--test-concurrency`: a share of twice the available parallelism (test
 * files mostly wait on child processes and timers; their own CPU is about a
 * quarter of their wall time) in proportion to the workspace's test wall time
 * in the previous `test-results/timings.json`, or to its number of test files
 * when there is no record, at least 1 each. The heaviest suite starts first, so
 * it is not starved and the process count stays bounded. Setting the variable
 * yourself applies one value to every workspace.
 * Each workspace's output is buffered and printed whole when it finishes, so
 * concurrent logs never interleave. In a build the first failure stops the
 * run: no new workspace starts and the running ones are terminated, since their
 * dependents could not run anyway. Any other script runs every workspace to the
 * end and lists each one that failed, so one run reports every failure (a new
 * CI platform leg yields all of its ledger drafts at once, and no workspace's
 * results are cut short by another's). A workspace without the script is
 * skipped (and counts as finished for its dependents).
 *
 * A database-suite run (`test -- --suite=database`) fails before starting when
 * no workspace has a `test/**\/*.database.test.ts(x)` source: each workspace
 * would report an empty selection and pass, so a misnamed database test (or
 * none at all) would leave the database CI legs green while testing nothing.
 *
 * A `test` run writes `test-results/timings.json`: wall time per workspace,
 * and the per-file wall and CPU times `run-tests.mjs` recorded, with the
 * slowest files printed. Other scripts write `test-results/timings-<script>.json`.
 *
 * Usage: node scripts/run-workspaces.mjs <script> [-- <args forwarded to each workspace>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import { exitStatus, npm, run } from './subprocess.mjs';
import { readWorkspaces, repoRoot, topologicalOrder, workspaceGraph } from './workspaces.mjs';

const MAX_DEFAULT_JOBS = 8;
const SLOWEST_SHOWN = 20;
/** Scripts that emit what a dependent reads, and so run in dependency order. */
export const ORDERED_SCRIPTS = new Set(['build', 'build:clean']);

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

/** Twice the parallelism: see the header for why test files are oversubscribed. */
export const TEST_BUDGET_FACTOR = 2;

/**
 * Each workspace's `--test-concurrency`: its share of `budget` in proportion to
 * its weight, rounded up (a small suite with slow files must not become the
 * long pole by rounding down to 1), at least 1 and at most `budget`.
 */
export function testConcurrency(weights, budget) {
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  return new Map(
    [...weights].map(([name, weight]) => [
      name,
      total === 0 ? 1 : Math.min(budget, Math.max(1, Math.ceil((budget * weight) / total))),
    ]),
  );
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

/** The previous `test-results/timings.json`, or undefined. */
function previousTimings() {
  try {
    const record = JSON.parse(readFileSync(join(repoRoot, 'test-results', 'timings.json'), 'utf8'));
    return record.script === 'test' && Array.isArray(record.files) && record.files.length > 0
      ? record
      : undefined;
  } catch {
    return undefined;
  }
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
  if (!existsSync(dir)) return [];
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!name.endsWith('.json') || statSync(path).mtimeMs < since) continue;
    const record = JSON.parse(readFileSync(path, 'utf8'));
    for (const file of record.files) files.push({ workspace: record.workspace, ...file });
  }
  return files.sort((a, b) => b.wallMs - a.wallMs);
}

/**
 * The timing record's file: `timings.json` for a default-suite test run (the
 * record the next run weighs its concurrency by), `timings-<script>.json`
 * otherwise (`timings-test-database.json` for the database suite).
 */
export function timingsFileName(script, forwarded) {
  if (script === 'test') {
    return forwarded.includes('--suite=database') ? 'timings-test-database.json' : 'timings.json';
  }
  return `timings-${script.replace(/[^a-z0-9]+/gi, '-')}.json`;
}

/** Writes the timing record and prints the slowest test files. */
function writeTimings({ script, forwarded, startedAt, limit, concurrency, tasks }) {
  const files = script === 'test' ? testFileTimings(startedAt) : [];
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
        testConcurrency: concurrency?.get(task.workspace),
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
  const fileCounts =
    script === 'test'
      ? new Map([...workspaces].map(([name, { dir }]) => [name, countTestFiles(dir)]))
      : new Map();
  const weights = testWeights(fileCounts, script === 'test' ? previousTimings() : undefined);
  const order = startOrder(script, topological, weights);
  const fixed = process.env.JSAILS_TEST_CONCURRENCY;
  const concurrency =
    script !== 'test'
      ? undefined
      : fixed !== undefined && fixed !== ''
        ? new Map(order.map((name) => [name, Number(fixed)]))
        : testConcurrency(weights, TEST_BUDGET_FACTOR * availableParallelism());
  const startedAt = Date.now();
  const tasks = [];
  const done = new Set();
  const running = new Map();
  const stopEarly = ORDERED_SCRIPTS.has(script);
  const failures = [];
  let failure;

  /** Start every workspace whose dependencies have all finished, in start order. */
  const startReady = () => {
    for (const name of order) {
      if ((stopEarly && failure !== undefined) || running.size >= limit) return;
      if (done.has(name) || running.has(name) || failures.includes(name)) continue;
      if (![...graph.get(name)].every((dep) => done.has(dep))) continue;
      if (workspaces.get(name).manifest.scripts?.[script] === undefined) {
        done.add(name);
        continue;
      }
      const controller = new AbortController();
      const args = ['run', script, '--workspace', name];
      if (forwarded.length > 0) args.push('--', ...forwarded);
      const env = { ...process.env };
      if (concurrency !== undefined) env.JSAILS_TEST_CONCURRENCY = String(concurrency.get(name));
      const outcome = run(npm, args, {
        cwd: repoRoot,
        env,
        signal: controller.signal,
        capture: limit > 1,
      });
      running.set(name, { controller, outcome, started: Date.now() });
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
    const { controller, started } = running.get(name);
    running.delete(name);
    tasks.push({ workspace: name, wallMs: Date.now() - started, code: result.code });
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
    done.add(name);
  };

  startReady();
  while (running.size > 0) {
    await settleOne();
    startReady();
  }
  writeTimings({ script, forwarded, startedAt, limit, concurrency, tasks });

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
