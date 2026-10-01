/**
 * Runs one npm script in every workspace, each only after the workspaces it
 * depends on.
 *
 * `npm run <script> --workspaces` visits workspaces in glob order, which builds
 * `@jsails/admin` before the `@jsails/auth` it imports. This runner derives the
 * dependency graph from each workspace's declared dependencies instead, so
 * adding a package never means editing a hand-maintained chain, and an
 * undeclared or cyclic edge fails loudly here rather than working by accident
 * of ordering.
 *
 * Independent workspaces run concurrently: a workspace starts as soon as every
 * workspace it depends on has finished, up to `JSAILS_WORKSPACE_JOBS` at once
 * (default: the machine's available parallelism, at most 8; `1` runs them one
 * at a time in a stable topological order). Each workspace's output is
 * buffered and printed whole when it finishes, so concurrent logs never
 * interleave. The first failure stops the run: no new workspace starts and the
 * running ones are terminated. A workspace without the script is skipped (and
 * counts as finished for its dependents).
 *
 * Usage: node scripts/run-workspaces.mjs <script>
 */
import { availableParallelism } from 'node:os';

import { exitStatus, npm, run } from './subprocess.mjs';
import { readWorkspaces, repoRoot, topologicalOrder, workspaceGraph } from './workspaces.mjs';

const MAX_DEFAULT_JOBS = 8;

const [script, ...rest] = process.argv.slice(2);
if (script === undefined || rest.length > 0) {
  console.error('Usage: node scripts/run-workspaces.mjs <script>');
  process.exit(2);
}

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

const workspaces = readWorkspaces();

let order;
const graph = workspaceGraph(workspaces);
try {
  order = topologicalOrder(graph);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const limit = jobLimit();

const done = new Set();
const running = new Map();
let failure;

/** Start every workspace whose dependencies have all finished, in topological order. */
function startReady() {
  for (const name of order) {
    if (failure !== undefined || running.size >= limit) return;
    if (done.has(name) || running.has(name)) continue;
    if (![...graph.get(name)].every((dep) => done.has(dep))) continue;
    if (workspaces.get(name).manifest.scripts?.[script] === undefined) {
      done.add(name);
      continue;
    }
    const controller = new AbortController();
    const outcome = run(npm, ['run', script, '--workspace', name], {
      cwd: repoRoot,
      signal: controller.signal,
      capture: limit > 1,
    });
    running.set(name, { controller, outcome });
  }
}

/** Wait for any running workspace and record its result. */
async function settleOne() {
  const [name, result] = await Promise.race(
    [...running].map(([entry, { outcome }]) =>
      outcome.then(
        (value) => [entry, value],
        (error) => [entry, { code: 1, signal: null, output: `${error.message}\n` }],
      ),
    ),
  );
  const { controller } = running.get(name);
  running.delete(name);
  if (result.output !== undefined && result.output !== '') {
    process.stdout.write(`\n── ${name} (${script}) ──\n${result.output}`);
  }
  // A sibling this runner terminated after the first failure is not a failure.
  if (controller.signal.aborted) return;
  if (result.code !== 0) {
    if (failure === undefined) {
      failure = result;
      console.error(`\n"${script}" failed in ${name}`);
      for (const { controller: sibling } of running.values()) sibling.abort();
    }
    return;
  }
  done.add(name);
}

startReady();
while (running.size > 0) {
  await settleOne();
  startReady();
}

if (failure !== undefined) process.exit(exitStatus(failure));
if (done.size !== order.length) {
  console.error(`"${script}" did not reach every workspace`);
  process.exit(1);
}
