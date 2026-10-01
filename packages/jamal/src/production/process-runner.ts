/**
 * Process execution foundation for jamal production deploys.
 *
 * {@link createProcessRunner} is the low-level seam that actually spawns a
 * process: a fixed argv array (never a shell string, so no local interpolation
 * is possible) is handed to `node:child_process` `spawn`. By default stdout and
 * stderr are captured (each bounded to its last {@link MAX_CAPTURED_BYTES}) and
 * returned alongside the exit code; `stream: true` forwards them to this
 * process's own stdout/stderr instead, for long commands (a build, a followed
 * log) whose output the operator should see as it happens. `stdoutTo` and
 * `stdinFrom` pipe raw bytes between the child and a stream, for a payload
 * too large or too binary to hold as text (a database dump). A `timeoutMs`
 * option kills the child and rejects once the deadline passes.
 * Every rejection is a {@link ProcessRunnerError} whose message is value-free —
 * the argv, the binary name, and any spawn error text never leak into it.
 *
 * The production build/push/ssh layers (see `build.ts` and `transport.ts`)
 * depend on {@link ProcessRunner} rather than on `spawn` directly, so they can
 * be driven by a fake runner in tests and never touch a real process.
 */

import { detach, escalate } from 'jsails/support';
import { JsailsError } from 'jsails/errors';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Outcome of one spawned command: its exit code plus captured output. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Per-run options for a {@link ProcessRunner}. */
export interface CommandOptions {
  /** Kill the child and reject after this many milliseconds. */
  readonly timeoutMs?: number;
  /**
   * Text (as UTF-8) or bytes written to the child's stdin, which is then
   * closed. Omitted means stdin is `/dev/null`. Used to hand a secret payload
   * to a remote writer without putting it in an argv.
   */
  readonly stdin?: string | Uint8Array;
  /**
   * Forward stdout/stderr to this process as they arrive instead of capturing
   * them; the result then carries empty `stdout`/`stderr`.
   */
  readonly stream?: boolean;
  /**
   * Pipe this stream into the child's stdin, with backpressure, instead of a
   * text payload: a file too large to hold in memory, or binary data. A read
   * failure of the source rejects the run with `input_failed`; the child
   * closing its stdin early does not, since its exit code reports that.
   */
  readonly stdinFrom?: Readable;
  /**
   * Pipe the child's stdout, as raw bytes with backpressure, into this stream
   * instead of capturing or forwarding it; the result then carries an empty
   * `stdout`. The run resolves only after the stream finished, and a write
   * failure of the stream (a full disk) rejects it with `output_failed`.
   */
  readonly stdoutTo?: Writable;
}

/**
 * Captured output kept per stream. A chatty command (a build log) keeps only
 * its tail, so memory stays bounded and the end, where errors are, survives.
 */
export const MAX_CAPTURED_BYTES: number = 1024 * 1024;

/** Keep the last `limit` bytes of a growing chunk list, in place. */
function trimToTail(chunks: Buffer[], size: number, limit: number): number {
  let total = size;
  while (total > limit && chunks.length > 0) {
    const head = chunks[0]!;
    const excess = total - limit;
    if (head.length <= excess) {
      chunks.shift();
      total -= head.length;
    } else {
      chunks[0] = head.subarray(excess);
      total -= excess;
    }
  }
  return total;
}

/**
 * Run a fixed argv array and resolve with its exit code and captured output.
 * The seam every production executor injects for tests; `createProcessRunner`
 * is the default implementation.
 */
export type ProcessRunner = (
  argv: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

/** Why a {@link ProcessRunnerError} was raised — never a raw errno or argv. */
export type ProcessRunnerErrorCode =
  'invalid_argv' | 'spawn_failed' | 'timed_out' | 'input_failed' | 'output_failed';

/** A value-free failure from {@link createProcessRunner}. */
export class ProcessRunnerError extends JsailsError {
  constructor(
    readonly code: ProcessRunnerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The default {@link ProcessRunner}: spawn `argv[0]` with the remaining tokens
 * as arguments, output captured (or streamed with `stream: true`), stdin
 * ignored unless a payload is given, and no local shell in the picture. An empty argv, a spawn failure, and a timeout each reject with a
 * {@link ProcessRunnerError} that never embeds the command or its output; a
 * successful spawn resolves once the child exits with its code and captured
 * stdout/stderr. When `timeoutMs` is set, the child is `SIGKILL`ed at the
 * deadline and the run rejects.
 */
export function createProcessRunner(): ProcessRunner {
  return (argv, options = {}) =>
    new Promise<CommandResult>((resolve, reject) => {
      const command = argv[0];
      if (command === undefined || command === '') {
        reject(new ProcessRunnerError('invalid_argv', 'cannot run an empty command'));
        return;
      }

      const output = options.stream === true ? 'inherit' : 'pipe';
      const takesInput = options.stdin !== undefined || options.stdinFrom !== undefined;
      const child = spawn(command, argv.slice(1), {
        stdio: [
          takesInput ? 'pipe' : 'ignore',
          options.stdoutTo === undefined ? output : 'pipe',
          output,
        ],
      });

      // A child that exits before reading all of stdin (ssh failing to
      // connect) makes the write fail with EPIPE; the exit code already
      // reports that failure, so the stream error must not crash the process.
      child.stdin?.on('error', () => {});
      if (options.stdin !== undefined) {
        child.stdin?.end(options.stdin);
      }

      // Only the source's own read failure is an input failure: `pipe` does
      // not forward it, so it is recorded here and the child's stdin is ended
      // early, which the caller must not mistake for a complete payload.
      let inputFailed = false;
      if (options.stdinFrom !== undefined && child.stdin !== null) {
        const source = options.stdinFrom;
        const sink = child.stdin;
        source.once('error', () => {
          inputFailed = true;
          sink.destroy();
        });
        source.pipe(sink);
      }

      let outputDone: Promise<boolean> = Promise.resolve(true);
      if (options.stdoutTo !== undefined && child.stdout !== null) {
        outputDone = pipeline(child.stdout, options.stdoutTo).then(
          () => true,
          // The child is killed so it does not block on a pipe nobody reads;
          // the failure is reported as `output_failed` once it has exited.
          () => {
            child.kill('SIGKILL');
            return false;
          },
        );
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      if (options.stdoutTo === undefined) {
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout.push(chunk);
          stdoutSize = trimToTail(stdout, stdoutSize + chunk.length, MAX_CAPTURED_BYTES);
        });
      }
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
        stderrSize = trimToTail(stderr, stderrSize + chunk.length, MAX_CAPTURED_BYTES);
      });

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(
            new ProcessRunnerError(
              'timed_out',
              `the command timed out after ${options.timeoutMs} ms`,
            ),
          );
        }, options.timeoutMs);
      }

      child.on('error', () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        // The spawn error's own message embeds the binary name and path; never
        // surface it — a value-free "could not start" is all a caller needs.
        reject(new ProcessRunnerError('spawn_failed', 'the command could not be started'));
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        if (timer !== undefined) clearTimeout(timer);
        const finish = (outputOk: boolean): void => {
          if (settled) return;
          settled = true;
          if (!outputOk) {
            reject(
              new ProcessRunnerError('output_failed', "the command's output could not be written"),
            );
            return;
          }
          if (inputFailed) {
            reject(new ProcessRunnerError('input_failed', "the command's input could not be read"));
            return;
          }
          resolve({
            exitCode: code ?? (signal === null ? 0 : 1),
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
        };
        detach(outputDone.then(finish), escalate);
      });
    });
}
