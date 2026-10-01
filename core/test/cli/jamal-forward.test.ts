/**
 * Tests for `jsails jamal ...`: it runs the `jamal` bin of the project's own
 * `@jsails/jamal` install with the same arguments and exit code, prints the
 * install line when the package is missing, and refuses a manifest whose bin
 * points outside the package.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  forwardToJamal,
  JamalForwardError,
  resolveJamalBin,
  runNodeBin,
} from '../../src/cli/jamal-forward.js';

// The resolver returns real paths, and the temporary directory may sit behind a
// symlink (macOS: /var -> /private/var).
const root = realpathSync(mkdtempSync(join(tmpdir(), 'jsails-jamal-forward-')));
after(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;

/** A project directory, optionally with an installed `@jsails/jamal` whose manifest is `manifest`. */
function project(manifest?: Record<string, unknown>, binSource?: string): string {
  const dir = join(root, `project-${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"app","type":"module"}\n');
  if (manifest !== undefined) {
    const packageDir = join(dir, 'node_modules', '@jsails', 'jamal');
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest));
    if (binSource !== undefined) writeFileSync(join(packageDir, 'dist', 'bin.js'), binSource);
  }
  return dir;
}

const JAMAL_MANIFEST = {
  name: '@jsails/jamal',
  type: 'module',
  bin: { jamal: './dist/bin.js' },
  exports: { './package.json': './package.json' },
};

describe('resolveJamalBin', () => {
  it('resolves the bin the installed package declares', () => {
    const dir = project(JAMAL_MANIFEST, '');
    assert.equal(
      resolveJamalBin(dir),
      join(dir, 'node_modules', '@jsails', 'jamal', 'dist', 'bin.js'),
    );
  });

  it('reports a missing install with the install line', () => {
    assert.throws(
      () => resolveJamalBin(project()),
      (error: unknown) =>
        error instanceof JamalForwardError &&
        error.code === 'jamal_not_installed' &&
        /npm install @jsails\/jamal$/.test(error.suggestion ?? ''),
    );
  });

  it('accepts a bin file whose name starts with two dots', () => {
    const dir = project({ ...JAMAL_MANIFEST, bin: { jamal: './..bin.js' } });
    assert.equal(resolveJamalBin(dir), join(dir, 'node_modules', '@jsails', 'jamal', '..bin.js'));
  });

  it('refuses a manifest without a jamal bin or with one outside the package', () => {
    for (const bin of [
      undefined,
      42,
      '../escape.js',
      { other: './x.js' },
      { jamal: '../escape.js' },
      { jamal: '..' },
      { jamal: '.' },
      { jamal: '/etc/passwd' },
    ]) {
      assert.throws(
        () => resolveJamalBin(project({ ...JAMAL_MANIFEST, bin })),
        (error: unknown) =>
          error instanceof JamalForwardError && error.code === 'invalid_jamal_package',
        JSON.stringify(bin),
      );
    }
  });
});

describe('forwardToJamal', () => {
  it('runs the bin in the project with the arguments and returns its exit code', async () => {
    const dir = project(
      JAMAL_MANIFEST,
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = 7;\n',
    );
    const calls: { bin: string; args: readonly string[]; cwd: string }[] = [];
    const code = await forwardToJamal(['up', '--detach'], {
      cwd: dir,
      stderr: () => undefined,
      run: async (bin, args, cwd) => {
        calls.push({ bin, args, cwd });
        return runNodeBin(bin, args, cwd);
      },
    });

    assert.equal(code, 7);
    assert.deepEqual(calls[0]?.args, ['up', '--detach']);
    assert.equal(calls[0]?.cwd, dir);
  });

  it('prints the install hint and exits 1 when the package is missing', async () => {
    const err: string[] = [];
    let ran = false;
    const code = await forwardToJamal(['up'], {
      cwd: project(),
      stderr: (text) => err.push(text),
      run: async () => {
        ran = true;
        return 0;
      },
    });

    assert.equal(code, 1);
    assert.equal(ran, false);
    assert.match(err.join('\n'), /^jsails: @jsails\/jamal is not installed in this project/);
    assert.match(err.join('\n'), /hint: Install it: npm install @jsails\/jamal/);
  });

  it('reports a failure to start the bin, value-free', async () => {
    const err: string[] = [];
    const code = await forwardToJamal(['up'], {
      cwd: project(JAMAL_MANIFEST, ''),
      stderr: (text) => err.push(text),
      run: () => Promise.reject(new Error('spawn failed')),
    });

    assert.equal(code, 1);
    assert.match(err.join('\n'), /could not start jamal/);
  });
});
