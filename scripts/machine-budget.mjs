/**
 * One memory and CPU budget per machine, shared by every checkout's checks.
 *
 * Each heavy step (a workspace's test run or build, a lint group, a gate, a
 * wrapped command) takes a lease before it starts and releases it when it
 * ends. Leases are files in one per-user directory, so two checkouts running
 * `npm run check` at once share the machine instead of each sizing its
 * parallelism from the core count and together exhausting memory.
 *
 * Configuration (`budgetConfig`):
 *
 * - memory: `JSAILS_MEMORY_BUDGET_MB`, else 60% of the machine's memory (or of
 *   the cgroup limit the process runs under, when that is lower);
 * - CPU slots: `JSAILS_CPU_BUDGET`, else twice the available parallelism (test
 *   files mostly wait on child processes and timers);
 * - reserve: the larger of 1 GiB and 10% of the memory; a lease is granted
 *   only while the machine's live free memory stays above it, so a wrong
 *   estimate or a process that takes no lease lowers throughput instead of
 *   overcommitting;
 * - `JSAILS_BUDGET=off` takes no lease at all (a notice says so once), as an
 *   escape hatch for debugging.
 *
 * The directory is `JSAILS_BUDGET_DIR`, else `$XDG_RUNTIME_DIR/jsails-budget`
 * on Linux, `~/Library/Caches/jsails/budget` on macOS,
 * `%LOCALAPPDATA%\jsails\budget` on Windows, and `~/.cache/jsails/budget`
 * otherwise; never `os.tmpdir()`, which differs between shells and which the
 * coverage runner changes on purpose, so it would split the budget silently.
 *
 * A request names a range, `mb: { need, want }` and `cpu: { need, want }`, and
 * the grant is the largest amount in it that fits what is free, so a checkout
 * alone gets the whole machine and several share it. Requests are served
 * first come, first served: only the oldest live waiter is considered, so a
 * large request is never starved by small ones. When no other lease is live,
 * the oldest waiter is admitted with at least its `need`, even beyond the
 * budget, so nothing can deadlock and the heaviest single step can always run
 * alone.
 *
 * Decisions are made under a lock directory (`mkdir` is atomic everywhere).
 * A lock whose owner is dead, or that is older than {@link LOCK_STALE_MS}, is
 * broken by renaming it away. A lease or a waiter is dead when its process is
 * gone; on Linux also when the process start time in `/proc` differs from the
 * one it recorded (the PID was reused); and elsewhere when its heartbeat (the
 * file's mtime, refreshed every {@link HEARTBEAT_MS}) is older than
 * {@link HEARTBEAT_STALE_MS}. Every misjudgement frees too little, never too
 * much. A holder releases its lease explicitly and on `exit`; one that is
 * killed is reclaimed by the next process that reads the directory.
 *
 * A waiter refreshes its mtime on every poll, so one that has not polled for
 * {@link WAITER_STALE_MS} is suspended (Ctrl-Z, SIGSTOP, a debugger pause) and
 * is dropped from the queue on every platform, even though its process is
 * alive: it holds nothing, and at the head it would block every checkout. A
 * dropped waiter that resumes writes its record again and rejoins in its old
 * place.
 *
 * A holder passes `JSAILS_BUDGET_HOLDER=<its pid>` to the processes it starts,
 * and `JSAILS_JOBS=<its CPU grant>`. A descendant of a live holder takes no
 * lease of its own, because its memory is part of the holder's estimate, so
 * nested runs (a tooling test that starts the test runner, a fixture build
 * inside verify:starter) cannot deadlock. Inner pools size themselves with
 * `jobShare`, so nested pools take a share instead of multiplying.
 *
 * Usage: node scripts/machine-budget.mjs   prints the budget, the leases and the waiters
 */
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const MIB = 1024 * 1024;
/** A lock older than this is broken, whoever holds it: a decision takes milliseconds. */
export const LOCK_STALE_MS = 10_000;
/** How often a holder refreshes its lease's mtime. */
export const HEARTBEAT_MS = 15_000;
/** Where no start time can be read, a lease whose heartbeat is older than this is dead. */
export const HEARTBEAT_STALE_MS = 120_000;
/** A waiter that has not polled for this long is suspended, and leaves the queue. */
export const WAITER_STALE_MS = 30_000;
/** A waiter announces itself once it has waited this long. */
const WAIT_NOTICE_MS = 2_000;
const POLL_MS = 50;
const POLL_SPREAD_MS = 150;

class BudgetConfigError extends Error {}

function positiveInteger(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BudgetConfigError(`${name} must be a positive integer`);
  }
  return parsed;
}

/** The machine's memory in MiB: the cgroup limit when one is set and lower. */
export function machineMemoryMb({
  totalMemory = totalmem(),
  constrainedMemory = process.constrainedMemory?.(),
} = {}) {
  const limit =
    typeof constrainedMemory === 'number' && constrainedMemory > 0 ? constrainedMemory : Infinity;
  return Math.floor(Math.min(totalMemory, limit) / MIB);
}

/** The budget: `{ enabled, memoryMb, cpu, reserveMb }` (see the module comment). */
export function budgetConfig(env = process.env, machine = {}) {
  const memory = machineMemoryMb(machine);
  const parallelism = machine.parallelism ?? availableParallelism();
  return {
    enabled: env.JSAILS_BUDGET !== 'off',
    memoryMb: positiveInteger(env, 'JSAILS_MEMORY_BUDGET_MB') ?? Math.floor(0.6 * memory),
    cpu: positiveInteger(env, 'JSAILS_CPU_BUDGET') ?? 2 * parallelism,
    reserveMb: Math.max(1024, Math.floor(0.1 * memory)),
  };
}

/** The per-user lease directory (see the module comment). */
export function budgetDir(
  env = process.env,
  { platform = process.platform, home = homedir() } = {},
) {
  if (env.JSAILS_BUDGET_DIR) return env.JSAILS_BUDGET_DIR;
  if (platform === 'linux' && env.XDG_RUNTIME_DIR) {
    return join(env.XDG_RUNTIME_DIR, 'jsails-budget');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'jsails', 'budget');
  if (platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'jsails', 'budget');
  return join(home, '.cache', 'jsails', 'budget');
}

/** A process's start time from `/proc/<pid>/stat` (Linux), or `null` where none can be read. */
export function processStartTime(pid, { platform = process.platform } = {}) {
  if (platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/** Whether process `pid` exists (EPERM: it exists under another user). */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * How many jobs an inner pool of at most `max` runs: the CPU grant a holder
 * passed down as `JSAILS_JOBS`, else the available parallelism, capped at `max`.
 */
export function jobShare(max, { env = process.env, parallelism = availableParallelism() } = {}) {
  const granted = Number(env.JSAILS_JOBS);
  const base = Number.isInteger(granted) && granted > 0 ? granted : parallelism;
  return Math.max(1, Math.min(max, base));
}

function range(value, name) {
  const need = Math.max(1, Math.ceil(value?.need ?? 1));
  const want = Math.max(need, Math.ceil(value?.want ?? need));
  if (!Number.isFinite(need) || !Number.isFinite(want)) {
    throw new TypeError(`acquire: ${name} needs finite need and want`);
  }
  return { need, want };
}

function readRecord(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined; // removed by its owner or a reaper between the listing and the read
  }
}

/** Writes `value` as JSON under `path` atomically, so a reader never sees half a record. */
function writeRecord(path, value) {
  const temporary = join(path, '..', `.tmp-${randomUUID()}`);
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

/** Refreshes `path`'s mtime; false when the file is gone. */
function touch(path, now) {
  try {
    const at = new Date(now());
    utimesSync(path, at, at);
    return true;
  } catch {
    return false; // released or reaped: there is nothing left to keep alive
  }
}

/**
 * The liveness rules (see the module comment), with the process checks and
 * the clock injectable.
 */
export function recordIsLive(record, mtimeMs, { now, alive, startTime }) {
  if (!Number.isInteger(record?.pid) || !alive(record.pid)) return false;
  const current = startTime(record.pid);
  if (record.start !== null && record.start !== undefined && current !== null) {
    return current === record.start;
  }
  return now() - mtimeMs <= HEARTBEAT_STALE_MS;
}

/**
 * The live leases and waiters in `dir`, the waiters oldest first; dead ones,
 * and waiters that stopped polling, are removed on the way.
 */
export function liveEntries(dir, deps) {
  const leases = [];
  const waiters = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { leases, waiters };
  }
  for (const name of names) {
    const isLease = name.startsWith('lease-');
    if (!isLease && !name.startsWith('wait-')) continue;
    const path = join(dir, name);
    const record = readRecord(path);
    let mtimeMs;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (record === undefined) continue;
    const stalled = !isLease && deps.now() - mtimeMs > WAITER_STALE_MS;
    if (stalled || !recordIsLive(record, mtimeMs, deps)) {
      rmSync(path, { force: true });
      continue;
    }
    (isLease ? leases : waiters).push({ ...record, path, name });
  }
  waiters.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { leases, waiters };
}

/** Whether the lock directory may be broken: its owner is dead, or it is too old. */
function lockIsStale(lock, deps) {
  let mtimeMs;
  try {
    mtimeMs = statSync(lock).mtimeMs;
  } catch {
    return false; // released meanwhile: try to take it again
  }
  if (deps.now() - mtimeMs > LOCK_STALE_MS) return true;
  const owner = readRecord(join(lock, 'owner'));
  // No owner file yet: its owner is between mkdir and the write.
  if (owner === undefined) return false;
  return !recordIsLive(owner, deps.now(), deps);
}

/** Runs the synchronous `decide` under the directory's lock. */
async function withLock(dir, decide, deps) {
  const lock = join(dir, 'lock');
  const token = randomUUID();
  for (;;) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (lockIsStale(lock, deps)) {
        const doomed = `${lock}.stale-${randomUUID()}`;
        try {
          renameSync(lock, doomed); // atomic: only one breaker wins
          rmSync(doomed, { recursive: true, force: true });
        } catch {
          // Another process broke or released it first.
        }
        continue;
      }
      await deps.sleep(5 + Math.random() * 20);
      continue;
    }
    try {
      writeRecord(join(lock, 'owner'), { pid: deps.pid, start: deps.startTime(deps.pid), token });
      return decide();
    } finally {
      // Remove the lock only while it is still ours: had it been broken as
      // stale, the directory now belongs to the next owner.
      if (readRecord(join(lock, 'owner'))?.token === token) {
        const doomed = `${lock}.released-${token}`;
        try {
          renameSync(lock, doomed);
          rmSync(doomed, { recursive: true, force: true });
        } catch {
          // Broken by a reaper between the check and the rename.
        }
      }
    }
  }
}

function clamp(value, { need, want }) {
  return Math.max(need, Math.min(want, Math.floor(value)));
}

/**
 * The grant for the head waiter, or `undefined` while it must wait: the
 * largest amounts within its ranges that fit the free budget, the live free
 * memory above the reserve, and the free CPU slots; at least `need` when no
 * other lease is live.
 */
export function decideGrant({ leases, config, availableMb, mb, cpu }) {
  const heldMb = leases.reduce((sum, lease) => sum + (lease.mb ?? 0), 0);
  const heldCpu = leases.reduce((sum, lease) => sum + (lease.cpu ?? 0), 0);
  const freeMb = Math.min(config.memoryMb - heldMb, availableMb - config.reserveMb);
  const freeCpu = config.cpu - heldCpu;
  if (leases.length === 0) return { mb: clamp(freeMb, mb), cpu: clamp(freeCpu, cpu) };
  if (freeMb < mb.need || freeCpu < cpu.need) return undefined;
  return { mb: clamp(freeMb, mb), cpu: clamp(freeCpu, cpu) };
}

let offNoticeShown = false;
let waitSequence = 0;

function liveAvailableMb(availableMemory) {
  const bytes = availableMemory();
  return typeof bytes === 'number' && bytes > 0 ? Math.floor(bytes / MIB) : Infinity;
}

/**
 * Waits for a lease and resolves with the grant:
 * `{ mb, cpu, waitedMs, nested, env, release() }`, where `env` holds the
 * variables to pass to the processes the holder starts. With
 * `JSAILS_BUDGET=off`, or under a live holder (`nested: true`), it resolves at
 * once with the wanted amounts and takes no lease. `signal` aborts the wait.
 *
 * `deps` injects the environment, the directory, the configuration, the
 * clock, the live free memory (bytes), the process checks and `sleep`.
 */
export async function acquire(request, deps = {}) {
  const env = deps.env ?? process.env;
  const config = deps.config ?? budgetConfig(env);
  const mb = range(request.mb, 'mb');
  const cpu = range(request.cpu, 'cpu');
  const label = request.label ?? '';
  const pid = deps.pid ?? process.pid;
  const context = {
    pid,
    now: deps.now ?? Date.now,
    alive: deps.alive ?? processAlive,
    startTime: deps.startTime ?? processStartTime,
    sleep: deps.sleep ?? ((ms) => delay(ms)),
  };
  const passThrough = (nested) => ({
    mb: mb.want,
    cpu: nested ? jobShare(cpu.want, { env }) : cpu.want,
    waitedMs: 0,
    nested,
    env: {},
    release() {},
  });
  if (!config.enabled) {
    if (!offNoticeShown) {
      offNoticeShown = true;
      process.stderr.write('[budget] JSAILS_BUDGET=off: this run takes no machine-wide lease\n');
    }
    return passThrough(false);
  }
  const holder = Number(env.JSAILS_BUDGET_HOLDER);
  if (Number.isInteger(holder) && holder > 0 && holder !== pid && context.alive(holder)) {
    return passThrough(true);
  }

  const dir = deps.dir ?? budgetDir(env);
  const availableMemory = deps.availableMemory ?? (() => process.availableMemory?.());
  mkdirSync(dir, { recursive: true });
  const token = randomUUID();
  const at = context.now();
  const start = context.startTime(pid);
  // Two requests of one process in the same millisecond keep their call order:
  // waiters with equal times sort by name, and the sequence comes first in it.
  waitSequence += 1;
  const sequence = String(waitSequence).padStart(9, '0');
  const waitPath = join(
    dir,
    `wait-${String(at).padStart(15, '0')}-${sequence}-${pid}-${token}.json`,
  );
  const leasePath = join(dir, `lease-${pid}-${token}.json`);
  const cleanup = () => {
    rmSync(waitPath, { force: true });
    rmSync(leasePath, { force: true });
  };
  process.once('exit', cleanup);
  const waitRecord = { pid, start, label, at, mb, cpu };
  writeRecord(waitPath, waitRecord);

  let grant;
  let announced = false;
  // One listener for the whole wait, not one per poll.
  const aborted =
    deps.signal === undefined
      ? undefined
      : new Promise((resolve) => {
          deps.signal.addEventListener('abort', resolve, { once: true });
        });
  try {
    for (;;) {
      deps.signal?.throwIfAborted();
      grant = await withLock(
        dir,
        () => {
          // This waiter is alive by definition: refresh it before judging the
          // others, or rejoin if it was dropped while suspended.
          if (!touch(waitPath, context.now)) writeRecord(waitPath, waitRecord);
          const { leases, waiters } = liveEntries(dir, context);
          if (waiters[0]?.path !== waitPath) return undefined;
          const decided = decideGrant({
            leases,
            config,
            availableMb: liveAvailableMb(availableMemory),
            mb,
            cpu,
          });
          if (decided === undefined) return undefined;
          writeRecord(leasePath, { pid, start, label, at: context.now(), ...decided });
          rmSync(waitPath, { force: true });
          return decided;
        },
        context,
      );
      if (grant !== undefined) break;
      if (!announced && context.now() - at >= WAIT_NOTICE_MS) {
        announced = true;
        process.stderr.write(
          `[budget] ${label || 'a step'} is waiting for ${mb.need}-${mb.want} MiB and ${cpu.need}-${cpu.want} CPU slots (budget ${config.memoryMb} MiB, ${config.cpu} slots; node scripts/machine-budget.mjs lists the leases)\n`,
        );
      }
      const pause = context.sleep(POLL_MS + Math.random() * POLL_SPREAD_MS);
      await (aborted === undefined ? pause : Promise.race([pause, aborted]));
    }
  } catch (error) {
    cleanup();
    process.removeListener('exit', cleanup);
    throw error;
  }

  const heartbeat = setInterval(
    () => touch(leasePath, context.now),
    deps.heartbeatMs ?? HEARTBEAT_MS,
  );
  heartbeat.unref();
  let released = false;
  return {
    ...grant,
    waitedMs: context.now() - at,
    nested: false,
    env: { JSAILS_BUDGET_HOLDER: String(pid), JSAILS_JOBS: String(grant.cpu) },
    release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      cleanup();
      process.removeListener('exit', cleanup);
    },
  };
}

/** The live leases and waiters, for diagnostics. */
export function snapshot(dir = budgetDir()) {
  return liveEntries(dir, {
    now: Date.now,
    alive: processAlive,
    startTime: processStartTime,
  });
}

if (import.meta.main) {
  try {
    const config = budgetConfig();
    const dir = budgetDir();
    const { leases, waiters } = snapshot(dir);
    console.log(
      `budget ${config.enabled ? 'on' : 'off'}: ${config.memoryMb} MiB, ${config.cpu} CPU slots, reserve ${config.reserveMb} MiB (${dir})`,
    );
    for (const lease of leases) {
      console.log(`  lease  pid ${lease.pid}  ${lease.mb} MiB  ${lease.cpu} CPU  ${lease.label}`);
    }
    for (const waiter of waiters) {
      console.log(
        `  waits  pid ${waiter.pid}  ${waiter.mb.need}-${waiter.mb.want} MiB  ${waiter.cpu.need}-${waiter.cpu.want} CPU  ${waiter.label}`,
      );
    }
  } catch (error) {
    console.error(error instanceof BudgetConfigError ? error.message : (error.stack ?? error));
    process.exitCode = error instanceof BudgetConfigError ? 2 : 1;
  }
}
