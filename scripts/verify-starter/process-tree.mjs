/**
 * Leak detection for the dev toolchain's process tree, from `/proc` metadata
 * only (read through `scripts/process-tree.mjs`). A tree is snapshotted
 * before its root is torn down (afterwards the detached children re-parent to
 * init and vanish from a walk), then the
 * captured members are given time to exit and any straggler is killed. Only
 * `/proc/<pid>/stat` is ever read, never `/proc/<pid>/environ`, and only a PID
 * captured as a descendant is ever signalled; its `starttime` guards against
 * the kernel having recycled the PID for an unrelated process. Without `/proc`
 * the snapshot is empty and the check is explicitly limited, never a claim.
 */
import { readProcStat, snapshotProcessTree } from '../process-tree.mjs';
import { sleep } from './processes.mjs';

export { snapshotProcessTree };

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
