/**
 * Child-process primitives shared by the repo tooling: a promise-returning
 * `run` that forwards termination signals to the child, the exit status a
 * runner should report for a child's outcome, and the platform's `npm` command.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

/** The `npm` executable: a `.cmd` shim on Windows, a plain binary elsewhere. */
export const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const FORWARDED_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

/**
 * Spawns `cmd` and resolves with its outcome, `{ code, signal }`, once it has
 * exited; exactly one of the two is non-null. Rejects only when the process
 * could not be started. The child inherits stdio unless `stdio` says otherwise.
 *
 * With `forwardSignals` (the default) a SIGINT or SIGTERM delivered to this
 * process is re-sent to the child, so a runner killed from outside its
 * terminal's process group does not orphan the work it started. `signal` is an
 * `AbortSignal`; aborting it terminates the child with SIGTERM and the promise
 * resolves with that signal like any other signal exit.
 */
export function run(
  cmd,
  args,
  { cwd, env, stdio = 'inherit', forwardSignals = true, signal } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio, signal });

    const handlers = new Map(
      forwardSignals
        ? FORWARDED_SIGNALS.map((name) => [
            name,
            () => {
              if (child.exitCode === null && child.signalCode === null) child.kill(name);
            },
          ])
        : [],
    );
    for (const [name, handler] of handlers) process.on(name, handler);
    const release = () => {
      for (const [name, handler] of handlers) process.removeListener(name, handler);
    };

    child.on('exit', (code, exitSignal) => {
      release();
      resolve({ code, signal: exitSignal });
    });
    child.on('error', (error) => {
      // Aborting `signal` kills the child and also raises an AbortError here;
      // the `exit` event that follows carries the real outcome.
      if (error.name === 'AbortError') return;
      release();
      reject(error);
    });
  });
}

/**
 * The exit status a runner reports for a child's outcome: the child's own code,
 * or the shell convention `128 + signal number` when a signal ended it.
 */
export function exitStatus({ code, signal }) {
  if (signal !== null) return 128 + (constants.signals[signal] ?? 0);
  return code ?? 1;
}
