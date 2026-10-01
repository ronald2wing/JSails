/**
 * Tests for `jsails make:dockerfile`: what it writes, its refusal to
 * overwrite without `--force`, its flags, the project warnings, and its
 * dispatch through the built-in command table.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it, type TestContext } from 'node:test';

import { renderAppDockerfile, renderAppDockerignore } from '../../../src/app/dockerfile.js';
import { dispatch } from '../../../src/cli/dispatch.js';
import { BUILTIN_COMMANDS } from '../../../src/cli/manifest.js';
import {
  runMakeDockerfileCommand,
  type MakeDockerfileOptions,
} from '../../../src/cli/commands/make-dockerfile.js';

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('../..', import.meta.url)), 'make-dockerfile-fixture-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let dirSeq = 0;

/** A fresh project directory, optionally with a manifest and a lockfile. */
function project(files: Readonly<Record<string, string>> = {}): string {
  const dir = join(tmpRoot, `project-${dirSeq++}`);
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** A project the image build can start from: a build script and a lockfile. */
function buildableProject(): string {
  return project({
    'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
    'package-lock.json': '{}',
  });
}

interface Run {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

/** Run the command with console output captured. */
async function run(t: TestContext, options: MakeDockerfileOptions): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, 'log', (line: string) => void out.push(line));
  t.mock.method(console, 'error', (line: string) => void err.push(line));
  const code = await runMakeDockerfileCommand(options);
  t.mock.restoreAll();
  return { code, out, err };
}

function read(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

describe('runMakeDockerfileCommand', () => {
  it('writes the rendered Dockerfile and .dockerignore', async (t) => {
    const dir = buildableProject();
    const result = await run(t, { dir });

    assert.equal(result.code, 0);
    assert.equal(read(dir, 'Dockerfile'), renderAppDockerfile());
    assert.equal(read(dir, '.dockerignore'), renderAppDockerignore());
    assert.deepEqual(result.out, ['Created .dockerignore', 'Created Dockerfile']);
    assert.deepEqual(result.err, []);
  });

  it('refuses to overwrite and writes neither file', async (t) => {
    const dir = buildableProject();
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    const result = await run(t, { dir });

    assert.equal(result.code, 1);
    assert.equal(read(dir, 'Dockerfile'), 'FROM scratch\n');
    assert.equal(existsSync(join(dir, '.dockerignore')), false);
    assert.match(result.err.join('\n'), /refusing to overwrite Dockerfile; pass --force/);
  });

  it('names both files when both exist', async (t) => {
    const dir = buildableProject();
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, '.dockerignore'), 'secret\n');
    const result = await run(t, { dir });

    assert.equal(result.code, 1);
    assert.match(result.err.join('\n'), /refusing to overwrite \.dockerignore and Dockerfile/);
    assert.equal(read(dir, '.dockerignore'), 'secret\n');
  });

  it('replaces both files with --force, reproducing the same bytes', async (t) => {
    const dir = buildableProject();
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    const first = await run(t, { dir, force: true });
    assert.equal(first.code, 0);
    assert.deepEqual(first.out, ['Created .dockerignore', 'Replaced Dockerfile']);
    const bytes = read(dir, 'Dockerfile');

    const second = await run(t, { dir, force: true });
    assert.equal(second.code, 0);
    assert.equal(read(dir, 'Dockerfile'), bytes);
    assert.equal(bytes, renderAppDockerfile());
  });

  it('reports a directory in the way without replacing it', async (t) => {
    const dir = buildableProject();
    mkdirSync(join(dir, 'Dockerfile'));
    const result = await run(t, { dir, force: true });

    assert.equal(result.code, 1);
    assert.match(result.err.join('\n'), /Dockerfile is a directory/);
    assert.equal(existsSync(join(dir, '.dockerignore')), false);
  });

  it(
    'replaces a symbolic link itself with --force, never its target',
    { skip: process.platform === 'win32' && 'creating a symlink needs a privilege on Windows' },
    async (t) => {
      const dir = buildableProject();
      const outside = join(tmpRoot, `outside-${dirSeq++}`);
      writeFileSync(outside, 'not yours\n');
      symlinkSync(outside, join(dir, 'Dockerfile'));
      const result = await run(t, { dir, force: true });

      assert.equal(result.code, 0);
      assert.equal(readFileSync(outside, 'utf8'), 'not yours\n');
      assert.equal(lstatSync(join(dir, 'Dockerfile')).isSymbolicLink(), false);
      assert.equal(read(dir, 'Dockerfile'), renderAppDockerfile());
      assert.deepEqual(
        readdirSync(dir).filter((name) => name.endsWith('.tmp')),
        [],
        'no staged file is left behind',
      );
    },
  );

  it(
    'refuses a dangling symbolic link without --force',
    { skip: process.platform === 'win32' && 'creating a symlink needs a privilege on Windows' },
    async (t) => {
      const dir = buildableProject();
      symlinkSync(join(tmpRoot, 'no-such-target'), join(dir, 'Dockerfile'));
      const result = await run(t, { dir });

      assert.equal(result.code, 1);
      assert.match(result.err.join('\n'), /refusing to overwrite Dockerfile; pass --force/);
      assert.equal(existsSync(join(tmpRoot, 'no-such-target')), false);
      assert.equal(existsSync(join(dir, '.dockerignore')), false);
    },
  );

  it('probes a custom health path', async (t) => {
    const dir = buildableProject();
    const result = await run(t, { dir, healthPath: '/healthz' });

    assert.equal(result.code, 0);
    assert.equal(read(dir, 'Dockerfile'), renderAppDockerfile({ healthPath: '/healthz' }));
  });

  it('omits the HEALTHCHECK with --no-healthcheck', async (t) => {
    const dir = buildableProject();
    const result = await run(t, { dir, noHealthcheck: true });

    assert.equal(result.code, 0);
    assert.equal(read(dir, 'Dockerfile'), renderAppDockerfile({ healthPath: false }));
  });

  it('refuses an invalid health path as a usage error, without echoing it', async (t) => {
    const dir = buildableProject();
    const result = await run(t, { dir, healthPath: '/_jsails/secret-value' });

    assert.equal(result.code, 2);
    assert.equal(existsSync(join(dir, 'Dockerfile')), false);
    assert.doesNotMatch(result.err.join('\n'), /secret-value/);
  });

  it('refuses --health-path combined with --no-healthcheck', async (t) => {
    const dir = buildableProject();
    const result = await run(t, { dir, healthPath: '/up', noHealthcheck: true });

    assert.equal(result.code, 2);
    assert.match(result.err.join('\n'), /cannot be combined/);
  });

  it('fails on a project directory that does not exist, without echoing it', async (t) => {
    const missing = join(tmpRoot, 'no-such-project');
    const result = await run(t, { dir: missing });

    assert.equal(result.code, 1);
    assert.doesNotMatch(result.err.join('\n'), /no-such-project/);
  });

  it('warns about a missing lockfile and a missing build script', async (t) => {
    const dir = project({ 'package.json': JSON.stringify({ scripts: { dev: 'jsails dev' } }) });
    const result = await run(t, { dir });

    assert.equal(result.code, 0);
    assert.equal(result.err.length, 2);
    assert.match(result.err[0] as string, /warning: no package-lock\.json/);
    assert.match(result.err[1] as string, /warning: package\.json has no "build" script/);
  });

  it('warns once about an unreadable package.json, without echoing it', async (t) => {
    const dir = project({ 'package.json': '{ "name": "leaked-name", ' });
    const result = await run(t, { dir });

    assert.equal(result.code, 0);
    assert.equal(result.err.length, 1);
    assert.match(result.err[0] as string, /no readable package\.json/);
    assert.doesNotMatch(result.err[0] as string, /leaked-name/);
  });
});

describe('make:dockerfile dispatch', () => {
  it('has its own built-in entry beside the make family', () => {
    const names = BUILTIN_COMMANDS.map((command) => command.name);
    assert.ok(names.includes('make:dockerfile'));
    assert.ok(names.includes('make:page'));
    assert.equal(names.includes('make'), false);
  });

  it('parses its flags before running', async (t) => {
    const dir = buildableProject();
    t.mock.method(console, 'log', () => undefined);
    t.mock.method(console, 'error', () => undefined);
    const run = (...args: string[]): Promise<number> =>
      dispatch(['make:dockerfile', ...args], {
        cwd: dir,
        stdout: () => undefined,
        stderr: () => undefined,
      });

    assert.equal(await run('--dir', dir, '--health-path', '/healthz'), 0);
    assert.equal(read(dir, 'Dockerfile'), renderAppDockerfile({ healthPath: '/healthz' }));
    assert.equal(await run('--dir', dir), 1);
    assert.equal(await run('--dir', dir, '--force'), 0);
    assert.equal(read(dir, 'Dockerfile'), renderAppDockerfile());
    assert.equal(await run('--bogus'), 2);
    assert.equal(await run('extra'), 2);
  });
});
