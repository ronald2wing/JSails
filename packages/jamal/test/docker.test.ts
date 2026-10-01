/**
 * Tests for the `jamal docker` execution verbs: argv assembly, `--dir`, and
 * missing compose/docker handling.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../src/command.js';
import { normalizeJamalConfig } from '../src/config/index.js';
import {
  composeArgv,
  execArgv,
  type DockerCommandResult,
  type DockerCommandRunner,
} from '../src/docker.js';

/** A minimal valid jamal config for the managed `.jamal/compose.yml` path. */
function fakeJamalConfig(): ReturnType<typeof normalizeJamalConfig> {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp:latest',
  });
}

/**
 * Tests for the Sail-like `jamal up|down|ps|logs` execution verbs. They inject
 * a command-runner seam so no real `docker` process is ever spawned; the seam
 * records the argv + cwd it was handed and returns canned results. Compose-file
 * existence is exercised against throwaway temp directories. The generation
 * subcommands (`dev`/`deploy`/`targets`) are asserted to never reach the
 * runner.
 */

interface Sinks {
  out: string[];
  err: string[];
}

function sinks(): Sinks {
  return { out: [], err: [] };
}

/** What the injected runner resolves to (or throws) on each call. */
type RunnerSpec = DockerCommandResult | Error;

interface Recorder {
  calls: { argv: readonly string[]; cwd: string }[];
  run: DockerCommandRunner;
}

function makeRunner(spec: RunnerSpec = { exitCode: 0, stdout: '', stderr: '' }): Recorder {
  const calls: { argv: readonly string[]; cwd: string }[] = [];
  const run: DockerCommandRunner = async (argv, options) => {
    calls.push({ argv, cwd: options.cwd });
    if (spec instanceof Error) {
      throw spec;
    }
    return spec;
  };
  return { calls, run };
}

/**
 * Build deps with an injected runner and the real built-in registry. Pass
 * `loadJamalConfig` to exercise the managed `.jamal/compose.yml` path; when
 * omitted, the real loader runs (so a missing config is a real failure).
 */
function deps(
  cwd: string,
  s: Sinks,
  run?: DockerCommandRunner,
  loadJamalConfig?: JamalDeps['loadJamalConfig'],
): JamalDeps {
  return {
    cwd,
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
    runCommand: run,
    loadJamalConfig,
  };
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'jamal-docker-test-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a project directory already containing the managed compose file. */
function withComposeFile(name: string): string {
  const dir = makeDir(name);
  mkdirSync(join(dir, '.jamal'), { recursive: true });
  writeFileSync(join(dir, '.jamal', 'compose.yml'), 'services: {}\n');
  return dir;
}

describe('jamal docker: argv assembly', () => {
  it('up materializes the managed compose file and runs docker compose up -d --wait', async () => {
    const dir = makeDir('up');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(
      ['up'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

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
  });

  it('up --detach is accepted and idempotent (already detached by default)', async () => {
    const dir = makeDir('up-detach');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(
      ['up', '--detach'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

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
  });

  it('up leaves the managed compose file unchanged on a second identical run', async () => {
    const dir = makeDir('up-idempotent');
    const s = sinks();
    const load = async () => fakeJamalConfig();

    assert.equal(await runJamalCommand(['up'], deps(dir, s, makeRunner().run, load)), 0);
    const first = readFileSync(join(dir, '.jamal', 'compose.yml'), 'utf8');

    const r = makeRunner();
    assert.equal(await runJamalCommand(['up'], deps(dir, s, r.run, load)), 0);
    const second = readFileSync(join(dir, '.jamal', 'compose.yml'), 'utf8');

    assert.equal(second, first);
  });

  it('down and ps map to their docker compose verbs', async () => {
    const dir = withComposeFile('down-ps');
    const s = sinks();
    const load = async () => fakeJamalConfig();

    const down = makeRunner();
    assert.equal(await runJamalCommand(['down'], deps(dir, s, down.run, load)), 0);
    assert.deepEqual(down.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'down',
    ]);
    assert.equal(down.calls[0]?.cwd, dir);

    const ps = makeRunner();
    assert.equal(await runJamalCommand(['ps'], deps(dir, s, ps.run, load)), 0);
    assert.deepEqual(ps.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'ps',
    ]);
    assert.equal(ps.calls[0]?.cwd, dir);
  });

  it('logs maps to docker compose logs with no extra flags', async () => {
    const dir = withComposeFile('logs');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(
      ['logs'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(r.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'logs',
    ]);
  });

  it('logs --follow appends --follow', async () => {
    const dir = withComposeFile('logs-follow');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(
      ['logs', '--follow'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(r.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'logs',
      '--follow',
    ]);
  });

  it('logs <service> appends the service name', async () => {
    const dir = withComposeFile('logs-service');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(
      ['logs', 'valkey'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(r.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'logs',
      'valkey',
    ]);
  });

  it('logs --follow <service> appends both in order', async () => {
    const dir = withComposeFile('logs-follow-service');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(
      ['logs', '--follow', 'valkey'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(r.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'logs',
      '--follow',
      'valkey',
    ]);
  });

  it('rejects more than one service for logs as a usage error', async () => {
    const dir = withComposeFile('logs-many');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(['logs', 'a', 'b'], deps(dir, s, r.run));

    assert.equal(code, 2);
    assert.equal(r.calls.length, 0);
    assert.match(s.err.join('\n'), /at most one service/);
  });

  it('rejects a positional argument on up/down/ps as a usage error', async () => {
    const dir = withComposeFile('up-arg');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(['up', 'extra'], deps(dir, s, r.run));

    assert.equal(code, 2);
    assert.equal(r.calls.length, 0);
    assert.match(s.err.join('\n'), /takes no arguments/);
  });
});

describe('jamal down --volumes', () => {
  const DOWN = ['docker', 'compose', '-f', '.jamal/compose.yml', '-p', 'myapp', 'down'];
  const LIST = [
    'docker',
    'volume',
    'ls',
    '--quiet',
    '--filter',
    'label=com.docker.compose.project=myapp',
  ];

  /** A process runner answering `docker volume ls` with `listed` and recording every call. */
  function volumeRunner(
    listed: string,
    rm: { exitCode: number; stderr?: string } = { exitCode: 0 },
  ) {
    const calls: (readonly string[])[] = [];
    const processRunner: NonNullable<JamalDeps['processRunner']> = async (argv) => {
      calls.push(argv);
      if (argv[2] === 'ls') return { exitCode: 0, stdout: listed, stderr: '' };
      return { exitCode: rm.exitCode, stdout: '', stderr: rm.stderr ?? '' };
    };
    return { calls, processRunner };
  }

  function volumeDeps(
    dir: string,
    s: Sinks,
    compose: Recorder,
    processRunner: JamalDeps['processRunner'],
    prompt?: JamalDeps['prompt'],
  ): JamalDeps {
    return {
      ...deps(dir, s, compose.run, async () => fakeJamalConfig()),
      processRunner,
      ...(prompt === undefined ? {} : { prompt }),
    };
  }

  it('plain down keeps the volumes: it never lists or removes one', async () => {
    const dir = withComposeFile('down-keeps');
    const s = sinks();
    const compose = makeRunner();
    const volumes = volumeRunner('myapp_mariadb-data\n');
    assert.equal(
      await runJamalCommand(['down'], volumeDeps(dir, s, compose, volumes.processRunner)),
      0,
    );
    assert.deepEqual(
      compose.calls.map((call) => call.argv),
      [DOWN],
    );
    assert.deepEqual(volumes.calls, []);
  });

  it('with --yes takes the project down, then removes exactly its labelled volumes', async () => {
    const dir = withComposeFile('down-volumes-yes');
    const s = sinks();
    const compose = makeRunner();
    const volumes = volumeRunner('myapp_valkey-data\nmyapp_mariadb-data\n');
    const code = await runJamalCommand(
      ['down', '--volumes', '--yes'],
      volumeDeps(dir, s, compose, volumes.processRunner),
    );
    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(
      compose.calls.map((call) => call.argv),
      [DOWN],
    );
    assert.deepEqual(volumes.calls, [
      LIST,
      ['docker', 'volume', 'rm', 'myapp_mariadb-data', 'myapp_valkey-data'],
    ]);
    assert.deepEqual(s.out, [
      'jamal: removed volume myapp_mariadb-data',
      'jamal: removed volume myapp_valkey-data',
    ]);
  });

  it('reports a project without volumes and removes nothing', async () => {
    const dir = withComposeFile('down-volumes-none');
    const s = sinks();
    const volumes = volumeRunner('');
    const code = await runJamalCommand(
      ['down', '--volumes', '--yes'],
      volumeDeps(dir, s, makeRunner(), volumes.processRunner),
    );
    assert.equal(code, 0);
    assert.deepEqual(volumes.calls, [LIST]);
    assert.deepEqual(s.out, ['jamal: the project "myapp" has no volumes to remove']);
  });

  it('asks for the project name and proceeds only when it is typed back', async () => {
    const questions: string[] = [];
    for (const [answer, expected] of [
      ['  myapp\n', 0],
      ['yes', 1],
      ['', 1],
    ] as const) {
      const dir = withComposeFile(`down-volumes-prompt-${expected}-${answer.trim() || 'empty'}`);
      const s = sinks();
      const compose = makeRunner();
      const volumes = volumeRunner('myapp_mariadb-data\n');
      const code = await runJamalCommand(
        ['down', '--volumes'],
        volumeDeps(dir, s, compose, volumes.processRunner, async (question) => {
          questions.push(question);
          return answer;
        }),
      );
      assert.equal(code, expected, JSON.stringify(answer));
      if (expected === 1) {
        // A refusal changes nothing: the containers keep running too.
        assert.deepEqual(compose.calls, []);
        assert.deepEqual(volumes.calls, []);
        assert.match(s.err.join('\n'), /down cancelled: the project name was not typed back/);
      }
    }
    assert.match(questions[0] ?? '', /local Compose project "myapp"/);
    assert.match(questions[0] ?? '', /Type the project name to continue: $/);
  });

  it('refuses with confirmation_required when no terminal can ask', async () => {
    const dir = withComposeFile('down-volumes-no-tty');
    const s = sinks();
    const compose = makeRunner();
    const volumes = volumeRunner('myapp_mariadb-data\n');
    const code = await runJamalCommand(
      ['down', '--volumes'],
      volumeDeps(dir, s, compose, volumes.processRunner, async () => undefined),
    );
    assert.equal(code, 1);
    assert.deepEqual(compose.calls, []);
    assert.deepEqual(volumes.calls, []);
    assert.match(s.err.join('\n'), /needs confirmation\n {2}hint: Pass --yes/);
  });

  it('stops before removing anything when compose down fails', async () => {
    const dir = withComposeFile('down-volumes-compose-fails');
    const s = sinks();
    const volumes = volumeRunner('myapp_mariadb-data\n');
    const code = await runJamalCommand(
      ['down', '--volumes', '--yes'],
      volumeDeps(
        dir,
        s,
        makeRunner({ exitCode: 3, stdout: '', stderr: '' }),
        volumes.processRunner,
      ),
    );
    assert.equal(code, 3);
    assert.deepEqual(volumes.calls, []);
  });

  it('propagates a failed removal and claims nothing removed', async () => {
    const dir = withComposeFile('down-volumes-rm-fails');
    const s = sinks();
    const volumes = volumeRunner('myapp_mariadb-data\n', {
      exitCode: 1,
      stderr: 'Error response from daemon: volume is in use\n',
    });
    const code = await runJamalCommand(
      ['down', '--volumes', '--yes'],
      volumeDeps(dir, s, makeRunner(), volumes.processRunner),
    );
    assert.equal(code, 1);
    assert.deepEqual(s.out, []);
    assert.match(s.err.join('\n'), /docker volume rm exited with code 1/);
  });

  it('accepts --volumes only on down and --yes only with --volumes', async () => {
    for (const args of [
      ['ps', '--volumes'],
      ['up', '--volumes'],
      ['down', '--yes'],
      ['ps', '--yes'],
    ]) {
      const dir = withComposeFile(`flags-${args.join('-')}`);
      const s = sinks();
      const compose = makeRunner();
      const code = await runJamalCommand(
        args,
        deps(dir, s, compose.run, async () => fakeJamalConfig()),
      );
      assert.equal(code, 2, args.join(' '));
      assert.deepEqual(compose.calls, []);
    }
  });
});

describe('jamal docker: a project another directory holds', () => {
  /** Deps whose Docker reports `dirs` as the directories of the project's containers. */
  function ownedDeps(
    dir: string,
    s: Sinks,
    compose: Recorder,
    dirs: readonly string[] | undefined,
    asked: string[] = [],
  ): JamalDeps {
    return {
      ...deps(dir, s, compose.run, async () => fakeJamalConfig()),
      composeProjectDirs: async (project) => {
        asked.push(project);
        return dirs;
      },
      processRunner: async () => {
        throw new Error('no docker volume call may run');
      },
      prompt: async () => {
        throw new Error('no prompt may be shown');
      },
    };
  }

  it('refuses every local verb before Compose runs, naming no directory or value', async () => {
    for (const args of [
      ['up'],
      ['down'],
      ['down', '--volumes', '--yes'],
      ['down', '--volumes'],
      ['ps'],
      ['logs', 'db'],
      ['exec', 'db', '--', 'true'],
    ]) {
      const dir = withComposeFile(`foreign-${args.join('-')}`);
      const other = makeDir(`foreign-other-${args.join('-')}`);
      const s = sinks();
      const compose = makeRunner();
      const asked: string[] = [];
      const code = await runJamalCommand(
        args,
        ownedDeps(dir, s, compose, [join(dir, '.jamal'), join(other, '.jamal')], asked),
      );
      assert.equal(code, 1, args.join(' '));
      assert.deepEqual(asked, ['myapp']);
      assert.deepEqual(compose.calls, [], args.join(' '));
      const err = s.err.join('\n');
      assert.match(err, /another directory's containers already use this app's Compose project/);
      assert.match(err, /hint: Give this app a service name of its own/);
      assert.doesNotMatch(err, new RegExp(other.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
    }
  });

  it('refuses the dev-container shortcuts too', async () => {
    const dir = makeDir('foreign-shortcut');
    const s = sinks();
    const compose = makeRunner();
    const code = await runJamalCommand(['npm', 'install'], {
      ...ownedDeps(dir, s, compose, [join(fixturesRoot, 'elsewhere', '.jamal')]),
      loadJamalConfig: async () =>
        normalizeJamalConfig({ service: 'myapp', image: 'myapp', local: { app: 'dev' } }),
    });
    assert.equal(code, 1);
    assert.deepEqual(compose.calls, []);
    assert.equal(existsSync(join(dir, '.jamal', 'compose.yml')), false);
  });

  it("runs when the project's containers are this app's, under any spelling of its path", async () => {
    const dir = withComposeFile('owned');
    const alias = join(fixturesRoot, 'owned-alias');
    symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    for (const dirs of [[], [join(dir, '.jamal')], [join(alias, '.jamal')], undefined]) {
      const s = sinks();
      const compose = makeRunner();
      assert.equal(
        await runJamalCommand(['ps'], ownedDeps(dir, s, compose, dirs)),
        0,
        JSON.stringify(dirs),
      );
      assert.equal(compose.calls.length, 1);
    }
  });
});

describe('jamal docker: project root', () => {
  it('runs docker compose in the working directory and refuses --dir', async () => {
    const root = makeDir('dir-root');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(
      ['up'],
      deps(root, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(r.calls[0]?.cwd, root);
    assert.equal(existsSync(join(root, '.jamal', 'compose.yml')), true);
    assert.equal(
      await runJamalCommand(
        ['up', '--dir', 'deploy'],
        deps(root, s, r.run, async () => fakeJamalConfig()),
      ),
      2,
    );
  });
});

describe('jamal docker: missing compose file', () => {
  it('up fails with a clear, value-free error when the jamal config is missing', async () => {
    const dir = makeDir('no-compose');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(['up'], deps(dir, s, r.run));

    assert.equal(code, 1);
    assert.equal(r.calls.length, 0);
    const err = s.err.join('\n');
    assert.match(err, /jamal\.config\.ts/);
    assert.match(err, /not found/);
    assert.ok(!err.includes('\n    at '), 'no stack trace may leak');
  });

  it('applies the same compose-file check to down, ps, and logs', async () => {
    const dir = makeDir('no-compose-verbs');
    const s = sinks();
    const r = makeRunner();

    for (const verb of ['down', 'ps', 'logs']) {
      const code = await runJamalCommand([verb], deps(dir, s, r.run));
      assert.equal(code, 1, verb);
      assert.equal(r.calls.length, 0);
    }
    assert.match(s.err.join('\n'), /jamal up/);
  });
});

describe('jamal docker: unavailable docker compose', () => {
  it('fails with a clear, sanitized error when docker is missing (ENOENT)', async () => {
    const dir = withComposeFile('missing-docker');
    const s = sinks();
    const enoent = Object.assign(new Error('spawn docker ENOENT'), {
      code: 'ENOENT',
    });
    const r = makeRunner(enoent);

    const code = await runJamalCommand(
      ['up'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 127);
    const err = s.err.join('\n');
    assert.match(err, /docker compose is not available/);
    assert.ok(!err.includes('spawn docker ENOENT'), 'raw spawn error must not leak');
  });

  it('reports unavailability when the runner seam is absent', async () => {
    const dir = withComposeFile('no-seam');
    const s = sinks();
    const d = deps(dir, s, undefined, async () => fakeJamalConfig());

    const code = await runJamalCommand(['up'], d);

    assert.equal(code, 127);
    assert.match(s.err.join('\n'), /docker compose is not available/);
  });
});

describe('jamal docker: runner failure propagation', () => {
  it('propagates the docker compose exit code and emits a sanitized summary', async () => {
    const dir = withComposeFile('exit-code');
    const s = sinks();
    const r = makeRunner({
      exitCode: 5,
      stdout: '',
      stderr: 'docker: something broke\n',
    });

    const code = await runJamalCommand(
      ['up'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 5);
    assert.match(s.err.join('\n'), /docker compose up exited with code 5/);
  });

  it('sanitizes a non-ENOENT spawn failure into a single jamal line', async () => {
    const dir = withComposeFile('spawn-fail');
    const s = sinks();
    const r = makeRunner(new Error('underlying reason'));

    const code = await runJamalCommand(
      ['down'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 1);
    const err = s.err.join('\n');
    assert.match(err, /jamal: failed to run docker compose down/);
    assert.ok(!err.includes('\n    at '), 'no stack trace may leak');
  });

  it('forwards the runner stdout on success (logs/ps output)', async () => {
    const dir = withComposeFile('forward');
    const s = sinks();
    const r = makeRunner({
      exitCode: 0,
      stdout: 'valkey  Up 5 seconds\n',
      stderr: '',
    });

    const code = await runJamalCommand(
      ['ps'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 0);
    assert.equal(s.out.join('\n'), 'valkey  Up 5 seconds');
  });
});

describe('jamal docker: composeArgv unit', () => {
  it('builds the fixed argv arrays without shell interpolation', () => {
    assert.deepEqual(composeArgv('up'), ['docker', 'compose', 'up', '-d']);
    assert.deepEqual(composeArgv('down'), ['docker', 'compose', 'down']);
    assert.deepEqual(composeArgv('ps'), ['docker', 'compose', 'ps']);
    assert.deepEqual(composeArgv('logs'), ['docker', 'compose', 'logs']);
    assert.deepEqual(composeArgv('logs', { follow: true }), [
      'docker',
      'compose',
      'logs',
      '--follow',
    ]);
    assert.deepEqual(composeArgv('logs', { service: 'valkey' }), [
      'docker',
      'compose',
      'logs',
      'valkey',
    ]);
    assert.deepEqual(composeArgv('logs', { follow: true, service: 'valkey' }), [
      'docker',
      'compose',
      'logs',
      '--follow',
      'valkey',
    ]);
  });

  it('inserts -f and -p before the verb and appends --wait to up', () => {
    const target = { file: '.jamal/compose.yml', project: 'myapp' };
    assert.deepEqual(composeArgv('up', { ...target, wait: true }), [
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
    assert.deepEqual(composeArgv('down', target), [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'down',
    ]);
    assert.deepEqual(composeArgv('logs', { ...target, follow: true, service: 'valkey' }), [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'logs',
      '--follow',
      'valkey',
    ]);
    // A lone -f or -p is emitted independently, still before the verb.
    assert.deepEqual(composeArgv('ps', { file: 'custom.yml' }), [
      'docker',
      'compose',
      '-f',
      'custom.yml',
      'ps',
    ]);
    assert.deepEqual(composeArgv('ps', { project: 'proj' }), [
      'docker',
      'compose',
      '-p',
      'proj',
      'ps',
    ]);
  });

  it('builds the fixed exec argv with the command right after the service', () => {
    assert.deepEqual(execArgv('valkey', ['sh', '-c', 'echo hi']), [
      'docker',
      'compose',
      'exec',
      'valkey',
      'sh',
      '-c',
      'echo hi',
    ]);
    assert.deepEqual(
      execArgv('app', ['node', '--foo'], {
        file: '.jamal/compose.yml',
        project: 'myapp',
      }),
      [
        'docker',
        'compose',
        '-f',
        '.jamal/compose.yml',
        '-p',
        'myapp',
        'exec',
        'app',
        'node',
        '--foo',
      ],
    );
  });
});
