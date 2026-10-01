// Run every workspace's compiled test suite in one process.
//
// The root `test` script used to chain 23 `npm run test -w <workspace>` calls.
// Each one pays npm's startup cost (~2.2 s measured on this machine) to run a
// `tsc` plus a `node --test` that together take under a second, so most of the
// wall clock was npm bootstrapping. Measured on `@jsails/cache`: 4.4 s through
// npm against 0.9 s running the same two commands directly.
//
// Each workspace is still built and tested in isolation, in dependency order,
// and a failure stops the run with that workspace's exit code — the same
// fail-fast behaviour the chained script had. The build step is `build:clean`
// per workspace, matching what each workspace's own `test` script does.
//
// Usage: node scripts/test-workspaces.mjs [-- <extra node --test flags>]
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKSPACES } from './workspace-order.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tscPath = join(repoRoot, 'node_modules', '.bin', 'tsc');

/** Extra flags after `--` are forwarded to every `node --test` invocation. */
const separator = process.argv.indexOf('--');
const forwarded = separator === -1 ? [] : process.argv.slice(separator + 1);

/** Collect `*.test.js` under a directory, skipping symlinks and Playwright specs. */
function collectTests(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectTests(full));
    else if (entry.isFile() && entry.name.endsWith('.spec.js')) continue;
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(full);
  }
  return files;
}

// Default NODE_ENV for the test children only when the caller left it unset, so
// the server-components key path exercises its test-mode ephemeral key. Build a
// copy: never mutate this runner's own process.env.
const childEnv = { ...process.env };
if (childEnv.NODE_ENV === undefined) {
  childEnv.NODE_ENV = 'test';
}

let ran = 0;
for (const workspace of WORKSPACES) {
  const directory = join(repoRoot, workspace);
  if (!existsSync(join(directory, 'tsconfig.json'))) {
    console.error(`test-workspaces: ${workspace} has no tsconfig.json`);
    process.exit(1);
  }

  // `build:clean`: remove the previous output so a deleted test file cannot
  // keep passing from a stale `dist/`.
  rmSync(join(directory, 'dist'), { recursive: true, force: true });
  const build = spawnSync(tscPath, ['-p', 'tsconfig.json'], {
    stdio: 'inherit',
    cwd: directory,
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    console.error(`test-workspaces: ${workspace} failed to build`);
    process.exit(build.status ?? 1);
  }

  const testDir = join(directory, 'dist', 'test');
  if (!existsSync(testDir)) {
    // A workspace with no tests is not a failure: several plugins ship none.
    continue;
  }
  const testFiles = collectTests(testDir).sort();
  if (testFiles.length === 0) continue;

  const result = spawnSync(process.execPath, ['--test', ...forwarded, ...testFiles], {
    stdio: 'inherit',
    cwd: directory,
    env: childEnv,
  });
  if (result.status !== 0) {
    console.error(`test-workspaces: ${workspace} tests failed`);
    process.exit(result.status ?? 1);
  }
  ran += 1;
}

console.log(`test-workspaces: ${ran} workspace(s) ran tests`);
