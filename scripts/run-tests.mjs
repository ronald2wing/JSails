/**
 * Runs the compiled node:test suite of the workspace it is invoked from
 * (`<cwd>/dist/test/**\/*.test.js`). Files are collected here rather than by a
 * shell or `node --test` glob so every workspace runs the same way on every
 * platform. Flags passed to this script are forwarded to `node --test` (for
 * example `--watch` or `--experimental-test-coverage`).
 *
 * A compiled test whose `test/**\/*.test.ts(x)` source no longer exists is
 * skipped with a notice: an incremental build never deletes output, so a
 * removed or renamed test would otherwise keep running from a stale `dist/`.
 * Every test gets a per-test timeout (`JSAILS_TEST_TIMEOUT_MS`, default five
 * minutes) unless the caller passes its own `--test-timeout`, so one hung test
 * fails instead of holding a CI runner until the job limit.
 *
 * Coverage is opt-in through the environment, so it applies to every workspace
 * a root runner visits: `JSAILS_TEST_COVERAGE_LINES`, `_BRANCHES`, and
 * `_FUNCTIONS` (percentages, 0-100) enable Node's coverage report and fail the
 * run when the workspace falls below any of them.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { exitStatus, run } from './subprocess.mjs';

const workspaceDir = process.cwd();
const testDir = join(workspaceDir, 'dist', 'test');
const DEFAULT_TEST_TIMEOUT_MS = 300_000;

if (!existsSync(testDir)) {
  console.error(`Missing build output: ${testDir} does not exist. Run "npm run build" first.`);
  process.exit(1);
}

function collectTests(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTests(full));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(full);
  }
  return files;
}

/** Whether `test/<same path>.test.ts` or `.tsx` still exists for a compiled test. */
function hasSource(compiled) {
  const stem = relative(testDir, compiled).slice(0, -'.js'.length);
  return ['.ts', '.tsx'].some((ext) => existsSync(join(workspaceDir, 'test', `${stem}${ext}`)));
}

const compiledTests = collectTests(testDir).sort();
const testFiles = compiledTests.filter(hasSource);
for (const stale of compiledTests.filter((file) => !testFiles.includes(file))) {
  console.error(`Skipping ${relative(workspaceDir, stale)}: its source test no longer exists.`);
}

const COVERAGE_THRESHOLDS = Object.freeze([
  ['JSAILS_TEST_COVERAGE_LINES', '--test-coverage-lines'],
  ['JSAILS_TEST_COVERAGE_BRANCHES', '--test-coverage-branches'],
  ['JSAILS_TEST_COVERAGE_FUNCTIONS', '--test-coverage-functions'],
]);

/** Coverage flags for every threshold set in the environment. */
function coverageFlags() {
  const flags = [];
  for (const [name, flag] of COVERAGE_THRESHOLDS) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') continue;
    const threshold = Number(raw);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      console.error(`${name} must be a percentage between 0 and 100`);
      process.exit(2);
    }
    flags.push(`${flag}=${threshold}`);
  }
  return flags.length === 0 ? [] : ['--experimental-test-coverage', ...flags];
}

/** The forwarded flags plus a default per-test timeout and any coverage thresholds. */
function testFlags(forwarded) {
  const coverage = coverageFlags();
  if (forwarded.some((flag) => flag.startsWith('--test-timeout'))) {
    return [...coverage, ...forwarded];
  }
  const raw = process.env.JSAILS_TEST_TIMEOUT_MS;
  const timeout = raw === undefined || raw === '' ? DEFAULT_TEST_TIMEOUT_MS : Number(raw);
  if (!Number.isInteger(timeout) || timeout < 1) {
    console.error('JSAILS_TEST_TIMEOUT_MS must be a positive integer');
    process.exit(2);
  }
  return [`--test-timeout=${timeout}`, ...coverage, ...forwarded];
}

if (testFiles.length === 0) {
  console.error(`No *.test.js files found under ${testDir}. Run "npm run build" first.`);
  process.exit(1);
}

// Default NODE_ENV for the test child only when the caller left it unset, so
// the server-components key path exercises its test-mode ephemeral key. The
// copy keeps this runner's own process.env untouched.
const childEnv = { ...process.env };
if (childEnv.NODE_ENV === undefined) {
  childEnv.NODE_ENV = 'test';
}

try {
  const outcome = await run(
    process.execPath,
    ['--test', ...testFlags(process.argv.slice(2)), ...testFiles],
    {
      env: childEnv,
    },
  );
  process.exit(exitStatus(outcome));
} catch (error) {
  console.error(`Failed to start test runner: ${error.message}`);
  process.exit(1);
}
