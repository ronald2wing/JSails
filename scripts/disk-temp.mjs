/**
 * Temporary directories that live on disk rather than in memory, for tooling
 * that writes a lot of short-lived bytes: the V8 coverage dumps of a coverage
 * run (`scripts/run-tests.mjs`) and the generated apps of `verify:starter`.
 *
 * On many Linux systems (Arch, Fedora, this repository's development
 * machines) `os.tmpdir()` is a tmpfs, so every byte written there is RAM (or
 * swap) until it is deleted: a coverage run holds 1.7 GiB of dumps and
 * `verify:starter` 1.75 GiB of fixture trees. When the temporary directory is
 * a tmpfs, `diskBackedTempRoot` creates the directory under the user's cache
 * directory instead (`$XDG_CACHE_HOME/jsails/tmp`, else `~/.cache/jsails/tmp`),
 * which is outside every checkout, so module resolution from inside it can
 * never climb into a repository's `node_modules`. Anywhere else (macOS,
 * Windows, a disk-backed `/tmp`) it is an ordinary directory under
 * `os.tmpdir()`.
 *
 * Each directory is named `<label>-<pid>-<random>`. A run removes its own on
 * exit; one left behind by a killed run is removed by the next run's
 * `sweepStaleTempRoots`, once its process is gone and it is older than an
 * hour, so a crash cannot slowly fill the disk.
 *
 * A disk has less room than the tmpfs it replaces may have had, so a caller
 * whose writers fail quietly on a full disk (node's coverage dumps) samples
 * the free space while they run with `watchFreeSpace`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** `statfs` `f_type` of a tmpfs (linux/magic.h). */
export const TMPFS_MAGIC = 0x01021994;

/** How often `watchFreeSpace` samples. */
export const FREE_SPACE_SAMPLE_MS = 1000;

const MIB = 1024 * 1024;

/** How old a dead run's directory must be before a sweep removes it. */
export const STALE_AGE_MS = 60 * 60 * 1000;

const ROOT_NAME = /^[a-z0-9.-]+-(\d+)-[A-Za-z0-9]+$/;

/**
 * The directory disk-backed temporary roots go in, or `undefined` when
 * `tmp` itself is on disk (or the platform has no tmpfs to detect).
 */
export function diskTempBase({
  platform = process.platform,
  statfs = statfsSync,
  env = process.env,
  tmp = tmpdir(),
  home = homedir(),
} = {}) {
  if (platform !== 'linux') return undefined;
  let type;
  try {
    type = statfs(tmp).type;
  } catch {
    return undefined;
  }
  if (type !== TMPFS_MAGIC) return undefined;
  const cache =
    env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME !== ''
      ? env.XDG_CACHE_HOME
      : join(home, '.cache');
  return join(cache, 'jsails', 'tmp');
}

/** Whether process `pid` exists (EPERM: it exists under another user). */
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Removes the directories under `base` that a run left behind: named for a
 * process that no longer exists and last modified more than
 * {@link STALE_AGE_MS} ago. Returns the names removed.
 */
export function sweepStaleTempRoots(base, { now = Date.now(), alive = processExists } = {}) {
  let names;
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const match = ROOT_NAME.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || alive(pid)) continue;
    const path = join(base, name);
    try {
      if (now - statSync(path).mtimeMs < STALE_AGE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Removed by a concurrent sweep, or not ours to remove: leave it.
    }
  }
  return removed;
}

/**
 * Creates and returns a fresh temporary directory for `label` (lowercase,
 * digits, `.` and `-`) on disk: under {@link diskTempBase} when the
 * temporary directory is a tmpfs, else under it. The caller removes it.
 */
export function diskBackedTempRoot(label, options = {}) {
  const base = diskTempBase(options);
  if (base === undefined)
    return mkdtempSync(join(options.tmp ?? tmpdir(), `${label}-${process.pid}-`));
  mkdirSync(base, { recursive: true });
  sweepStaleTempRoots(base);
  return mkdtempSync(join(base, `${label}-${process.pid}-`));
}

/**
 * The path of a temporary root for `label` that the caller creates later
 * (`verify:starter` names its fixture directories when its modules load, and
 * creates them only when a stage runs): `<label>-<pid>-<time>` in the same
 * place {@link diskBackedTempRoot} uses. Sweeps stale roots from a disk-backed
 * base first.
 */
export function diskTempPath(label, { now = Date.now(), pid = process.pid, ...options } = {}) {
  const base = diskTempBase(options);
  if (base !== undefined && existsSync(base)) sweepStaleTempRoots(base, { now });
  return join(base ?? options.tmp ?? tmpdir(), `${label}-${pid}-${now.toString(36)}`);
}

/**
 * Samples the free space (for an unprivileged user) of the file system that
 * holds `path`, now and every {@link FREE_SPACE_SAMPLE_MS} until `stop()`,
 * which returns the lowest seen in MiB, or `undefined` when none could be
 * read (the path is gone, or the platform cannot tell).
 */
export function watchFreeSpace(
  path,
  { statfs = statfsSync, intervalMs = FREE_SPACE_SAMPLE_MS } = {},
) {
  let lowest;
  const sample = () => {
    try {
      const { bavail, bsize } = statfs(path);
      const mb = Math.floor((Number(bavail) * Number(bsize)) / MIB);
      if (Number.isFinite(mb)) lowest = lowest === undefined ? mb : Math.min(lowest, mb);
    } catch {
      // No reading this time: the lowest so far still stands.
    }
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      return lowest;
    },
  };
}
