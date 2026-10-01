/**
 * Leak detection for the dev toolchain's process tree, from `/proc` metadata
 * only. A tree is snapshotted before its root is torn down (afterwards the
 * detached children re-parent to init and vanish from a walk), then the
 * captured members are given time to exit and any straggler is killed. Only
 * `/proc/<pid>/stat` is ever read, never `/proc/<pid>/environ`, and only a PID
 * captured as a descendant is ever signalled; its `starttime` guards against
 * the kernel having recycled the PID for an unrelated process. Without `/proc`
 * the snapshot is empty and the check is explicitly limited, never a claim.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { sleep } from './processes.mjs';

/** `{ pid, ppid, starttime }` from `/proc/<pid>/stat`, or `null` when unreadable or gone. */
function readProcStat(pid) {
  try {
    const stat = readFileSync(join('/proc', String(pid), 'stat'), 'utf8');
    const close = stat.lastIndexOf(')');
    if (close === -1) return null;
    // After "pid (comm) ", fields[0]=state, fields[1]=ppid, fields[19]=starttime.
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    return { pid, ppid: Number(fields[1]), starttime: Number(fields[19]) };
  } catch {
    return null;
  }
}

/**
 * The process tree rooted at `rootPids`, the roots plus every descendant, as a
 * `Map<pid, info>`; empty when `/proc` is unavailable.
 */
export function snapshotProcessTree(rootPids) {
  let names;
  try {
    names = readdirSync('/proc');
  } catch {
    return new Map();
  }
  const table = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const info = readProcStat(pid);
    if (info !== null) table.set(pid, info);
  }
  const members = new Map();
  const queue = [...rootPids];
  while (queue.length > 0) {
    const pid = queue.pop();
    if (members.has(pid)) continue;
    const info = table.get(pid);
    if (info === undefined) continue;
    members.set(pid, info);
    for (const [childPid, childInfo] of table) {
      if (childInfo.ppid === pid && !members.has(childPid)) queue.push(childPid);
    }
  }
  return members;
}

/** Members of `snapshot` still alive under the same `starttime`. */
function liveSnapshotMembers(snapshot) {
  const alive = [];
  for (const { pid, starttime } of snapshot.values()) {
    const info = readProcStat(pid);
    if (info !== null && info.starttime === starttime) alive.push({ pid, starttime });
  }
  return alive;
}

/** Waits up to `timeoutMs` for the captured processes to exit; resolves with the stragglers. */
export async function settleProcessTree(snapshot, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let leaked = liveSnapshotMembers(snapshot);
  while (leaked.length > 0 && Date.now() < deadline) {
    await sleep(250);
    leaked = liveSnapshotMembers(snapshot);
  }
  return leaked;
}

/** SIGKILLs the stragglers that still carry their captured `starttime`; returns the PIDs killed. */
export function killLeakedProcesses(leaked) {
  const killed = [];
  for (const { pid, starttime } of leaked) {
    const info = readProcStat(pid);
    if (info === null || info.starttime !== starttime) continue; // PID recycled.
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // Already exited between the check and the kill.
    }
  }
  return killed;
}
