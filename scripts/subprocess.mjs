/**
 * Child-process primitives shared by the repo tooling: a promise-returning
 * `run` that forwards termination signals to the child, the exit status a
 * runner should report for a child's outcome, the `npm` command, and
 * `spawnable`, which turns `npm` into something Node can spawn on every
 * platform.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants } from 'node:os';
import { win32 } from 'node:path';

/** The `npm` command name every script passes to `run`/`spawnable`. */
export const npm = 'npm';

/**
 * npm's own JavaScript entry on Windows: the one npm exports to the scripts it
 * runs (`npm_execpath`; under npx that is `npx-cli.js`, beside `npm-cli.js`,
 * and another package manager's entry such as `yarn.js` is ignored), else the
 * copy a standard Node install ships beside `node.exe`. Mirrors `npmSpawn` in
 * `core/src/cli/owned-process-tree.ts`.
 */
export function windowsNpmCli(env, { execPath = process.execPath, exists = existsSync } = {}) {
  const candidates = [];
  const fromNpm = env.npm_execpath;
  if (typeof fromNpm === 'string' && fromNpm !== '') {
    const name = win32.basename(fromNpm);
    if (name === 'npm-cli.js') candidates.push(fromNpm);
    else if (name === 'npx-cli.js') {
      candidates.push(win32.join(win32.dirname(fromNpm), 'npm-cli.js'));
    }
  }
  const bundled = win32.join(win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return candidates.find((candidate) => exists(candidate)) ?? bundled;
}

/**
 * The `[command, args]` pair to hand `spawn`. On Windows `npm` is a `.cmd`
 * shim, which Node refuses to spawn without a shell (CVE-2024-27980), and a
 * shell would re-split the arguments (project paths here contain spaces and
 * `$`). So `npm` runs as `node <npm-cli.js> ...args` there instead: no shell,
 * arguments passed verbatim. Every other command, and every command on POSIX,
 * is returned unchanged.
 */
export function spawnable(cmd, args, { platform = process.platform, env = process.env } = {}) {
  if (cmd === npm && platform === 'win32') {
    return [process.execPath, [windowsNpmCli(env), ...args]];
  }
  return [cmd, args];
}

/** The termination signals `run` forwards to its child. */
export const FORWARDED_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

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
 *
 * Aborting or forwarding a signal to an abortable child reaches every process
 * it started, not the child alone: a shell that does not hand its process over
 * to the command it runs (`sh -c` is dash on Debian and Ubuntu, `npm` runs its
 * scripts through `cmd.exe` on Windows) would otherwise die alone and leave
 * that command running, still writing after the run gave up on it. On POSIX
 * the child leads a process group of its own and the signal goes to the group.
 * Windows has no process groups and no signals to send, so the tree is ended
 * with `taskkill /T /F`; an aborted child there still resolves with SIGTERM,
 * as it does elsewhere.
 *
 * With `capture`, stdout and stderr are piped instead of inherited and the
 * outcome also carries `output`, both streams interleaved in arrival order, so
 * a runner that overlaps several children can print each one's output whole,
 * plus `stdout` and `stderr` separately for a caller that parses the result:
 * a warning on stderr must never be mistaken for data.
 *
 * `onSpawn` is called with the child once it has started, for a caller that
 * watches the process (its pid) while it runs.
 */
export function run(
  cmd,
  args,
  { cwd, env, stdio = 'inherit', forwardSignals = true, signal, capture = false, onSpawn } = {},
) {
  return new Promise((resolve, reject) => {
    const [command, commandArgs] = spawnable(cmd, args);
    const windows = process.platform === 'win32';
    const ownGroup = signal !== undefined && !windows;
    const child = spawn(command, commandArgs, {
      cwd,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : stdio,
      detached: ownGroup,
    });
    if (child.pid !== undefined) onSpawn?.(child);
    let aborted = false;
    const terminate = (name) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (signal === undefined || child.pid === undefined) {
        child.kill(name);
        return;
      }
      if (windows) {
        const ended = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        // taskkill missing or refused: end the child at least.
        if (ended.status !== 0) child.kill(name);
        return;
      }
      try {
        process.kill(-child.pid, name);
      } catch {
        // The group is already gone: every process in it has exited.
      }
    };
    const onAbort = () => {
      aborted = true;
      terminate('SIGTERM');
    };
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const chunks = [];
    const stdoutChunks = [];
    const stderrChunks = [];
    if (capture) {
      child.stdout.on('data', (chunk) => {
        chunks.push(chunk);
        stdoutChunks.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        chunks.push(chunk);
        stderrChunks.push(chunk);
      });
    }

    const handlers = new Map(
      forwardSignals ? FORWARDED_SIGNALS.map((name) => [name, () => terminate(name)]) : [],
    );
    for (const [name, handler] of handlers) process.on(name, handler);
    const release = () => {
      for (const [name, handler] of handlers) process.removeListener(name, handler);
      signal?.removeEventListener('abort', onAbort);
    };

    // `close` (not `exit`) so captured output is complete when the promise settles.
    child.on('close', (exitCode, childSignal) => {
      release();
      // taskkill ends a Windows process with an exit code, not a signal.
      const [code, exitSignal] =
        windows && aborted && childSignal === null ? [null, 'SIGTERM'] : [exitCode, childSignal];
      resolve(
        capture
          ? {
              code,
              signal: exitSignal,
              output: Buffer.concat(chunks).toString('utf8'),
              stdout: Buffer.concat(stdoutChunks).toString('utf8'),
              stderr: Buffer.concat(stderrChunks).toString('utf8'),
            }
          : { code, signal: exitSignal },
      );
    });
    child.on('error', (error) => {
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
