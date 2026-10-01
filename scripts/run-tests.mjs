/**
 * Runs the compiled node:test suite of the workspace it is invoked from
 * (`<cwd>/dist/test/**\/*.test.js`) and reconciles the outcome with the
 * expected-failure ledgers (`scripts/expected-failures.mjs`): the run fails on
 * a failure no ledger lists, on a listed test that fails for another reason
 * than its entry states, on a listed test that passes or is skipped, and on a
 * listed test that no longer exists. node's own exit code is not trusted for
 * that; a JSON reporter (`scripts/test-reporter.mjs`) records every outcome,
 * and the preload (`scripts/test-preload.mjs`) records how each test process
 * ended. A process with an unhandled rejection or uncaught exception, a
 * `process.exit()` from test code, an exit status other than 0 or 1 (or 1
 * without a failing test), or no record at all is a file-level
 * `processFailure`, which only a whole-file entry can expect.
 *
 * Files are collected here rather than by a shell or `node --test` glob so
 * every workspace runs the same way on every platform; node gets them as one
 * glob that matches exactly those files (`testFilePattern`), so the command
 * line stays within Windows' limit as the suite grows. A compiled test whose
 * `test/**\/*.test.ts(x)` source no longer exists is skipped with a notice: an
 * incremental build never deletes output.
 *
 * Options (anything else is forwarded to `node --test`):
 *
 * - `--suite=default|database`: the default suite runs every test file. The
 *   `database` suite runs only `*.database.test.ts(x)` files, against the
 *   server `DATABASE_TYPE` (`mariadb`/`postgres`) and `DATABASE_*` name; the
 *   child sees `JSAILS_TEST_SUITE=database`. In the default suite those files
 *   run too, and a database helper uses an on-disk SQLite file.
 * - `--shard=<i>/<n>`: run the i-th of n disjoint slices of the files.
 * - `--coverage`: measure `dist/src` coverage and fail below this workspace's
 *   floor in `coverage-floors.json`; the measurement is written to
 *   `test-results/coverage/<workspace>.json`. A workspace without a floor yet
 *   (a new package) is measured and reported, not failed. A run in which node
 *   could not enable coverage (it could not create its dump directory, as on a
 *   full disk, and then reports totals over nothing) fails instead, and so
 *   does one in which a dump may be missing: node merges whichever dumps
 *   exist and reports lower totals without a word, so the run fails when a
 *   test process printed node's dump write error, or when the file system
 *   holding the dumps came within {@link COVERAGE_MIN_FREE_MB} of full (a
 *   process a test started writes a dump too, and its error reaches no
 *   reporter).
 * - `--watch` runs node's watch mode as is, without reconciliation.
 *
 * `JSAILS_TEST_SERVICES` (comma-separated, see `SERVICES` in
 * `scripts/expected-failures.mjs`) declares the live services this run was
 * given; ledger entries scoped with `services` apply only when the run
 * declares them. An unknown name is a usage error.
 *
 * A result is credited to the test file whose process ran it, wherever the
 * test was declared (`scripts/test-reporter.mjs`), so a suite defined in a
 * shared module or a package's `src/` is listed under the test file that
 * calls it.
 *
 * Every run writes its reconcile verdict to
 * `test-results/reconcile/<run>.json`, where `<run>` is the workspace with
 * `.database-<type>`, `.<service>` for each declared service, and
 * `.shard-<i>-of-<n>` appended as they apply (`runFileName`), so runs in
 * other contexts do not overwrite it: the run's context, each unexpected
 * failure as `{ file, path, fileLevel, failureType, errorName, message }`, the
 * mismatched, passing, and stale entries, and `drafts`, a ledger entry per
 * unexpected failure scoped to this run's context, with `reason` and `fixedBy`
 * left for a person to write. A draft's message is the first message line,
 * literal except that absolute paths under the checkout, the temporary and
 * the home directory become `.*` and loopback ports `\d+`; other text that
 * varies between runs (a generated name, a timing) is kept, so read the
 * message before committing the entry. A CI leg uploads the directory, so its
 * first run turns into ledger entries.
 *
 * Every test gets a timeout (`JSAILS_TEST_TIMEOUT_MS`, default five minutes)
 * unless `--test-timeout` is passed, and the whole run a limit
 * (`JSAILS_TEST_RUN_TIMEOUT_MS`, default fifteen minutes): a test file whose
 * process outlives its tests (a leaked handle) would otherwise keep
 * `node --test` waiting forever, so at the limit the run is stopped and every
 * file still running is reported by name. Children get `NODE_ENV=test` (and
 * then `JSAILS_ENV=test`) unless it is set, a shared `NODE_COMPILE_CACHE`
 * (none for a coverage run, whose counts a cached compile would lose),
 * `JSAILS_TEST_SPAWN_CONCURRENCY` (default 2: how many processes one test
 * file starts at once), and the preload `scripts/test-preload.mjs`.
 *
 * Memory. `node --test`, and through it every test-file process, runs with
 * `--max-semi-space-size=8` (a smaller young generation: 25-40% less memory
 * per process at no measurable CPU cost) and `--max-old-space-size=2048`, a
 * ceiling eight times the largest heap any test uses, so a runaway file ends
 * as a `processFailure` instead of exhausting the machine.
 * `JSAILS_TEST_NODE_FLAGS` replaces both (for example `--optimize-for-size`
 * on a crowded machine: 35% less memory, 50% more time). A coverage run gives
 * the `node --test` orchestrator a temporary directory on disk when the
 * system's is a tmpfs (`scripts/disk-temp.mjs`), because node writes every
 * test process's V8 coverage dump there and keeps it until the run ends; the
 * preload hands each test process the usual directory back
 * (`JSAILS_TEST_TMPDIR`), so test code and its socket paths see no change.
 *
 * Budget. A run started by the workspace runner runs inside that runner's
 * lease (`JSAILS_BUDGET_HOLDER`) at the `JSAILS_TEST_CONCURRENCY` it was
 * given. A run started directly takes a lease of its own from the machine
 * budget (`scripts/machine-budget.mjs`, sized by `scripts/test-budget.mjs`)
 * before its run limit starts, so waiting for the machine never counts
 * against `JSAILS_TEST_RUN_TIMEOUT_MS`, and runs at the concurrency the grant
 * allows (`JSAILS_TEST_CONCURRENCY` or a forwarded `--test-concurrency` fixes
 * it instead).
 *
 * Per-file wall and CPU times, peak RSS (`rssMb`) and, on Linux, the peak
 * private memory of each test process's tree (`treeMb`, sampled from
 * `/proc`) land in `test-results/timings/tests/<run>.json` (`<run>` with a
 * `.coverage` part for a coverage run), with the runner's own peak
 * (`runnerMb`) and the lane's grant, and the slowest files are printed. The
 * next run starts its files heaviest first by these records
 * (`heaviestFirst`), after sharding.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { realpathSync, writeFileSync } from 'node:fs';
import { availableParallelism, constants, homedir, tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

import { diskBackedTempRoot, diskTempBase, watchFreeSpace } from './disk-temp.mjs';
import { declaredServices, readLedgers, reconcile } from './expected-failures.mjs';
import { acquire } from './machine-budget.mjs';
import { parseStatusMemory, startTreeSampler } from './process-tree.mjs';
import { FORWARDED_SIGNALS, exitStatus, run } from './subprocess.mjs';
import {
  fileEstimates,
  laneConcurrency,
  laneOverheadMb,
  laneRequest,
  previousTimings,
  serialWallMs,
} from './test-budget.mjs';
import { readManifest, repoRoot } from './workspaces.mjs';

/** The `node` flags of a test run unless `JSAILS_TEST_NODE_FLAGS` replaces them (see the header). */
export const DEFAULT_TEST_NODE_FLAGS = Object.freeze([
  '--max-semi-space-size=8',
  '--max-old-space-size=2048',
]);
/** How many processes one test file starts at once unless `JSAILS_TEST_SPAWN_CONCURRENCY` is set. */
export const DEFAULT_SPAWN_CONCURRENCY = 2;
/**
 * The free space (MiB) a coverage run's dump file system must keep: a run
 * that came closer to full may have lost a dump between two samples.
 */
export const COVERAGE_MIN_FREE_MB = 256;
const DEFAULT_TEST_TIMEOUT_MS = 300_000;
const DEFAULT_RUN_TIMEOUT_MS = 900_000;
// The workspace runner prints the slowest 20 across all workspaces; per workspace, a few.
const SLOWEST_SHOWN = 5;
export const SUITES = Object.freeze(['default', 'database']);
export const SERVER_DATABASES = Object.freeze(['mariadb', 'postgres']);
const FILTER_FLAGS = ['--test-name-pattern', '--test-skip-pattern', '--test-only'];
const SHARED_PROCESS_FLAGS = ['--test-isolation=none', '--experimental-test-isolation=none'];

class UsageError extends Error {}

/** Splits this script's own options from the flags forwarded to `node --test`. */
export function parseArgs(argv) {
  const options = { suite: 'default', shard: undefined, coverage: false, forwarded: [] };
  for (const arg of argv) {
    const [flag, value] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (flag === '--suite') {
      if (!SUITES.includes(value)) throw new UsageError(`--suite must be ${SUITES.join(' or ')}`);
      options.suite = value;
    } else if (flag === '--shard') {
      const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
      const index = Number(match?.[1]);
      const total = Number(match?.[2]);
      if (match === null || total < 1 || index < 1 || index > total) {
        throw new UsageError('--shard must be <i>/<n> with 1 <= i <= n');
      }
      options.shard = { index, total };
    } else if (flag === '--coverage' && value === undefined) {
      options.coverage = true;
    } else {
      options.forwarded.push(arg);
    }
  }
  return options;
}

/** Every `*.test.js` under `dir` (symlinks are not followed), sorted. */
export function collectTests(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(full);
    }
  };
  walk(dir);
  return files.sort();
}

/** The `test/<same path>.test.ts(x)` source of a compiled test, or undefined. */
export function sourceOf(compiled, workspaceDir) {
  const stem = relative(join(workspaceDir, 'dist', 'test'), compiled).slice(0, -'.js'.length);
  for (const ext of ['.ts', '.tsx']) {
    const source = join(workspaceDir, 'test', `${stem}${ext}`);
    if (existsSync(source)) return source;
  }
  return undefined;
}

/** A path relative to the repo root with `/` separators: the ledger form. */
export function repoPath(path, root = repoRoot) {
  return relative(root, path).split(sep).join('/');
}

/** Whether a test file belongs to `suite`. */
export function inSuite(file, suite) {
  return suite === 'default' || file.endsWith('.database.test.js');
}

/**
 * The `index`-th of `total` slices: files in sorted order, dealt round-robin,
 * so every file lands in exactly one shard and shard sizes differ by at most one.
 */
export function shardFiles(files, { index, total }) {
  return [...files].sort().filter((_, position) => position % total === index - 1);
}

/**
 * Parses the JSON-line reporter output: the results, the coverage totals,
 * node's message when it could not enable coverage (`coverageUnavailable`) or
 * could not write a dump (`coverageIncomplete`), and whether the run reached
 * its end.
 */
export function readResults(text) {
  const results = [];
  let coverage;
  let coverageUnavailable;
  let coverageIncomplete;
  let complete = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const record = JSON.parse(line);
    if (record.type === 'result') results.push(record);
    else if (record.type === 'coverage') coverage = record.totals;
    else if (record.type === 'coverage-unavailable') coverageUnavailable = record.message;
    else if (record.type === 'coverage-incomplete') coverageIncomplete = record.message;
    else if (record.type === 'end') complete = true;
  }
  return { results, coverage, coverageUnavailable, coverageIncomplete, complete };
}

/**
 * Why a coverage run's totals are not a measurement, or `undefined` when they
 * are: node could not enable coverage, could not write a dump, or the dumps'
 * file system came within {@link COVERAGE_MIN_FREE_MB} of full
 * (`lowestFreeMb`, undefined when it could not be read).
 */
export function unmeasuredCoverage({ unavailable, incomplete, lowestFreeMb }) {
  if (unavailable !== undefined) return unavailable;
  if (incomplete !== undefined) return `a coverage dump was not written (${incomplete})`;
  if (lowestFreeMb !== undefined && lowestFreeMb < COVERAGE_MIN_FREE_MB) {
    return `the file system holding the coverage dumps came within ${lowestFreeMb} MiB of full, so a dump may be missing; free some space and run again`;
  }
  return undefined;
}

export const COVERAGE_METRICS = Object.freeze(['lines', 'branches', 'functions']);

/**
 * Messages for each metric of `measured` below `floor` (empty when it holds,
 * and when the workspace has no floor yet).
 */
export function checkCoverage(workspace, measured, floor) {
  if (floor === undefined) return [];
  if (measured === undefined) return [`no coverage was reported for ${workspace}`];
  return COVERAGE_METRICS.filter((metric) => measured[metric] < floor[metric]).map(
    (metric) =>
      `${workspace} ${metric} coverage ${measured[metric].toFixed(2)}% is below its floor of ${floor[metric]}%`,
  );
}

function positiveInteger(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new UsageError(`${name} must be a positive integer`);
  return parsed;
}

/**
 * The `node` flags placed before `--test`: `JSAILS_TEST_NODE_FLAGS` split on
 * whitespace when it is set (an empty value means none), else
 * {@link DEFAULT_TEST_NODE_FLAGS}.
 */
export function testNodeFlags(env = process.env) {
  const raw = env.JSAILS_TEST_NODE_FLAGS;
  if (raw === undefined) return [...DEFAULT_TEST_NODE_FLAGS];
  return raw.split(/\s+/).filter((flag) => flag !== '');
}

/** The `node --test` flags for a run. */
function nodeTestFlags(options, { reporterOutput, concurrency }) {
  const flags = ['--import', pathToFileURL(join(repoRoot, 'scripts', 'test-preload.mjs')).href];
  const { forwarded } = options;
  if (!forwarded.some((flag) => flag.startsWith('--test-timeout'))) {
    flags.push(
      `--test-timeout=${positiveInteger('JSAILS_TEST_TIMEOUT_MS', DEFAULT_TEST_TIMEOUT_MS)}`,
    );
  }
  if (
    concurrency !== undefined &&
    !forwarded.some((flag) => flag.startsWith('--test-concurrency'))
  ) {
    flags.push(`--test-concurrency=${concurrency}`);
  }
  if (options.coverage) {
    flags.push(
      '--experimental-test-coverage',
      // Relative to the workspace (the child's cwd), so the glob has no
      // platform separators and never matches a dependency's dist.
      '--test-coverage-include=dist/src/**',
    );
  }
  if (reporterOutput !== undefined) {
    flags.push(
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      `--test-reporter=${pathToFileURL(join(repoRoot, 'scripts', 'test-reporter.mjs')).href}`,
      `--test-reporter-destination=${reporterOutput}`,
    );
  }
  return [...flags, ...forwarded];
}

/**
 * CreateProcessW's limit on a command line, in UTF-16 code units including its
 * terminating NUL. It is the smallest limit of any supported platform (Linux
 * allows 128 KiB per argument, macOS 1 MiB in all), so a command within it
 * starts everywhere.
 */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;

// A character outside this set may mean something to a glob (`*?[]{}(),!+@\`)
// or to brace expansion, and node reads every file argument as a glob.
const PLAIN_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * One `node --test` glob, relative to `workspaceDir`, that matches exactly
 * `files` (absolute `*.test.js` paths under it): their paths as a brace
 * expansion with every shared directory written once, as in
 * `dist/test/{cli/{create,serve},support/paths}.test.js`. Listing the files
 * one argument each would make the command line grow with the checkout path
 * and, by the full path, with every new test file, until Windows refuses to
 * start it; the pattern grows only by each new file's own name. node sorts the
 * files a glob matches, as it sorts a list of files, so the run is the same.
 * Throws when a path segment has a character a glob could read as syntax.
 */
export function testFilePattern(files, workspaceDir) {
  const root = { file: false, children: new Map() };
  for (const file of files) {
    const path = relative(workspaceDir, file);
    const segments = path.split(sep);
    const last = segments.length - 1;
    if (!segments[last].endsWith('.test.js') || segments[0] === '..' || isAbsolute(path)) {
      throw new Error('a test file is not a *.test.js file under the workspace');
    }
    segments[last] = segments[last].slice(0, -'.test.js'.length);
    if (!segments.every((segment) => PLAIN_SEGMENT.test(segment))) {
      throw new Error(
        'a test file path has a character outside [A-Za-z0-9._-], which node --test would read as glob syntax; rename it',
      );
    }
    let node = root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { file: false, children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.file = true;
  }
  // Each alternative is '' (the node itself is a test file) or `/<rest>`.
  const alternatives = (node) => [
    ...(node.file ? [''] : []),
    ...[...node.children].map(([name, child]) => `/${name}${group(alternatives(child))}`),
  ];
  // Brace expansion leaves a single alternative in braces as literal text.
  const group = (options) => {
    if (options.length === 1) return options[0];
    if (options.every((option) => option.startsWith('/'))) {
      return `/{${options.map((option) => option.slice(1)).join(',')}}`;
    }
    return `{${options.join(',')}}`;
  };
  if (root.children.size === 0) throw new Error('no test files to run');
  return `${group(alternatives(root)).slice(1)}.test.js`;
}

/**
 * The length of the command line libuv builds on Windows to start `command`
 * with `args` (`quote_cmd_arg` in its `src/win/process.c`), without the NUL.
 */
export function windowsCommandLineLength(command, args) {
  let length = 0;
  for (const arg of [command, ...args]) {
    if (arg === '') {
      length += 2;
    } else if (!/[ \t"]/.test(arg)) {
      length += arg.length;
    } else if (!/["\\]/.test(arg)) {
      length += arg.length + 2;
    } else {
      // Backslashes before a quote or the closing quote are doubled; a quote
      // gets a backslash of its own.
      const escaped = arg.replace(/(\\*)("|$)/g, (_, slashes, quote) =>
        quote === '"' ? `${slashes}${slashes}\\"` : `${slashes}${slashes}`,
      );
      length += escaped.length + 2;
    }
  }
  return length + args.length;
}

/**
 * Throws, before anything is started, when the `node --test` command for
 * `fileCount` test files would not fit {@link WINDOWS_COMMAND_LINE_LIMIT}.
 * Checked on every platform, so a suite that outgrows the limit fails on the
 * first run anywhere rather than only on Windows, where the spawn fails with a
 * bare `ENAMETOOLONG`.
 */
export function assertCommandFits(command, args, fileCount) {
  const length = windowsCommandLineLength(command, args) + 1;
  if (length > WINDOWS_COMMAND_LINE_LIMIT) {
    throw new Error(
      `the node --test command line for ${fileCount} test files would be ${length} characters, over the ${WINDOWS_COMMAND_LINE_LIMIT}-character Windows limit`,
    );
  }
}

/**
 * The `node` arguments that run `files` under `node --test` with `flags`,
 * checked against the command-line limit. The file pattern is relative, so
 * the child must start in `workspaceDir`.
 */
export function testCommand(files, { flags, workspaceDir, command = process.execPath }) {
  const args = [...flags, testFilePattern(files, workspaceDir)];
  assertCommandFits(command, args, files.length);
  return args;
}

function describeResult(result) {
  return `${result.source} > ${result.path.join(' > ')}`;
}

/** The path a process-level failure is reported under. */
export const PROCESS_PATH = Object.freeze(['(test process)']);

/**
 * File-level `processFailure` results for the test processes that did not end
 * cleanly, from the preload's records (`records`: compiled file -> record).
 * `failing` is the set of compiled files with a failing test result.
 */
export function processFailures(files, records, failing) {
  const failures = [];
  const add = (file, message) =>
    failures.push({
      file,
      path: [...PROCESS_PATH],
      outcome: 'fail',
      fileLevel: true,
      failureType: 'processFailure',
      message,
    });
  for (const file of files) {
    const record = records.get(file);
    if (record === undefined) {
      add(file, 'the test process left no exit record: it was killed by a signal or crashed');
      continue;
    }
    const events = record.events ?? [];
    for (const event of events) add(file, `${event.kind}: ${event.message}`);
    if (record.errors > events.length) {
      add(
        file,
        `${record.errors - events.length} more unhandled rejection(s) or uncaught exception(s); see "[run-tests]" in the output`,
      );
    }
    for (const code of record.exitCalls) add(file, `test code called process.exit(${code})`);
    if (record.exitCode !== 0 && record.exitCode !== 1) {
      add(file, `the test process exited with status ${record.exitCode}`);
    } else if (record.exitCode === 1 && !failing.has(file) && record.errors === 0) {
      add(file, 'the test process exited with status 1 without a failing test');
    }
  }
  return failures;
}

function describeEntry(entry) {
  const name = entry.test === undefined ? '(whole file)' : entry.test.join(' > ');
  return `${entry.file} > ${name} [scripts/expected-failures/${entry.ledger}.json]`;
}

/** The preload's per-process records for this run's files, by compiled file. */
function readRecords(dir, files) {
  const wanted = new Set(files.map((file) => resolve(file)));
  const records = new Map();
  for (const name of readdirSync(dir)) {
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const file = resolve(record.file);
    if (wanted.has(file)) records.set(file, { ...record, file });
  }
  return records;
}

/**
 * Per-file timings from the records, slowest first, with each file's peak RSS
 * and, where the tree sampler saw its process (`treePeaks`: pid -> MiB), the
 * peak private memory of its process tree.
 */
export function timingsOf(records, workspaceDir, treePeaks = new Map()) {
  return [...records.values()]
    .map((record) => {
      const treeMb = treePeaks.get(record.pid);
      return {
        file: repoPath(sourceOf(record.file, workspaceDir) ?? record.file),
        wallMs: record.wallMs,
        cpuMs: record.cpuMs,
        ...(Number.isFinite(record.rssMb) ? { rssMb: record.rssMb } : {}),
        ...(treeMb === undefined ? {} : { treeMb: Math.round(treeMb) }),
      };
    })
    .sort((a, b) => b.wallMs - a.wallMs);
}

/**
 * The environment of the test child. This runner starts a fresh test run even
 * when it is itself started from a test (the tooling tests do): an inherited
 * context makes node skip the files, and an inherited preload marker would
 * keep the preload from recording, and an inherited `JSAILS_ENV_RESOLVED`
 * would make every CLI the tests spawn inherit the caller's environment.
 * NODE_ENV defaults to `test` only when the caller left it unset, so the
 * server-components key path exercises its test-mode ephemeral key, and under
 * `NODE_ENV=test` JSAILS_ENV defaults to `test` too, since the CLI derives
 * NODE_ENV from it and refuses a contradicting one.
 *
 * A coverage run never uses a compile cache, not even an inherited one: V8
 * reports no counts for code that came from the cache, so a warm cache turns
 * covered functions and branches into uncovered ones and the measurement
 * would depend on whether the files were compiled before.
 *
 * The default suite opens no external service, so `VALKEY_URL` reaches the
 * child only when the run declares the `valkey` service: a developer's
 * exported URL (the checkout's own Valkey) would otherwise send every test
 * that falls back to it, such as a plugin wired without an explicit store, to
 * a real server.
 *
 * A coverage run given `coverageTemp` (a disk-backed directory) hands it to
 * `node --test` as `TMPDIR`, where node keeps the coverage dumps, and the
 * caller's own value as `JSAILS_TEST_TMPDIR` (empty when it was unset), which
 * the preload restores in every test process.
 */
export function childEnvironment(env, { suite, coverage, services = [], coverageTemp }) {
  const childEnv = { ...env, JSAILS_TEST_SUITE: suite };
  if (!services.includes('valkey')) delete childEnv.VALKEY_URL;
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.JSAILS_TEST_FILE_PID;
  delete childEnv.JSAILS_ENV_RESOLVED;
  childEnv.NODE_ENV ??= 'test';
  if (childEnv.NODE_ENV === 'test') childEnv.JSAILS_ENV ??= 'test';
  if (coverage) delete childEnv.NODE_COMPILE_CACHE;
  else childEnv.NODE_COMPILE_CACHE ??= join(repoRoot, 'node_modules', '.cache', 'jsails-compile');
  if (coverage && coverageTemp !== undefined) {
    childEnv.JSAILS_TEST_TMPDIR = env.TMPDIR ?? '';
    childEnv.TMPDIR = coverageTemp;
  }
  if (!childEnv.JSAILS_TEST_SPAWN_CONCURRENCY) {
    childEnv.JSAILS_TEST_SPAWN_CONCURRENCY = String(DEFAULT_SPAWN_CONCURRENCY);
  }
  return childEnv;
}

/** A file-system-safe form of a package name. */
export function workspaceSlug(name) {
  return name.replace(/^@/, '').replace(/[^a-z0-9.-]+/gi, '-');
}

/**
 * The file name of a run's records, its reconcile verdict under
 * `test-results/reconcile/` and its per-file timings under
 * `test-results/timings/tests/`: the workspace, then `database-<type>` for a
 * database run, each declared service, and `shard-<i>-of-<n>`, so runs of one
 * workspace in other contexts keep their own records.
 */
export function runFileName(workspace, { suite = 'default', database, services = [], shard } = {}) {
  const parts = [workspaceSlug(workspace)];
  if (suite !== 'default') parts.push(database === undefined ? suite : `${suite}-${database}`);
  parts.push(...[...services].sort());
  if (shard !== undefined) parts.push(`shard-${shard.index}-of-${shard.total}`);
  return `${parts.join('.')}.json`;
}

/**
 * The file name of a run's per-file timings: its `runFileName`, with a
 * `.coverage` part for a coverage run, whose timings (an instrumented,
 * uncached run) must not replace a plain run's.
 */
export function timingsFileName(workspace, { coverage = false, ...context } = {}) {
  const name = runFileName(workspace, context);
  return coverage ? name.replace(/\.json$/, '.coverage.json') : name;
}

/**
 * The lane lease of a run (see the header): a pass-through under the
 * workspace runner's lease, else one sized from the previous timing record
 * (`scripts/test-budget.mjs`). Resolves with the grant, the
 * `--test-concurrency` to use (undefined: node's default) and each file's
 * memory estimate.
 */
export async function laneLease({
  workspace,
  files,
  coverage,
  forwarded = [],
  env = process.env,
  previous = previousTimings({ coverage }),
  acquireLease = acquire,
  parallelism = availableParallelism(),
}) {
  const forwardedFlag = forwarded.find((flag) => flag.startsWith('--test-concurrency='));
  const fixed = forwardedFlag
    ? Math.max(1, Number(forwardedFlag.split('=')[1]) || 1)
    : positiveInteger('JSAILS_TEST_CONCURRENCY', undefined, env);
  const estimates = fileEstimates(workspace, files, previous);
  const overheadMb = laneOverheadMb(workspace, previous, { coverage, wrapped: false });
  const request = laneRequest({
    estimates,
    // node's own default width for a run started directly.
    share: Math.max(1, parallelism - 1),
    overheadMb,
    serialMs: serialWallMs(workspace, previous),
    runLimitMs: positiveInteger('JSAILS_TEST_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS, env),
    fixed,
  });
  const grant = await acquireLease({ label: `test:${workspace}`, ...request }, { env });
  if (grant.nested || fixed !== undefined) return { grant, concurrency: fixed, estimates };
  return { grant, concurrency: laneConcurrency(grant, { estimates, overheadMb }), estimates };
}

/**
 * `files` with the heaviest `estimates` (MiB, one per file) first, ties in
 * their given order. Each file is its own process and is reconciled on its
 * own, so the order changes no verdict; starting the heavy files first keeps
 * them from landing together at the end of the run and shortens its tail.
 */
export function heaviestFirst(files, estimates) {
  return files
    .map((file, index) => ({ file, index, mb: estimates[index] ?? 0 }))
    .sort((a, b) => b.mb - a.mb || a.index - b.index)
    .map(({ file }) => file);
}

/** This process's own private memory (MiB) from `/proc/self/status`, or 0 without it. */
function ownPrivateMb() {
  try {
    return parseStatusMemory(readFileSync('/proc/self/status', 'utf8')) / 1024;
  } catch {
    return 0;
  }
}

/** `text` as a regular expression that matches it literally. */
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DRAFT_MESSAGE_LENGTH = 160;
const LOOPBACK_HOST = String.raw`localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0`;
// Where a path in a message ends: whitespace, a quote, or closing punctuation.
const PATH_REST = String.raw`[^\s'"\x60()\[\],;]*`;

function realDirectory(dir) {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/**
 * The directories whose absolute paths differ between machines and runs: the
 * checkout, the temporary directory, and the home directory, also resolved
 * through links (macOS's `/var` is `/private/var`, Windows shortens profile
 * names in `TEMP`), each as written natively, with forward slashes, and as a
 * file URL. Longest first, so the most specific root wins.
 */
export function runRoots(
  dirs = [repoRoot, tmpdir(), homedir()],
  windows = process.platform === 'win32',
) {
  const roots = new Set();
  for (const dir of dirs) {
    for (const form of new Set([dir, realDirectory(dir)])) {
      // A file-system root (`/`, `C:\\`) would turn every absolute path into a
      // wildcard.
      if (win32.dirname(form) === form || posix.dirname(form) === form) continue;
      roots.add(form);
      roots.add(form.replaceAll('\\', '/'));
      roots.add(pathToFileURL(form, { windows }).href);
    }
  }
  return [...roots].sort((a, b) => b.length - a.length);
}

/**
 * `text` as a regular expression that matches it literally, except for what
 * changes from one run to the next: an absolute path under one of `roots`
 * becomes `.*`, and a loopback port becomes `\d+`. At most `limit` characters
 * of `text` are kept; a wildcard is never cut.
 */
export function messagePattern(text, roots, limit = DRAFT_MESSAGE_LENGTH) {
  const alternatives = [
    // A root counts only as a whole path segment: `/tmp` is not in `/tmpfs`.
    ...(roots.length > 0
      ? [`(?<path>(?:${roots.map(escapeRegExp).join('|')})(?![\\w-])${PATH_REST})`]
      : []),
    `(?<host>${LOOPBACK_HOST}):\\d+`,
  ];
  const varying = new RegExp(alternatives.join('|'), 'gi');
  let pattern = '';
  let used = 0;
  let last = 0;
  let wildcard = false;
  const literal = (piece) => {
    const kept = piece.slice(0, Math.max(0, limit - used));
    used += kept.length;
    if (kept !== '') wildcard = false;
    pattern += escapeRegExp(kept);
  };
  for (const match of text.matchAll(varying)) {
    literal(text.slice(last, match.index));
    if (used >= limit) return pattern;
    if (match.groups.path !== undefined) {
      if (!wildcard) pattern += '.*';
      wildcard = true;
    } else {
      pattern += `${escapeRegExp(match.groups.host)}:\\d+`;
      wildcard = false;
    }
    used += match[0].length;
    last = match.index + match[0].length;
  }
  if (used < limit) literal(text.slice(last));
  return pattern;
}

/**
 * A ledger entry for an unexpected failure, scoped to the run it was seen in
 * (`context`: `platform`, `suite`, `database`, `services`), with no `reason`
 * or `fixedBy`. Its `failure.message` is the first line of the message,
 * escaped and cut to a stable prefix (`messagePattern`, with paths under
 * `roots` and loopback ports as wildcards), so it states how the test fails
 * without repeating a diff or the machine it ran on.
 */
export function draftEntry(result, context, roots = runRoots()) {
  const firstLine =
    String(result.message ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? '';
  const failure = {};
  if (firstLine !== '') failure.message = messagePattern(firstLine, roots);
  if (result.errorName !== undefined) failure.name = result.errorName;
  if (result.failureType !== undefined && result.failureType !== 'testCodeFailure') {
    failure.type = result.failureType;
  }
  const entry = { file: result.file };
  if (!result.fileLevel) {
    entry.test = [...result.path];
    // A per-test entry needs a message; an empty one still names the failure.
    failure.message ??= '^$';
  }
  if (Object.keys(failure).length > 0) entry.failure = failure;
  if (context.platform !== 'linux') entry.platforms = [context.platform];
  if (context.suite === 'database') entry.databases = [context.database];
  if (context.services.length > 0) entry.services = [...context.services];
  return entry;
}

/** The record of one run's reconcile verdict. */
export function verdictRecord(verdict, context, roots = runRoots()) {
  const failure = (result) => ({
    file: result.file,
    path: result.path,
    fileLevel: result.fileLevel === true,
    failureType: result.failureType,
    errorName: result.errorName,
    message: result.message,
  });
  const listed = (entry) => ({ ledger: entry.ledger, file: entry.file, test: entry.test });
  return {
    ...context,
    ok: verdict.ok,
    unexpectedFailures: verdict.unexpectedFailures.map(failure),
    mismatched: verdict.mismatched.map(({ result, entry }) => ({
      ...failure(result),
      entry: { ...listed(entry), failure: entry.failure },
    })),
    unexpectedPasses: verdict.unexpectedPasses.map(({ entry, outcome }) => ({
      ...listed(entry),
      outcome,
    })),
    stale: verdict.stale.map(listed),
    drafts: verdict.unexpectedFailures.map((result) => draftEntry(result, context, roots)),
  };
}

/**
 * The verdict of a run a termination signal cut short: not ok, and nothing
 * else, because the files it never finished would read as stale entries and
 * its killed processes as unexpected failures.
 */
export function interruptedRecord(context, signal) {
  return {
    ...context,
    ok: false,
    interrupted: signal,
    unexpectedFailures: [],
    mismatched: [],
    unexpectedPasses: [],
    stale: [],
    drafts: [],
  };
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const workspaceDir = process.cwd();
  const workspace = readManifest(workspaceDir).name;
  const options = parseArgs(process.argv.slice(2));
  const testDir = join(workspaceDir, 'dist', 'test');
  if (!existsSync(testDir)) {
    console.error(`Missing build output: ${testDir} does not exist. Run "npm run build" first.`);
    return 1;
  }

  const database = options.suite === 'database' ? process.env.DATABASE_TYPE : 'sqlite';
  if (options.suite === 'database' && !SERVER_DATABASES.includes(database)) {
    throw new UsageError(`--suite=database needs DATABASE_TYPE=${SERVER_DATABASES.join('|')}`);
  }
  let services;
  try {
    services = declaredServices(process.env.JSAILS_TEST_SERVICES);
  } catch (error) {
    throw new UsageError(error.message);
  }

  const compiled = collectTests(testDir);
  let files = compiled.filter((file) => sourceOf(file, workspaceDir) !== undefined);
  for (const stale of compiled.filter((file) => !files.includes(file))) {
    console.error(`Skipping ${relative(workspaceDir, stale)}: its source test no longer exists.`);
  }
  files = files.filter((file) => inSuite(file, options.suite));
  if (options.shard !== undefined) files = shardFiles(files, options.shard);
  if (files.length === 0) {
    if (options.suite === 'default' && options.shard === undefined) {
      console.error(`No *.test.js files found under ${testDir}. Run "npm run build" first.`);
      return 1;
    }
    console.log(`${workspace}: no test files in this ${options.suite} suite selection.`);
    return 0;
  }

  if (options.forwarded.includes('--watch')) {
    const args = testCommand(files, {
      flags: [
        ...testNodeFlags(),
        '--test',
        ...nodeTestFlags(options, {
          concurrency: positiveInteger('JSAILS_TEST_CONCURRENCY', undefined),
        }),
      ],
      workspaceDir,
    });
    const outcome = await run(process.execPath, args, {
      cwd: workspaceDir,
      env: childEnvironment(process.env, { ...options, services }),
    });
    return exitStatus(outcome);
  }

  // The lease comes before the run limit starts: waiting for the machine is not running.
  const { grant, concurrency, estimates } = await laneLease({
    workspace,
    files: files.map((file) => repoPath(sourceOf(file, workspaceDir))),
    coverage: options.coverage,
    forwarded: options.forwarded,
  });
  const coverageTemp =
    options.coverage && diskTempBase() !== undefined ? diskBackedTempRoot('coverage') : undefined;
  const childEnv = {
    ...childEnvironment(process.env, { ...options, services, coverageTemp }),
    ...grant.env,
  };
  const scratch = mkdtempSync(join(tmpdir(), 'jsails-tests-'));
  try {
    const reporterOutput = join(scratch, 'results.jsonl');
    const recordDir = join(scratch, 'records');
    mkdirSync(recordDir);
    childEnv.JSAILS_TEST_RECORD_DIR = recordDir;
    // A termination signal (the workspace runner stopping, a cancelled CI job)
    // ends the test child early; what it reported is not a run to reconcile.
    let interrupted;
    const onSignal = (name) => {
      interrupted ??= name;
    };
    for (const name of FORWARDED_SIGNALS) process.on(name, onSignal);
    const runLimitMs = positiveInteger('JSAILS_TEST_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS);
    const limit = new AbortController();
    let overran = false;
    const limitTimer = setTimeout(() => {
      overran = true;
      limit.abort();
    }, runLimitMs);
    let outcome;
    let sampler;
    let peaks;
    let lowestFreeMb;
    // node keeps the dumps in its own temporary directory until the run ends.
    const freeSpace = options.coverage ? watchFreeSpace(coverageTemp ?? tmpdir()) : undefined;
    try {
      outcome = await run(
        process.execPath,
        testCommand(heaviestFirst(files, estimates), {
          flags: [
            ...testNodeFlags(),
            '--test',
            ...nodeTestFlags(options, { reporterOutput, concurrency }),
          ],
          workspaceDir,
        }),
        {
          cwd: workspaceDir,
          env: childEnv,
          signal: limit.signal,
          onSpawn: (child) => {
            if (process.platform === 'linux') sampler = startTreeSampler(child.pid);
          },
        },
      );
    } finally {
      clearTimeout(limitTimer);
      for (const name of FORWARDED_SIGNALS) process.removeListener(name, onSignal);
      peaks = sampler?.stop();
      lowestFreeMb = freeSpace?.stop();
    }
    const recordName = runFileName(workspace, {
      ...options,
      database: options.suite === 'database' ? database : undefined,
      services,
    });
    const runContext = {
      workspace,
      suite: options.suite,
      ...(options.shard === undefined
        ? {}
        : { shard: `${options.shard.index}/${options.shard.total}` }),
      platform: process.platform,
      database,
      services,
    };
    if (interrupted !== undefined) {
      writeJson(
        join(repoRoot, 'test-results', 'reconcile', recordName),
        interruptedRecord(runContext, interrupted),
      );
      console.error(
        `\n${workspace}: test run interrupted by ${interrupted}; its results were not reconciled`,
      );
      return 128 + (constants.signals[interrupted] ?? 0);
    }

    const text = existsSync(reporterOutput) ? readFileSync(reporterOutput, 'utf8') : '';
    const { coverage, coverageUnavailable, coverageIncomplete, complete, ...parsed } =
      readResults(text);
    let { results } = parsed;
    const records = readRecords(recordDir, files);
    // With every file in one process there is no per-file process to judge.
    if (!options.forwarded.some((arg) => SHARED_PROCESS_FLAGS.includes(arg))) {
      const failing = new Set(
        results
          .filter((result) => result.outcome === 'fail' && result.file !== undefined)
          .map((result) => resolve(result.file)),
      );
      const processResults = processFailures(
        files.map((file) => resolve(file)),
        records,
        failing,
      );
      // node's own file-level result for such a file ("test failed") is the
      // same event seen from outside; the record says what it was.
      const failedProcesses = new Set(processResults.map((result) => result.file));
      results = results.filter(
        (result) => !(result.fileLevel && failedProcesses.has(resolve(result.file))),
      );
      results.push(...processResults);
    }
    for (const result of results) {
      const source = result.file === undefined ? undefined : sourceOf(result.file, workspaceDir);
      result.source = source === undefined ? String(result.file) : repoPath(source);
    }
    const ledgerEntries = readLedgers()
      .filter((ledger) => ledger.kind === 'tests')
      .flatMap((ledger) => ledger.entries.map((entry) => ({ ...entry, ledger: ledger.name })));
    const verdict = reconcile({
      results: results.map((result) => ({ ...result, file: result.source })),
      entries: ledgerEntries,
      files: new Set(files.map((file) => repoPath(sourceOf(file, workspaceDir)))),
      context: { platform: process.platform, database, services },
      filtered: options.forwarded.some((arg) => FILTER_FLAGS.some((flag) => arg.startsWith(flag))),
    });
    writeJson(
      join(repoRoot, 'test-results', 'reconcile', recordName),
      verdictRecord(verdict, runContext),
    );

    const timings = timingsOf(records, workspaceDir, peaks?.childPeaks);
    const ownMb = ownPrivateMb();
    const timingsName = timingsFileName(workspace, {
      ...options,
      database: options.suite === 'database' ? database : undefined,
      services,
    });
    writeJson(join(repoRoot, 'test-results', 'timings', 'tests', timingsName), {
      workspace,
      suite: options.suite,
      coverage: options.coverage,
      ...(peaks?.peakMb === undefined
        ? {}
        : {
            runnerMb: Math.round(peaks.rootPeakMb + ownMb),
            observedPeakMb: Math.round(peaks.peakMb + ownMb),
          }),
      ...(grant.nested ? {} : { grantMb: grant.mb, grantCpu: grant.cpu, waitMs: grant.waitedMs }),
      concurrency: concurrency ?? null,
      files: timings,
    });

    const problems = [];
    if (overran) {
      problems.push(
        `the run passed its ${runLimitMs} ms limit (JSAILS_TEST_RUN_TIMEOUT_MS) and was stopped; each file listed without an exit record was still running`,
      );
    }
    if (!complete) problems.push('the test reporter did not finish; the run is incomplete');
    const failed = results.some((result) => result.outcome === 'fail');
    if (outcome.code !== 0 && !failed) {
      problems.push(`node --test exited with status ${exitStatus(outcome)} without a failing test`);
    }
    for (const result of verdict.unexpectedFailures) {
      problems.push(
        `unexpected failure: ${describeResult(result)}${result.message ? ` (${result.message})` : ''}`,
      );
    }
    for (const { result, entry } of verdict.mismatched) {
      const expectedFailure = JSON.stringify(entry.failure ?? {});
      const seen = [result.failureType, result.errorName, result.message]
        .filter((part) => part !== undefined && part !== '')
        .join(': ');
      problems.push(
        `listed test fails for another reason: ${describeEntry(entry)} expects ${expectedFailure}, got ${seen}`,
      );
    }
    for (const { entry, outcome: seen } of verdict.unexpectedPasses) {
      const what = seen === 'skip' ? 'is skipped' : 'passes';
      problems.push(
        `listed as failing but ${what}: ${describeEntry(entry)}; remove or scope the entry`,
      );
    }
    for (const entry of verdict.stale) {
      problems.push(`listed test did not run: ${describeEntry(entry)}; it was renamed or removed`);
    }
    const unmeasured = options.coverage
      ? unmeasuredCoverage({
          unavailable: coverageUnavailable,
          incomplete: coverageIncomplete,
          lowestFreeMb,
        })
      : undefined;
    if (unmeasured !== undefined) {
      // node then still reports totals, over fewer dumps or none: never record or judge them.
      problems.push(`coverage was not measured: ${unmeasured}`);
    } else if (options.coverage) {
      writeJson(join(repoRoot, 'test-results', 'coverage', `${workspaceSlug(workspace)}.json`), {
        workspace,
        ...coverage,
      });
      const floors = JSON.parse(readFileSync(join(repoRoot, 'coverage-floors.json'), 'utf8'));
      const floor = floors.workspaces?.[workspace];
      if (floor === undefined && coverage !== undefined) {
        console.log(
          `\n${workspace}: no coverage floor yet (lines ${coverage.lines.toFixed(2)}%, branches ${coverage.branches.toFixed(2)}%, functions ${coverage.functions.toFixed(2)}%); record one with "npm run coverage:floors".`,
        );
      }
      problems.push(...checkCoverage(workspace, coverage, floor));
    }

    const slowest = timings.slice(0, SLOWEST_SHOWN);
    if (slowest.length > 0) {
      console.log(`\n${workspace}: slowest test files (wall / CPU ms)`);
      for (const { file, wallMs, cpuMs } of slowest) console.log(`  ${wallMs} / ${cpuMs}  ${file}`);
    }
    if (verdict.expected.length > 0) {
      console.log(
        `\n${workspace}: ${verdict.expected.length} expected failure(s) from the ledgers:`,
      );
      for (const { result, entry } of verdict.expected) {
        console.log(`  ${describeResult(result)} [${entry.ledger}: ${entry.fixedBy}]`);
      }
    }
    if (problems.length > 0) {
      console.error(`\n${workspace}: test run failed:`);
      for (const problem of problems) console.error(`  ${problem}`);
      return 1;
    }
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (coverageTemp !== undefined) rmSync(coverageTemp, { recursive: true, force: true });
    grant.release();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      error instanceof UsageError ? error.message : `run-tests: ${error.stack ?? error}`,
    );
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
