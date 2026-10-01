/**
 * Child-process primitives shared by the repo tooling: a promise-returning
 * `run` that forwards termination signals to the child, the exit status a
 * runner should report for a child's outcome, the `npm` command, and
 * `spawnable`, which turns `npm` into something Node can spawn on every
 * platform.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';

/** The `npm` command name every script passes to `run`/`spawnable`. */
export const npm = 'npm';

/**
 * npm's own JavaScript entry on Windows: the one npm exports to scripts it runs
 * (`npm_execpath`), else the copy a standard Node install ships beside
 * `node.exe`.
 */
function windowsNpmCli(env) {
  const fromNpm = env.npm_execpath;
  if (typeof fromNpm === 'string' && fromNpm.endsWith('.js') && existsSync(fromNpm)) {
    return fromNpm;
  }
  return join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
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
 *
 * With `capture`, stdout and stderr are piped instead of inherited and the
 * outcome also carries `output`, both streams interleaved in arrival order, so
 * a runner that overlaps several children can print each one's output whole,
 * plus `stdout` and `stderr` separately for a caller that parses the result:
 * a warning on stderr must never be mistaken for data.
 */
export function run(
  cmd,
  args,
  { cwd, env, stdio = 'inherit', forwardSignals = true, signal, capture = false } = {},
) {
  return new Promise((resolve, reject) => {
    const [command, commandArgs] = spawnable(cmd, args);
    const child = spawn(command, commandArgs, {
      cwd,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : stdio,
      signal,
    });
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

    // `close` (not `exit`) so captured output is complete when the promise settles.
    child.on('close', (code, exitSignal) => {
      release();
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
