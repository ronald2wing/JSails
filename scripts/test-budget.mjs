/**
 * How much of the machine budget (`scripts/machine-budget.mjs`) one
 * workspace's test run asks for, from what earlier runs recorded.
 *
 * A test run is one lease (a lane), taken by the workspace runner when it
 * starts the workspace, or by `scripts/run-tests.mjs` itself when a workspace
 * is run directly. Leasing per lane rather than per test file keeps a waiting
 * checkout down to a few orchestrator processes instead of dozens of started
 * and blocked test processes, and needs one lock round per workspace.
 *
 * - A file's estimate is 1.2 times its last recorded `treeMb` (the private
 *   memory of the test process and everything it started, sampled from
 *   `/proc`), else its `rssMb` (its own peak RSS, which counts shared pages
 *   and so overestimates), else the median of the workspace's other
 *   estimates, else {@link DEFAULT_FILE_MB}.
 * - The lane's overhead (npm, run-tests and the `node --test` orchestrator,
 *   which grows under coverage) is 1.2 times its recorded `runnerMb` plus the
 *   npm wrapper, else {@link DEFAULT_OVERHEAD_MB}.
 * - `cpu.want` is the workspace's share of the CPU slots (run-workspaces'
 *   `nextShare`) and `mb.want` the overhead plus the `cpu.want` largest file
 *   estimates. `need` is the concurrency at which the workspace's recorded
 *   serial wall time fits in half the run limit, so a small grant can never
 *   turn into a run-limit failure, with the matching memory. Without a
 *   recorded wall time (a fresh checkout, every CI job) nothing says a
 *   smaller grant would finish in time, so `need` is the whole `want`: the
 *   lane waits for its share rather than starting narrow. A grant is fixed
 *   for the lane's whole run; slots freed later are not added to it.
 * - The run's `--test-concurrency` is then the CPU grant, lowered to what the
 *   memory grant holds of the 75th-percentile file.
 *
 * Records: `test-results/timings.json` (a plain run) and
 * `test-results/timings-test-coverage.json` (a coverage run); the matching
 * mode's record is preferred, the other is the fallback, so a checkout that
 * only ever runs `check` still has weights.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_PEAK_MB, PEAK_MARGIN } from './process-tree.mjs';
import { repoRoot } from './workspaces.mjs';

/** A test file's estimate when nothing is recorded for its workspace (MiB). */
export const DEFAULT_FILE_MB = DEFAULT_PEAK_MB['test-file'];
/** A lane's overhead without a record (MiB); a coverage orchestrator holds every file's counts. */
export const DEFAULT_OVERHEAD_MB = Object.freeze({ plain: 200, coverage: 450 });
/** npm and its shell, which wrap run-tests when the workspace runner starts it (MiB). */
export const NPM_WRAPPER_MB = 100;
/** Twice the parallelism: test files mostly wait on child processes and timers. */
export const TEST_BUDGET_FACTOR = 2;

/** The timing record file of a test run: plain, coverage, or the database suite. */
export function timingsRecordName({ coverage = false, database = false } = {}) {
  if (database) return 'timings-test-database.json';
  return coverage ? 'timings-test-coverage.json' : 'timings.json';
}

function readTimings(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    return record.script === 'test' && Array.isArray(record.files) && record.files.length > 0
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}

/** The previous test timing record: the matching mode's, else the other mode's, else undefined. */
export function previousTimings({ coverage = false, root = repoRoot } = {}) {
  const dir = join(root, 'test-results');
  return (
    readTimings(join(dir, timingsRecordName({ coverage }))) ??
    readTimings(join(dir, timingsRecordName({ coverage: !coverage })))
  );
}

function median(values) {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The `fraction` quantile of `values` (nearest rank). */
export function quantile(values, fraction) {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

function recordedEstimate(file) {
  if (Number.isFinite(file?.treeMb) && file.treeMb > 0) return file.treeMb * PEAK_MARGIN;
  if (Number.isFinite(file?.rssMb) && file.rssMb > 0) return file.rssMb;
  return undefined;
}

/**
 * The memory estimate (MiB) of each of `files` (repo-relative test sources)
 * of `workspace`, from `previous` (a timing record), in the order given.
 */
export function fileEstimates(workspace, files, previous) {
  const recorded = new Map();
  for (const file of previous?.files ?? []) {
    if (file.workspace !== workspace) continue;
    const estimate = recordedEstimate(file);
    if (estimate !== undefined) recorded.set(file.file, estimate);
  }
  const fallback = median([...recorded.values()]) ?? DEFAULT_FILE_MB;
  return files.map((file) => Math.ceil(recorded.get(file) ?? fallback));
}

/**
 * `count` file estimates for `workspace` when only its number of test files
 * is known (the workspace runner does not list them): its recorded
 * estimates, largest first, padded with their median (or
 * {@link DEFAULT_FILE_MB}) for files without a record.
 */
export function workspaceEstimates(workspace, count, previous) {
  const recorded = (previous?.files ?? [])
    .filter((file) => file.workspace === workspace)
    .map(recordedEstimate)
    .filter((estimate) => estimate !== undefined)
    .sort((a, b) => b - a);
  const fallback = median(recorded) ?? DEFAULT_FILE_MB;
  return Array.from({ length: count }, (_, index) => Math.ceil(recorded[index] ?? fallback));
}

/** The summed recorded wall time of `workspace`'s files, or undefined without a record. */
export function serialWallMs(workspace, previous) {
  const walls = (previous?.files ?? [])
    .filter((file) => file.workspace === workspace && Number.isFinite(file.wallMs))
    .map((file) => file.wallMs);
  return walls.length === 0 ? undefined : walls.reduce((sum, ms) => sum + ms, 0);
}

/** The lane's overhead (MiB) from the recorded runner peak, else the default for the mode. */
export function laneOverheadMb(workspace, previous, { coverage = false, wrapped = true } = {}) {
  const task = (previous?.tasks ?? []).find((entry) => entry.workspace === workspace);
  if (Number.isFinite(task?.runnerMb) && task.runnerMb > 0) {
    return Math.ceil(task.runnerMb * PEAK_MARGIN + (wrapped ? NPM_WRAPPER_MB : 0));
  }
  return coverage ? DEFAULT_OVERHEAD_MB.coverage : DEFAULT_OVERHEAD_MB.plain;
}

/**
 * The lease request of a lane: `cpu: { need, want }` and `mb: { need, want }`
 * (see the module comment). `share` is the CPU share wanted; `fixed` a
 * concurrency the caller set, which is then both need and want.
 */
export function laneRequest({ estimates, share, overheadMb, serialMs, runLimitMs, fixed }) {
  const files = Math.max(1, estimates.length);
  const sorted = estimates.toSorted((a, b) => b - a);
  const memoryFor = (count) => overheadMb + sorted.slice(0, count).reduce((sum, mb) => sum + mb, 0);
  if (fixed !== undefined) {
    return {
      cpu: { need: fixed, want: fixed },
      mb: { need: memoryFor(fixed), want: memoryFor(fixed) },
    };
  }
  const want = Math.max(1, Math.min(share, files));
  const fitting = serialMs === undefined ? want : Math.ceil(serialMs / (runLimitMs / 2));
  const need = Math.max(1, Math.min(want, fitting));
  return { cpu: { need, want }, mb: { need: memoryFor(need), want: memoryFor(want) } };
}

/**
 * The `--test-concurrency` a grant allows: its CPU slots, lowered to the
 * number of 75th-percentile files its memory (less the overhead) holds, at
 * least one.
 */
export function laneConcurrency(grant, { estimates, overheadMb }) {
  const typical = quantile(estimates, 0.75) ?? DEFAULT_FILE_MB;
  const byMemory = Math.floor((grant.mb - overheadMb) / typical);
  return Math.max(1, Math.min(grant.cpu, byMemory));
}
