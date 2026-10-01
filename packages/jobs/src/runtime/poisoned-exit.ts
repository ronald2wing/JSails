/**
 * The default reaction to a poisoned worker: end the process with a non-zero
 * exit code, so its supervisor (a container restart policy, systemd) starts a
 * fresh one.
 *
 * A worker is poisoned when an aborted or timed-out attempt kept running past
 * its grace. Its job is still held, and nothing in the process can stop the
 * stuck code, so the only way to free the job without ever running it twice
 * at once is for the process to go: a shared transport's lock lapses once its
 * holder is dead, and only then is the job delivered again.
 *
 * It writes one value-free line to stderr (how many attempts the process
 * still holds) and sets the exit code first. When the host listens for
 * `SIGTERM` (its graceful shutdown path, as `jsails work` does), the process
 * sends itself one, with a backstop that exits anyway should that shutdown
 * hang on the stuck attempt; otherwise, and on Windows, which has no
 * catchable self-signal, it exits at once.
 *
 * A host's graceful path does not know the worker was poisoned and usually
 * ends by reporting success: `jsails work` returns 0 once its shutdown signal
 * arrives and the CLI writes that to `process.exitCode`, and a host may call
 * `process.exit(0)`. Either would restart nothing under an on-failure policy,
 * so an `exit` listener turns a success into code 75 as the process ends. A
 * failure code the host sets itself stands: it is already a restart.
 */

import type { PoisonedWorkerReport } from './runtime-worker.js';

/** `EX_TEMPFAIL`, the boundary table's exit code for a retryable failure. */
export const POISONED_EXIT_CODE = 75;

/** How long a host's graceful shutdown may take before the process exits anyway. */
export const POISONED_EXIT_BACKSTOP_MS = 10_000;

/** An `exit` listener: a process that would end with success ends with code 75. */
function keepPoisonedCode(code: number): void {
  // Node reads `process.exitCode` again after its `exit` listeners ran.
  if (code === 0) process.exitCode = POISONED_EXIT_CODE;
}

/**
 * End the process for a poisoned worker: exit code 75, through the host's
 * `SIGTERM` handler when it has one. A host that then ends with success
 * still exits with 75.
 *
 * @public
 */
export function exitPoisonedProcess(report: PoisonedWorkerReport): void {
  process.stderr.write(
    `jobs: a job attempt kept running past its grace; the worker stopped and the process exits with code ${POISONED_EXIT_CODE} (${report.held} attempts held)\n`,
  );
  process.exitCode = POISONED_EXIT_CODE;
  if (!process.listeners('exit').includes(keepPoisonedCode)) process.on('exit', keepPoisonedCode);
  if (process.platform === 'win32' || process.listenerCount('SIGTERM') === 0) {
    // No host shutdown path to run; the held attempts die with the process.
    process.exit(POISONED_EXIT_CODE);
  }
  setTimeout(() => process.exit(POISONED_EXIT_CODE), POISONED_EXIT_BACKSTOP_MS).unref();
  process.kill(process.pid, 'SIGTERM');
}
