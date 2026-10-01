/**
 * Process trees from `/proc` metadata, and the peak-memory records the
 * machine budget sizes its leases from.
 *
 * Only `/proc/<pid>/stat` (parent and start time) and `/proc/<pid>/status`
 * (memory) are ever read, never `/proc/<pid>/environ`. Without `/proc`
 * (macOS, Windows) a snapshot is empty and a sample is `undefined`, and the
 * callers fall back to what a process reports about itself, which counts
 * shared pages and so overestimates: the safe direction for a budget.
 *
 * A tree's memory is its private resident memory, `RssAnon + RssShmem` summed
 * over its processes: the node binary's file-backed pages are shared by every
 * process, so summing RSS would count them once per process.
 *
 * Peaks are recorded per label (`lint:core`, `gate:bench`, `build:jsails`,
 * `test-file:...`) in `node_modules/.cache/jsails-budget/peaks.json`, the last
 * {@link PEAK_HISTORY} of each, and a lease asks for their maximum times
 * {@link PEAK_MARGIN}: sampling twice a second misses short spikes, and the
 * budget's live free-memory check covers what the margin does not. A label
 * with no record falls back to a category default in {@link DEFAULT_PEAK_MB},
 * each taken from a measurement of this repository's steps.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { repoRoot } from './workspaces.mjs';

const PROC = '/proc';
const KIB = 1024;

/** `{ pid, ppid, starttime }` from `<proc>/<pid>/stat`, or `null` when unreadable or gone. */
export function readProcStat(pid, { proc = PROC } = {}) {
  try {
    return parseProcStat(pid, readFileSync(join(proc, String(pid), 'stat'), 'utf8'));
  } catch {
    return null;
  }
}

/** Parses a `/proc/<pid>/stat` line; the command name may hold spaces and parentheses. */
export function parseProcStat(pid, stat) {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  // After "pid (comm) ", fields[0]=state, fields[1]=ppid, fields[19]=starttime.
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  return { pid, ppid: Number(fields[1]), starttime: Number(fields[19]) };
}

/** The private resident memory in a `/proc/<pid>/status` text, in KiB (`RssAnon + RssShmem`). */
export function parseStatusMemory(status) {
  let kib = 0;
  for (const match of status.matchAll(/^(RssAnon|RssShmem):\s+(\d+)\s+kB$/gm)) {
    kib += Number(match[2]);
  }
  return kib;
}

function readStatusMemory(pid, proc) {
  try {
    return parseStatusMemory(readFileSync(join(proc, String(pid), 'status'), 'utf8'));
  } catch {
    return 0; // exited between the snapshot and this read
  }
}

/** Every process in `<proc>` as `Map<pid, { pid, ppid, starttime }>`, or `undefined` without `/proc`. */
function processTable(proc) {
  let names;
  try {
    names = readdirSync(proc);
  } catch {
    return undefined;
  }
  const table = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const info = readProcStat(Number(name), { proc });
    if (info !== null) table.set(info.pid, info);
  }
  return table;
}

function childrenIndex(table) {
  const children = new Map();
  for (const info of table.values()) {
    const siblings = children.get(info.ppid);
    if (siblings === undefined) children.set(info.ppid, [info.pid]);
    else siblings.push(info.pid);
  }
  return children;
}

function descendants(rootPid, table, children) {
  const members = [];
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.pop();
    if (seen.has(pid) || !table.has(pid)) continue;
    seen.add(pid);
    members.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return members;
}

/**
 * The process tree rooted at `rootPids`, the roots plus every descendant, as a
 * `Map<pid, info>`; empty when `/proc` is unavailable.
 */
export function snapshotProcessTree(rootPids, { proc = PROC } = {}) {
  const table = processTable(proc);
  const members = new Map();
  if (table === undefined) return members;
  const children = childrenIndex(table);
  for (const root of rootPids) {
    for (const pid of descendants(root, table, children)) members.set(pid, table.get(pid));
  }
  return members;
}

/**
 * The private memory of the tree under `rootPid`, in MiB: `totalMb` for the
 * whole tree, and `byChild`, each direct child's subtree, by its pid. The
 * root's own memory is `totalMb` minus the children's. `undefined` without
 * `/proc` or once the root has exited.
 */
export function sampleTreeMemory(rootPid, { proc = PROC } = {}) {
  const table = processTable(proc);
  if (table === undefined || !table.has(rootPid)) return undefined;
  const children = childrenIndex(table);
  const memory = (pids) => pids.reduce((sum, pid) => sum + readStatusMemory(pid, proc), 0) / KIB;
  const byChild = new Map();
  let childTotal = 0;
  for (const child of children.get(rootPid) ?? []) {
    const mb = memory(descendants(child, table, children));
    byChild.set(child, mb);
    childTotal += mb;
  }
  return { totalMb: childTotal + memory([rootPid]), byChild };
}

/**
 * Samples the tree under `rootPid` every `intervalMs` from an unref'd timer.
 * `stop()` takes a last sample and returns the peaks: `peakMb` of the whole
 * tree (undefined when nothing was sampled), `childPeaks` per direct child's
 * pid, and `rootPeakMb`, the root's own memory at its highest.
 */
export function startTreeSampler(rootPid, { intervalMs = 500, sample = sampleTreeMemory } = {}) {
  let peakMb;
  let rootPeakMb;
  const childPeaks = new Map();
  const take = () => {
    const now = sample(rootPid);
    if (now === undefined) return;
    peakMb = Math.max(peakMb ?? 0, now.totalMb);
    let children = 0;
    for (const [pid, mb] of now.byChild) {
      childPeaks.set(pid, Math.max(childPeaks.get(pid) ?? 0, mb));
      children += mb;
    }
    rootPeakMb = Math.max(rootPeakMb ?? 0, now.totalMb - children);
  };
  take();
  const timer = setInterval(take, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      take();
      return { peakMb, rootPeakMb, childPeaks };
    },
  };
}

/** Where the per-label peak records live. */
export const PEAKS_FILE = join(repoRoot, 'node_modules', '.cache', 'jsails-budget', 'peaks.json');
/** How many recent peaks a label keeps. */
export const PEAK_HISTORY = 3;
/** A lease asks for the largest recent peak times this margin. */
export const PEAK_MARGIN = 1.2;

/**
 * Category defaults (MiB) for a label without a record, from this
 * repository's measurements (2026-11, scope anon+shmem peaks): a median test
 * file is 95 MiB and the 99th percentile 247; a gate up to 450 alone, 900-1300
 * with an inner pool; ESLint 3.7 GiB for core and 0.4-0.85 GiB for a package;
 * tsc 1.9 GiB for core and 0.1-0.45 GiB for a package; verify:starter 2.2 GiB
 * with its fixtures on disk.
 */
export const DEFAULT_PEAK_MB = Object.freeze({
  'test-file': 250,
  gate: 500,
  'gate-pool': 1000,
  'lint-core': 4000,
  'lint-package': 900,
  'build-core': 2000,
  'build-package': 450,
  starter: 2200,
});

/** The peak records, `{ <label>: number[] }` (empty when missing or unreadable). */
export function readPeaks(file = PEAKS_FILE) {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return record !== null && typeof record === 'object' && !Array.isArray(record) ? record : {};
  } catch {
    return {};
  }
}

/** `peaks` with `mb` appended to `label`'s history, keeping the last {@link PEAK_HISTORY}. */
export function withPeak(peaks, label, mb) {
  const history = Array.isArray(peaks[label]) ? peaks[label] : [];
  return { ...peaks, [label]: [...history, Math.round(mb)].slice(-PEAK_HISTORY) };
}

/**
 * Records `mb` as `label`'s latest peak. Concurrent writers may each drop the
 * other's latest value (read, change, rename), never corrupt the file: a lost
 * record only means the next lease uses an older peak or a default.
 */
export function recordPeaks(entries, file = PEAKS_FILE) {
  const valid = entries.filter(([, mb]) => Number.isFinite(mb) && mb > 0);
  if (valid.length === 0) return;
  let peaks = readPeaks(file);
  for (const [label, mb] of valid) peaks = withPeak(peaks, label, mb);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(peaks, null, 2)}\n`);
  renameSync(temporary, file);
}

/** What to ask for `label`: its largest recent peak times {@link PEAK_MARGIN}, else `fallbackMb`. */
export function peakEstimate(peaks, label, fallbackMb) {
  const history = Array.isArray(peaks[label]) ? peaks[label].filter(Number.isFinite) : [];
  if (history.length === 0) return fallbackMb;
  return Math.ceil(Math.max(...history) * PEAK_MARGIN);
}
