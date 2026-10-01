/**
 * Tests for `jsails jamal ...`: it runs the `jamal` bin of the project's own
 * `@jsails/jamal` install with the same arguments and exit code, prints the
 * install line when the package is missing, and refuses a manifest whose bin
 * points outside the package. `runJamal` reports the same outcomes as data and
 * prints nothing, so a caller words one report of its own. The CLI loads no
 * environment before it forwards: the jamal bin decides each verb's.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runCli } from './spawn-cli.js';
import {
  forwardToJamal,
  JamalForwardErrors,
  resolveJamalBin,
  runJamal,
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
        JamalForwardErrors.is(error, 'jamal_not_installed') &&
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
        (error: unknown) => JamalForwardErrors.is(error, 'invalid_jamal_package'),
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
      env: {},
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
      env: {},
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
      env: {},
      stderr: (text) => err.push(text),
      run: () => Promise.reject(new Error('spawn failed')),
    });

    assert.equal(code, 1);
    assert.match(err.join('\n'), /could not start jamal/);
  });
});

describe('runJamal', () => {
  it('returns the exit code of a bin that ran', async () => {
    const outcome = await runJamal(['up'], {
      cwd: project(JAMAL_MANIFEST, ''),
      run: async () => 3,
    });
    assert.deepEqual(outcome, { kind: 'exited', code: 3 });
  });

  it('returns why the bin did not run instead of printing it', async () => {
    const missing = await runJamal(['up'], {
      cwd: project(),
      run: () => Promise.reject(new Error('must not run')),
    });
    assert.equal(missing.kind, 'not_run');
    assert.equal(
      missing.kind === 'not_run' && missing.error.code,
      'jamal_forward.jamal_not_installed',
    );

    const invalid = await runJamal(['up'], {
      cwd: project({ ...JAMAL_MANIFEST, bin: undefined }),
      run: () => Promise.reject(new Error('must not run')),
    });
    assert.equal(
      invalid.kind === 'not_run' && invalid.error.code,
      'jamal_forward.invalid_jamal_package',
    );

    const unstarted = await runJamal(['up'], {
      cwd: project(JAMAL_MANIFEST, ''),
      run: () => Promise.reject(new Error('spawn /secret/path ENOENT')),
    });
    assert.equal(
      unstarted.kind === 'not_run' && unstarted.error.code,
      'jamal_forward.jamal_start_failed',
    );
    assert.equal(unstarted.kind === 'not_run' && unstarted.error.message, 'could not start jamal');
    assert.equal(unstarted.kind === 'not_run' && unstarted.error.suggestion, undefined);
  });
});

describe('jsails jamal', () => {
  it('forwards the environment it was given, resolving no .env file or credentials first', async () => {
    const dir = project(
      JAMAL_MANIFEST,
      [
        "const keys = ['NODE_ENV', 'JSAILS_ENV', 'FROM_DOTENV', 'FROM_LOCAL', 'JSAILS_CREDENTIALS_KEY', 'JSAILS_ENV_RESOLVED'];",
        'process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));',
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, '.env'), 'FROM_DOTENV=dotenv-value\n');
    writeFileSync(join(dir, '.env.local'), 'FROM_LOCAL=local-value\n');
    const env: NodeJS.ProcessEnv = { ...process.env, JSAILS_CREDENTIALS_KEY: 'k'.repeat(43) };
    for (const key of [
      'NODE_ENV',
      'JSAILS_ENV',
      'FROM_DOTENV',
      'FROM_LOCAL',
      'JSAILS_ENV_RESOLVED',
    ]) {
      delete env[key];
    }

    const [plain, named] = await Promise.all([
      runCli(['jamal', 'deploy'], { cwd: dir, env }),
      runCli(['--env', 'staging', 'jamal', 'deploy'], { cwd: dir, env }),
    ]);

    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stderr, '');
    assert.deepEqual(JSON.parse(plain.stdout), {
      NODE_ENV: null,
      JSAILS_ENV: null,
      FROM_DOTENV: null,
      FROM_LOCAL: null,
      // The key reaches the bin unconsumed, for the environment its verb picks.
      JSAILS_CREDENTIALS_KEY: 'k'.repeat(43),
      JSAILS_ENV_RESOLVED: null,
    });
    // A leading --env names the environment the bin resolves, and nothing more.
    assert.equal(named.status, 0, named.stderr);
    assert.equal(JSON.parse(named.stdout).JSAILS_ENV, 'staging');
    assert.equal(JSON.parse(named.stdout).JSAILS_ENV_RESOLVED, null);
  });

  it('leaves a .env file that the bootstrap would refuse to the bin', async () => {
    const dir = project(JAMAL_MANIFEST, 'process.exitCode = 5;\n');
    writeFileSync(join(dir, '.env'), 'NODE_ENV=reserved-value-marker\n');
    const result = await runCli(['jamal', 'up'], { cwd: dir });
    assert.equal(result.status, 5);
    assert.equal(result.stderr, '');
  });
});
