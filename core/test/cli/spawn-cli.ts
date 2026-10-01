/**
 * Runs the compiled `jsails` CLI (or any other program) as a child process
 * without blocking the test process. A CLI case is almost all child start-up
 * latency, so the CLI suites run their subprocess cases concurrently through
 * this helper instead of one `spawnSync` after another.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The compiled CLI entry point. */
export const cliPath = fileURLToPath(new URL('../../src/cli/bin.cjs', import.meta.url));

/**
 * Concurrency for a suite of spawned cases (a CLI child, a stdio server):
 * `JSAILS_TEST_SPAWN_CONCURRENCY`, which `scripts/run-tests.mjs` sets (2 by
 * default), else 2. Every child is a full Node process of 60-120 MiB, and the
 * runner already runs several test files at once, so one child per core per
 * file multiplied into hundreds of processes when every workspace ran; the
 * file-level concurrency is what keeps the cores busy.
 */
export const CLI_SUITE_CONCURRENCY = spawnConcurrency(process.env);

/** The spawned-case concurrency `env` asks for (see {@link CLI_SUITE_CONCURRENCY}). */
export function spawnConcurrency(env: NodeJS.ProcessEnv): number {
  const value = Number(env['JSAILS_TEST_SPAWN_CONCURRENCY']);
  return Number.isInteger(value) && value >= 1 ? value : 2;
}

export interface ProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  cwd?: string;
  /** The child's whole environment (defaults to the test process's). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `command` to completion and collect its output. Standard input is closed
 * at once, as `spawnSync` does, so a child that reads it sees end-of-file
 * instead of waiting forever.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
    // A child that exits before its stdin is shut down makes the shutdown
    // fail with EPIPE (or EOF on Windows). Nothing is written, so that error
    // carries no information; unhandled, it would crash the test process.
    child.stdin.on('error', () => undefined);
    child.stdin.end();
  });
}

export interface CliOptions extends ProcessOptions {
  cwd: string;
  /** Node flags placed before the CLI entry point (e.g. `--import`). */
  nodeArgs?: readonly string[];
}

/** Run the compiled CLI with `args` in `options.cwd`. */
export function runCli(args: readonly string[], options: CliOptions): Promise<ProcessResult> {
  return runProcess(process.execPath, [...(options.nodeArgs ?? []), cliPath, ...args], options);
}

/**
 * Start `run` for every case at once and pair each case with its result, in
 * case order, so a test that checks several invocations waits for the slowest
 * one instead of their sum.
 */
export async function mapConcurrently<T, R>(
  cases: readonly T[],
  run: (item: T) => Promise<R>,
): Promise<Array<[T, R]>> {
  const results = await Promise.all(cases.map(run));
  return cases.map((item, index) => [item, results[index] as R]);
}
