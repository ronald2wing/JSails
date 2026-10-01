/**
 * A measurement child with a deadline. The loaded-set probes and the bench
 * children run captured (their output is printed only when they fail), so a
 * child that never exits (an entry that leaves a live handle, a serve
 * scenario whose shutdown hangs) would otherwise stall its gate silently
 * until the CI job times out.
 *
 * `runBounded` spawns `node <args>` without a shell, captures stdout and
 * stderr interleaved, and kills the child with SIGKILL once `timeoutMs` has
 * passed: a hung graceful shutdown is exactly what a softer signal would wait
 * on. It resolves `{ code, signal, output, timedOut }`.
 */
import { spawn } from 'node:child_process';

export function runBounded(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output: Buffer.concat(chunks).toString('utf8'), timedOut });
    });
  });
}
