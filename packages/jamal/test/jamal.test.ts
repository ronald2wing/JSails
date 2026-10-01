/**
 * Tests for the top-level `jamal` command: help and usage, the removed verbs
 * and flags, the managed local Compose verbs, and the prune planner. The
 * command runs in-process with injected runners, so no shell, Docker, or ssh
 * process is ever spawned; files are written only into throwaway temp
 * directories.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../src/command.js';
import { normalizeJamalConfig } from '../src/config/index.js';
import type { DockerCommandResult, DockerCommandRunner } from '../src/docker.js';

/** A minimal valid jamal config for the managed `.jamal/compose.yml` path. */
function fakeJamalConfig(): ReturnType<typeof normalizeJamalConfig> {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp:latest',
  });
}

/** Record the argv/cwd of each compose call without spawning a process. */
function recordingRunner(spec: DockerCommandResult = { exitCode: 0, stdout: '', stderr: '' }): {
  calls: { argv: readonly string[]; cwd: string }[];
  run: DockerCommandRunner;
} {
  const calls: { argv: readonly string[]; cwd: string }[] = [];
  const run: DockerCommandRunner = async (argv, options) => {
    calls.push({ argv, cwd: options.cwd });
    return spec;
  };
  return { calls, run };
}

interface Sinks {
  out: string[];
  err: string[];
}

function sinks(): Sinks {
  return { out: [], err: [] };
}

/** Build deps over captured sinks, with an optional config loader and runner. */
function deps(
  cwd: string,
  s: Sinks,
  loadJamalConfig?: JamalDeps['loadJamalConfig'],
  runCommand?: DockerCommandRunner,
): JamalDeps {
  return {
    loadJamalConfig:
      loadJamalConfig ??
      (() => {
        throw new Error('the config must not be loaded');
      }),
    cwd,
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
    runCommand,
  };
}

/** Like {@link deps}, but loading the real config file from `cwd`. */
function fileDeps(cwd: string, s: Sinks, runCommand?: DockerCommandRunner): JamalDeps {
  return {
    cwd,
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
    runCommand,
  };
}

/**
 * `prune` is a server-facing verb, which Windows refuses with
 * `unsupported_platform` (`platform.ts`; `platform.test.ts` proves the
 * refusal), so the tests of what it does run on POSIX only.
 */
const serverVerb = {
  skip: process.platform === 'win32' && 'a server-facing jamal verb, which Windows refuses',
};

const fixturesRoot = mkdtempSync(join(tmpdir(), 'jamal-test-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('jamal: help and usage', () => {
  it('prints usage on --help without loading the config', async () => {
    const s = sinks();

    const code = await runJamalCommand(['--help'], deps(makeDir('help'), s));

    assert.equal(code, 0);
    const out = s.out.join('\n');
    assert.match(out, /Usage:/);
    assert.match(out, /jamal <verb>/);
    assert.match(out, /jamal\.config\.ts/);
    assert.match(out, /docker compose up -d/);
    assert.doesNotMatch(out, /--write|--target|--dir|harden|registry|audit|snapshot/);
    assert.doesNotMatch(out, /^ {2}(?:dev|targets)\b/m);
    assert.equal(s.err.length, 0);
  });

  it('prints usage on a bare `jamal`', async () => {
    const s = sinks();

    const code = await runJamalCommand([], deps(makeDir('bare'), s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /subcommand is required/);
    assert.match(s.err.join('\n'), /Run "jamal --help" for usage\./);
  });

  it('reports an unknown subcommand as a usage error on every platform', async () => {
    // A name that spells an `Object.prototype` member is unknown too, and
    // Windows reports a typo as a usage error, not as a refused command.
    for (const platform of ['linux', 'win32'] as const) {
      for (const name of ['bogus', 'constructor', 'toString']) {
        const s = sinks();

        const code = await runJamalCommand([name], { ...deps(makeDir('bad-sub'), s), platform });

        assert.equal(code, 2, `${platform} ${name}`);
        assert.match(s.err.join('\n'), /unknown subcommand/);
        assert.doesNotMatch(s.err.join('\n'), /does not run on Windows/);
      }
    }
  });

  it('rejects an unknown flag as a usage error', async () => {
    const s = sinks();
    const code = await runJamalCommand(['up', '--bogus'], deps(makeDir('flag'), s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /Unknown option/);
  });

  it('prints the deploy help without loading the config', async () => {
    const s = sinks();

    const code = await runJamalCommand(['deploy', '--help'], deps(makeDir('deploy-help'), s));

    assert.equal(code, 0);
    const out = s.out.join('\n');
    assert.match(out, /jamal deploy \[options\]/);
    assert.match(out, /--dry-run/);
    assert.match(out, /--allow-dirty/);
    assert.doesNotMatch(out, /--tag/);
    assert.doesNotMatch(out, /--target|vercel|netlify|cloudflare|github|deployments/);
  });
});

describe('jamal: removed verbs and flags', () => {
  it('reports the static-host, generator, and plan-only verbs as unknown', async () => {
    for (const verb of ['dev', 'harden', 'targets', 'registry', 'audit', 'snapshot', 'once']) {
      const s = sinks();

      const code = await runJamalCommand([verb], deps(makeDir(`removed-${verb}`), s));

      assert.equal(code, 2, verb);
      assert.match(s.err.join('\n'), /unknown subcommand/, verb);
    }
  });

  it('rejects the target routing and file-writing flags as unknown options', async () => {
    for (const args of [
      ['deploy', '--target', 'vercel'],
      ['deploy', '--write'],
      ['up', '--dir', 'sub'],
      ['deploy', '--on-demand-tls'],
      ['deploy', '--no-harden'],
    ]) {
      const s = sinks();

      const code = await runJamalCommand(args, deps(makeDir('removed-flag'), s));

      assert.equal(code, 2, args.join(' '));
      assert.match(s.err.join('\n'), /Unknown option/, args.join(' '));
    }
  });
});

describe('jamal: config file', () => {
  it('loads jamal.config.ts through Node type stripping', async () => {
    const dir = makeDir('config-ts');
    writeFileSync(
      join(dir, 'jamal.config.ts'),
      "const service: string = 'typed';\nexport default { service, image: 'typed:latest' };\n",
    );
    const s = sinks();
    const r = recordingRunner();

    const code = await runJamalCommand(['up'], fileDeps(dir, s, r.run));

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(r.calls[0]?.argv[5], 'typed');
  });

  it('loads a plain jamal.config.js', async () => {
    const dir = makeDir('config-js');
    writeFileSync(
      join(dir, 'jamal.config.js'),
      "export default { service: 'plain', image: 'plain:latest' };\n",
    );
    const s = sinks();
    const r = recordingRunner();

    const code = await runJamalCommand(['up'], fileDeps(dir, s, r.run));

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(r.calls[0]?.argv[5], 'plain');
  });

  it('refuses a project with both config files, value-free', async () => {
    const dir = makeDir('config-both');
    writeFileSync(join(dir, 'jamal.config.ts'), "export default { service: 'a', image: 'a' };\n");
    writeFileSync(join(dir, 'jamal.config.js'), "export default { service: 'b', image: 'b' };\n");
    const s = sinks();
    const r = recordingRunner();

    const code = await runJamalCommand(['up'], fileDeps(dir, s, r.run));

    assert.equal(code, 1);
    assert.equal(r.calls.length, 0);
    assert.match(s.err.join('\n'), /both jamal\.config\.ts and jamal\.config\.js/);
  });
});

describe('jamal: managed compose (up/exec)', () => {
  it('up materializes .jamal/compose.yml and runs the managed argv', async () => {
    const dir = makeDir('up-managed');
    const s = sinks();
    const r = recordingRunner();
    const load = async () => fakeJamalConfig();

    const code = await runJamalCommand(['up'], deps(dir, s, load, r.run));

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'up',
      '-d',
      '--wait',
    ]);
    assert.equal(r.calls[0]?.cwd, dir);
    assert.equal(existsSync(join(dir, '.jamal', 'compose.yml')), true);
    assert.match(readFileSync(join(dir, '.jamal', 'compose.yml'), 'utf8'), /name: myapp/);
  });

  it('up reports a clear, value-free error when the jamal config is missing', async () => {
    const dir = makeDir('up-no-config');
    const s = sinks();
    const r = recordingRunner();

    const code = await runJamalCommand(['up'], fileDeps(dir, s, r.run));

    assert.equal(code, 1);
    assert.equal(r.calls.length, 0);
    const err = s.err.join('\n');
    assert.match(err, /jamal\.config\.ts/);
    assert.match(err, /not found/);
    assert.ok(!err.includes('\n    at '), 'no stack trace may leak');
  });

  it('exec requires the -- separator', async () => {
    const dir = makeDir('exec-no-sep');
    const s = sinks();

    const code = await runJamalCommand(['exec', 'valkey', 'sh'], deps(dir, s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires "--"/);
  });

  it('exec requires the managed compose file', async () => {
    const dir = makeDir('exec-no-file');
    const s = sinks();

    const code = await runJamalCommand(['exec', 'valkey', '--', 'sh', '-c', 'echo'], deps(dir, s));

    assert.equal(code, 1);
    const err = s.err.join('\n');
    assert.match(err, /\.jamal\/compose\.yml/);
    assert.match(err, /jamal up/);
  });

  it('exec wires the service and command into the managed exec argv', async () => {
    const dir = makeDir('exec-managed');
    mkdirSync(join(dir, '.jamal'), { recursive: true });
    writeFileSync(join(dir, '.jamal', 'compose.yml'), 'name: myapp\n');
    const s = sinks();
    const r = recordingRunner();
    const load = async () => fakeJamalConfig();

    const code = await runJamalCommand(
      ['exec', 'valkey', '--', 'sh', '-c', 'echo hi'],
      deps(dir, s, load, r.run),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(r.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'exec',
      'valkey',
      'sh',
      '-c',
      'echo hi',
    ]);
    assert.equal(r.calls[0]?.cwd, dir);
  });

  it('down/ps/logs use the managed file and project when it exists', async () => {
    const dir = makeDir('managed-fallback');
    mkdirSync(join(dir, '.jamal'), { recursive: true });
    writeFileSync(join(dir, '.jamal', 'compose.yml'), 'name: myapp\n');
    const s = sinks();
    const load = async () => fakeJamalConfig();

    const down = recordingRunner();
    assert.equal(await runJamalCommand(['down'], deps(dir, s, load, down.run)), 0);
    assert.deepEqual(down.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'down',
    ]);

    const ps = recordingRunner();
    assert.equal(await runJamalCommand(['ps'], deps(dir, s, load, ps.run)), 0);
    assert.deepEqual(ps.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'ps',
    ]);
  });
});

describe('jamal: prune', serverVerb, () => {
  it('prints the prune plan for a given image list', async () => {
    const dir = makeDir('prune-plan');
    const s = sinks();

    const code = await runJamalCommand(
      ['prune', '--keep', '2', '--images', 'myapp:a', '--images', 'myapp:b', '--images', 'myapp:c'],
      deps(dir, s),
    );

    assert.equal(code, 0, s.err.join('\n'));
    const out = s.out.join('\n');
    assert.match(out, /1 image\(s\) to remove/);
    assert.match(out, /myapp:c/);
    assert.match(out, /Kept 2 image/);
  });

  it('requires --keep', async () => {
    const dir = makeDir('prune-no-keep');
    const s = sinks();

    const code = await runJamalCommand(['prune'], deps(dir, s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /--keep/);
  });

  it('rejects --keep < 1', async () => {
    const dir = makeDir('prune-bad-keep');
    const s = sinks();

    const code = await runJamalCommand(['prune', '--keep', '0'], deps(dir, s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /--keep must be a positive integer/);
  });

  it('prints "No images to prune" when --images is empty', async () => {
    const dir = makeDir('prune-empty');
    const s = sinks();

    const code = await runJamalCommand(['prune', '--keep', '3'], deps(dir, s));

    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /No images to prune/);
  });
});
