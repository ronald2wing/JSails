/**
 * Runs the compiled node:test suite of the workspace it is invoked from
 * (`<cwd>/dist/test/**\/*.test.js`). Files are collected here rather than by a
 * shell or `node --test` glob so every workspace runs the same way on every
 * platform. Flags passed to this script are forwarded to `node --test` (for
 * example `--watch` or `--experimental-test-coverage`).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { exitStatus, run } from './subprocess.mjs';

const testDir = join(process.cwd(), 'dist', 'test');

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

const testFiles = collectTests(testDir).sort();

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
  const outcome = await run(process.execPath, ['--test', ...process.argv.slice(2), ...testFiles], {
    env: childEnv,
  });
  process.exit(exitStatus(outcome));
} catch (error) {
  console.error(`Failed to start test runner: ${error.message}`);
  process.exit(1);
}
