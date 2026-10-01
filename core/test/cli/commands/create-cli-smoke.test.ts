/**
 * End-to-end smoke of `jsails create --cli`: scaffold the CLI-only preset,
 * compile it with the repo's TypeScript, and run its sample commands through
 * the compiled CLI. It is a serial chain of child processes, so it lives apart
 * from the other `create` cases and runs beside them.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { runCli as spawnCli, runProcess, type ProcessResult } from '../spawn-cli.js';

/** The framework package root, resolved from the compiled test module. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/** The repo's own TypeScript compiler binary (used to compile the CLI fixture). */
const TSC_PATH = join(PACKAGE_ROOT, '..', 'node_modules', '@typescript', 'native', 'bin', 'tsc');

const workspace = mkdtempSync(join(tmpdir(), 'jsails-create-cli-smoke-'));

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string): Promise<ProcessResult> {
  return spawnCli(args, { cwd });
}

describe('cli: --cli smoke', () => {
  it('scaffolds, compiles, and runs the hello command end to end', async () => {
    const create = await runCli(['create', 'cli-smoke', '--cli', '--no-git'], workspace);
    assert.equal(create.status, 0, create.stderr);

    const dir = join(workspace, 'cli-smoke');

    // Resolve `jsails` and `@types/node` without a real `npm install`: symlink
    // the repo's own packages into the fixture's node_modules, then compile
    // with the repo's TypeScript. This keeps the smoke fast and offline.
    const nodeModules = join(dir, 'node_modules');
    mkdirSync(join(nodeModules, '@types'), { recursive: true });
    symlinkSync(PACKAGE_ROOT, join(nodeModules, 'jsails'), 'dir');
    symlinkSync(
      join(PACKAGE_ROOT, '..', 'node_modules', '@types', 'node'),
      join(nodeModules, '@types', 'node'),
      'dir',
    );

    const build = await runProcess(process.execPath, [TSC_PATH, '-p', join(dir, 'tsconfig.json')]);
    assert.equal(build.status, 0, build.stderr);
    assert.ok(existsSync(join(dir, 'dist', 'commands', 'hello.js')), 'hello.js is compiled');
    assert.ok(existsSync(join(dir, 'dist', 'app', 'application-command.js')), 'shim is compiled');

    // The three invocations only read the compiled project, so they run at once.
    const [run, help, about] = await Promise.all([
      runCli(['hello', 'World'], dir),
      runCli(['hello', '--help'], dir),
      runCli(['about'], dir),
    ]);

    // Run the sample command with an explicit name (no interactive prompt).
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Hello, World!/);

    // `jsails <name>` discovers compiled commands; the CLI shape also ships a
    // real app config, so a config-declared command loads it.
    assert.equal(existsSync(join(dir, 'jsails.app.js')), true);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /hello - Greet someone by name/);

    // The app config declares an `about` command; run it after tsc compiles the
    // config (plain ESM, no `dist/` import, so it loads fine).
    assert.equal(about.status, 0, about.stderr);
    assert.match(about.stdout, /JSails CLI project/);
  });
});
