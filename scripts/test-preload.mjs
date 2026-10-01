/**
 * Loaded (`--import`) into every test-file process `scripts/run-tests.mjs`
 * starts. It records how the process ended, for the runner to judge, because
 * node's own verdict cannot be trusted for that: once any test in a file has
 * failed, node reports nothing more for the file, so a late unhandled rejection,
 * an uncaught exception, or a `process.exit(7)` in a file with an expected
 * failure would otherwise pass unseen.
 *
 * The record (one JSON file per process in `JSAILS_TEST_RECORD_DIR`) holds:
 *
 * - `errors`: the number of `unhandledRejection` and uncaught-exception events,
 *   whether or not node attributed them to a test (an import error is one), and
 *   `events`: the kind and message of the first few, each also printed with a
 *   `[run-tests]` prefix;
 * - `exitCode`: the status the process actually exited with;
 * - `exitCalls`: the codes of `process.exit()` calls made by code outside node's
 *   own runtime (node:test calls it itself under `--test-force-exit`);
 * - `wallMs` and `cpuMs`: the file's wall-clock time and its own CPU time;
 * - `rssMb`: the process's peak resident memory, and `pid`, by which the
 *   runner matches the record to the memory it sampled for the process tree.
 *
 * A process that never reaches its `exit` event (killed by a signal, a native
 * crash) leaves no record, which the runner reports too. A record is not named
 * after the process id alone: Windows hands a finished process's id to the next
 * one at once, so a later test file would overwrite an earlier file's record
 * and that file would read as never having exited.
 *
 * The preload acts only in a test-file process: `NODE_TEST_CONTEXT` is set there
 * and not in the `node --test` orchestrator. A process a test spawns inherits
 * that variable, and inherits the preload when it reuses `process.execArgv`; the
 * `JSAILS_TEST_FILE_PID` marker this module sets keeps such a descendant from
 * writing a record in its test file's name.
 *
 * In a coverage run the runner may give the `node --test` orchestrator a
 * temporary directory on disk, so the coverage dumps node keeps there do not
 * fill a tmpfs; it passes the caller's own `TMPDIR` in `JSAILS_TEST_TMPDIR`
 * (empty: it was unset). A test process restores it first thing, so test code
 * and everything it starts see the usual temporary directory (unix-socket
 * paths stay short), while V8, which read `NODE_V8_COVERAGE` at start-up,
 * still writes the process's own dump to disk.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const recordDir = process.env.JSAILS_TEST_RECORD_DIR;
const MAX_EVENTS = 10;
const MAX_MESSAGE = 1000;

const ownTmpdir = process.env.JSAILS_TEST_TMPDIR;
if (process.env.NODE_TEST_CONTEXT !== undefined && ownTmpdir !== undefined) {
  if (ownTmpdir === '') delete process.env.TMPDIR;
  else process.env.TMPDIR = ownTmpdir;
  delete process.env.JSAILS_TEST_TMPDIR;
}

if (
  process.env.NODE_TEST_CONTEXT !== undefined &&
  process.env.JSAILS_TEST_FILE_PID === undefined &&
  recordDir !== undefined &&
  recordDir !== ''
) {
  process.env.JSAILS_TEST_FILE_PID = String(process.pid);
  const file = process.argv[1] ?? '';
  const started = performance.now();
  const cpuAtStart = process.cpuUsage();
  let errors = 0;
  const events = [];
  const exitCalls = [];

  const fail = (kind) => (error) => {
    errors += 1;
    process.exitCode = 1;
    if (events.length < MAX_EVENTS) {
      const message = error instanceof Error ? error.message : String(error);
      events.push({ kind, message: message.slice(0, MAX_MESSAGE) });
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`[run-tests] ${kind} in ${file}:\n${detail}\n`);
  };
  process.on('unhandledRejection', fail('unhandled rejection'));
  process.on('uncaughtExceptionMonitor', fail('uncaught exception'));

  const exit = process.exit;
  process.exit = function exitFromTestProcess(code) {
    // Frame 0 is the message, frame 1 this wrapper, frame 2 the caller.
    const caller = new Error().stack?.split('\n')[2] ?? '';
    if (!caller.includes('(node:internal/') && !caller.includes('at node:internal/')) {
      exitCalls.push(code ?? process.exitCode ?? 0);
    }
    return exit.call(process, code);
  };

  process.on('exit', (exitCode) => {
    const cpu = process.cpuUsage(cpuAtStart);
    writeFileSync(
      join(recordDir, `${process.pid}-${randomUUID()}.json`),
      JSON.stringify({
        file,
        pid: process.pid,
        errors,
        events,
        exitCode,
        exitCalls,
        wallMs: Math.round(performance.now() - started),
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        // KiB on every platform.
        rssMb: Math.round(process.resourceUsage().maxRSS / 1024),
      }),
    );
  });
}
