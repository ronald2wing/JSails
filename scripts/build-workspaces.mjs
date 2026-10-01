// Build, clean-build, or typecheck every workspace in dependency order, in one
// process.
//
// The root scripts used to chain 23 `npm run <task> -w <workspace>` calls. Each
// one pays npm's startup cost (~2.2 s measured on this machine) to run a `tsc`
// that takes ~0.3 s, so most of the wall clock was npm bootstrapping. Running
// the same `tsc` invocations from a single process measured 6.2 s against
// 15.1 s for the equivalent `build`.
//
// The order lives in `workspace-order.mjs` and is load-bearing: a plugin's
// `tsc` resolves `jsails/*` through the built `core/dist`, so core must emit
// first. npm's `--workspaces` flag cannot be used here because it runs
// alphabetically, which puts `@jsails/admin` before `@jsails/cache`.
//
// Usage: node scripts/build-workspaces.mjs [build|build:clean|typecheck]
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKSPACES } from './workspace-order.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tscPath = join(repoRoot, 'node_modules', '.bin', 'tsc');

/**
 * The three tasks, expressed as the `tsc` invocation each workspace's own
 * script performs. `build:clean` additionally removes `dist/` first, which is
 * what the per-workspace `clean` script did.
 */
const TASKS = {
  build: { args: ['-p', 'tsconfig.json'], clean: false },
  'build:clean': { args: ['-p', 'tsconfig.json'], clean: true },
  typecheck: { args: ['-p', 'tsconfig.json', '--noEmit'], clean: false },
};

const task = process.argv[2] ?? 'build';
const spec = TASKS[task];
if (spec === undefined) {
  console.error(`build-workspaces: unknown task ${JSON.stringify(task)}`);
  console.error(`build-workspaces: expected one of ${Object.keys(TASKS).join(', ')}`);
  process.exit(1);
}

for (const workspace of WORKSPACES) {
  const directory = join(repoRoot, workspace);
  if (!existsSync(join(directory, 'tsconfig.json'))) {
    console.error(`build-workspaces: ${workspace} has no tsconfig.json`);
    process.exit(1);
  }
  if (!existsSync(join(directory, 'package.json'))) {
    console.error(`build-workspaces: ${workspace} has no package.json`);
    process.exit(1);
  }
  if (spec.clean) {
    rmSync(join(directory, 'dist'), { recursive: true, force: true });
  }
  // `tsc` resolves `include`/`outDir` relative to the config file, so the
  // working directory does not matter; it is set anyway so any relative path a
  // future config adds behaves the same as `npm run <task> -w`.
  const result = spawnSync(tscPath, spec.args, {
    stdio: 'inherit',
    cwd: directory,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`build-workspaces: ${workspace} failed (${task})`);
    process.exit(result.status ?? 1);
  }
}

console.log(`build-workspaces: ${task} across ${WORKSPACES.length} workspaces`);
