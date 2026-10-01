/**
 * Tests for the `jamal app` verbs: boot, start, stop, details, and their remote
 * argv.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../src/command.js';
import { normalizeJamalConfig, type JamalConfig } from '../src/config/index.js';
import type { CommandResult } from '../src/production/process-runner.js';
import { stateOf, webContainer, type HostSpec } from './production/host-observation.js';
import { scriptedServer, type ScriptedCall } from './scripted-server.js';

/**
 * Tests for the `jamal app` lifecycle verbs. The config loader and the
 * server are injected: the server reports the host the test describes (by
 * default release 1 live), so the assertions target the exact remote argv each
 * verb assembles for the live release's container, the `--dry-run` output,
 * flag/positional validation, and value-free failure paths.
 */

function appConfig(overrides: { service?: string; server?: string } = {}): JamalConfig {
  return normalizeJamalConfig({
    service: overrides.service ?? 'myapp',
    image: 'ghcr.io/acme/myapp',
    production: { server: overrides.server ?? '1.2.3.4' },
  });
}

/** The live release's web container on the default host. */
const CONTAINER = webContainer(appConfig(), 1);

/** An app jamal routes through kamal-proxy. */
function routedConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    production: { server: '1.2.3.4', domain: 'example.com' },
  });
}

interface AppHarness {
  deps: JamalDeps;
  out: string[];
  err: string[];
  calls: ScriptedCall[];
}

function makeDeps(
  overrides: {
    config?: JamalConfig;
    host?: HostSpec;
    answer?: (remoteArgv: readonly string[]) => Partial<CommandResult> | undefined;
  } = {},
): AppHarness {
  const out: string[] = [];
  const err: string[] = [];
  const config = overrides.config ?? appConfig();
  const { remote, calls } = scriptedServer({
    config,
    ...(overrides.host === undefined ? {} : { host: overrides.host }),
    ...(overrides.answer === undefined ? {} : { answer: overrides.answer }),
  });
  const deps: JamalDeps = {
    loadJamalConfig: async () => config,
    remoteRunner: remote,
    cwd: '/project',
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, out, err, calls };
}

/** The remote argvs a verb sent, without the reads that found the live release. */
function argvs(calls: readonly ScriptedCall[]): string[][] {
  return calls.map((call) => call.remoteArgv);
}

/**
 * `jamal app` is a server-facing verb, so Windows refuses it with
 * `unsupported_platform` (`cli/platform-guard.ts`;
 * `core/test/cli/platform-guard.test.ts` proves the refusal): the tests of
 * what it does run on POSIX only. Its help still prints on every platform.
 */
const serverVerb = {
  skip: process.platform === 'win32' && 'jamal app is a server-facing verb, which Windows refuses',
};

describe('jamal app --help', () => {
  it('prints app usage on --help without loading config', async () => {
    const { deps, out } = makeDeps();

    const code = await runJamalCommand(['app', '--help'], deps);

    assert.equal(code, 0);
    const output = out.join('\n');
    assert.match(output, /jamal app - manage the app container/);
    assert.match(output, /boot\b/);
    assert.match(output, /start\b/);
    assert.match(output, /stop\b/);
    assert.match(output, /details\b/);
    assert.match(output, /containers\b/);
    assert.match(output, /logs \[--follow\]/);
    assert.match(output, /exec -- <cmd\.\.\.>/);
    assert.match(output, /--follow/);
    assert.match(output, /--dry-run/);
  });
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

describe('jamal app: the live release', serverVerb, () => {
  it('targets the release the server records as live, not the newest container', async () => {
    const { deps, calls } = makeDeps({
      host: { releases: [1, [2, 1]], state: stateOf(1), containers: [1, 2] },
    });
    assert.equal(await runJamalCommand(['app', 'logs'], deps), 0);
    assert.deepEqual(argvs(calls), [['docker', 'logs', CONTAINER]]);
  });

  it('follows the proxy when it serves another release than the record names', async () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp',
      production: { server: '1.2.3.4', domain: 'example.com' },
    });
    const { deps, calls } = makeDeps({
      config,
      host: { releases: [1, [2, 1]], state: stateOf(1), containers: [1, 2], serving: 2 },
    });
    assert.equal(await runJamalCommand(['app', 'logs'], deps), 0);
    assert.deepEqual(argvs(calls), [['docker', 'logs', webContainer(config, 2)]]);
  });

  for (const proxy of ['stopped', 'missing'] as const) {
    it(`reaches the release the record names while kamal-proxy is ${proxy}`, async () => {
      const config = routedConfig();
      const { deps, err, calls } = makeDeps({
        config,
        host: { releases: [1, [2, 1]], state: stateOf(2, 1), containers: [2], proxy },
      });
      assert.equal(await runJamalCommand(['app', 'logs'], deps), 0, err.join('\n'));
      assert.deepEqual(argvs(calls), [['docker', 'logs', webContainer(config, 2)]]);
    });
  }

  it('says kamal-proxy is down, not to deploy, when it is and nothing is recorded live', async () => {
    const { deps, err, calls } = makeDeps({
      config: routedConfig(),
      host: { releases: [1], proxy: 'stopped' },
    });
    assert.equal(await runJamalCommand(['app', 'logs'], deps), 1);
    assert.deepEqual(calls, []);
    assert.match(err.join('\n'), /kamal-proxy is not running on the server/);
    assert.match(err.join('\n'), /start kamal-proxy, then run "jamal deploy"/);
  });
});

describe('jamal app boot', serverVerb, () => {
  /** An answer whose state probe prints `state` (or fails when undefined). */
  function probing(state: 'true' | 'false' | undefined) {
    return (remoteArgv: readonly string[]): Partial<CommandResult> | undefined => {
      if (remoteArgv[1] !== 'inspect') return undefined;
      return state === undefined
        ? { exitCode: 1, stderr: 'No such object' }
        : { stdout: `${state}\n` };
    };
  }

  const probe = (container: string): string[] => [
    'docker',
    'inspect',
    '--type',
    'container',
    '--format',
    '{{.State.Running}}',
    container,
  ];

  it('starts a container that exists but is stopped', async () => {
    const container = CONTAINER;
    const { deps, err, out, calls } = makeDeps({ answer: probing('false') });

    const code = await runJamalCommand(['app', 'boot'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(argvs(calls), [probe(container), ['docker', 'start', container]]);
    assert.ok(!out.join('\n').includes('false'), 'the probe output is not forwarded');
  });

  it('is a no-op when the container is already running', async () => {
    const container = CONTAINER;
    const { deps, err, calls } = makeDeps({ answer: probing('true') });

    const code = await runJamalCommand(['app', 'boot'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(argvs(calls), [probe(container)]);
  });

  it('reports a missing container as not deployed instead of starting it', async () => {
    const { deps, err, calls } = makeDeps({ answer: probing(undefined) });

    const code = await runJamalCommand(['app', 'boot'], deps);

    assert.equal(code, 1);
    assert.equal(calls.length, 1);
    assert.match(err.join('\n'), /does not exist/);
  });

  it('--dry-run prints both commands and sends nothing but the reads', async () => {
    const container = CONTAINER;
    const { deps, out, calls } = makeDeps();

    const code = await runJamalCommand(['app', 'boot', '--dry-run'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    const output = out.join('\n');
    assert.ok(
      output.includes(
        `[dry-run] ssh 1.2.3.4 'docker inspect --type container --format '\\''{{.State.Running}}'\\'' ${container}'`,
      ),
    );
    assert.ok(output.includes(`[dry-run] ssh 1.2.3.4 'docker start ${container}'`));
  });
});

// ---------------------------------------------------------------------------
// start / stop / details
// ---------------------------------------------------------------------------

describe('jamal app start', serverVerb, () => {
  it('runs docker start over ssh for the live release container', async () => {
    const container = CONTAINER;
    const { deps, calls, err } = makeDeps();

    const code = await runJamalCommand(['app', 'start'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [
      { server: '1.2.3.4', remoteArgv: ['docker', 'start', container], fenced: false },
    ]);
  });
});

describe('jamal app stop', serverVerb, () => {
  it('runs docker stop over ssh for the live release container', async () => {
    const container = CONTAINER;
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['app', 'stop'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'stop', container]);
  });
});

describe('jamal app details', serverVerb, () => {
  it('inspects the live release container over ssh without its environment', async () => {
    const container = CONTAINER;
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['app', 'details'], deps);

    assert.equal(code, 0);
    const argv = calls[0]?.remoteArgv ?? [];
    assert.deepEqual(argv.slice(0, 5), ['docker', 'inspect', '--type', 'container', '--format']);
    assert.equal(argv.at(-1), container);
    assert.doesNotMatch(argv.join(' '), /Env/);
    assert.match(argv.join(' '), /\.State/);
  });
});

// ---------------------------------------------------------------------------
// containers
// ---------------------------------------------------------------------------

describe('jamal app containers', serverVerb, () => {
  it('runs docker ps -a filtered by the service name', async () => {
    const { deps, calls, err } = makeDeps();

    const code = await runJamalCommand(['app', 'containers'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [
      {
        server: '1.2.3.4',
        remoteArgv: ['docker', 'ps', '-a', '--filter', 'label=jsails.service=myapp'],
        fenced: false,
      },
    ]);
  });

  it('does not require a live release', async () => {
    const { deps, calls } = makeDeps({ host: {} });

    const code = await runJamalCommand(['app', 'containers'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.remoteArgv, [
      'docker',
      'ps',
      '-a',
      '--filter',
      'label=jsails.service=myapp',
    ]);
  });

  it('--dry-run prints the ssh argv', async () => {
    const { deps, out, calls } = makeDeps();

    const code = await runJamalCommand(['app', 'containers', '--dry-run'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.match(
      out.join('\n'),
      /\[dry-run\] ssh 1\.2\.3\.4 'docker ps -a --filter label=jsails\.service=myapp'/,
    );
  });
});

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

describe('jamal app logs', serverVerb, () => {
  it('runs docker logs over ssh for the live release container', async () => {
    const container = CONTAINER;
    const { deps, calls, err } = makeDeps({ answer: () => ({ stdout: 'log line\n' }) });

    const code = await runJamalCommand(['app', 'logs'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'logs', container]);
  });

  it('adds --follow with the flag', async () => {
    const container = CONTAINER;
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['app', 'logs', '--follow'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'logs', '--follow', container]);
  });
});

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

describe('jamal app exec', serverVerb, () => {
  it('runs docker exec over ssh with the command', async () => {
    const container = CONTAINER;
    const { deps, calls, err } = makeDeps();

    const code = await runJamalCommand(['app', 'exec', '--', 'ls', '-la'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [
      { server: '1.2.3.4', remoteArgv: ['docker', 'exec', container, 'ls', '-la'], fenced: false },
    ]);
  });

  it('requires -- before the command', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['app', 'exec', 'ls'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /requires "--"/);
  });

  it('requires a command after --', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['app', 'exec', '--'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /requires a command/);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('jamal app: error paths', serverVerb, () => {
  it('requires config.production', async () => {
    const { deps, err } = makeDeps({
      config: normalizeJamalConfig({
        service: 'myapp',
        image: 'ghcr.io/acme/myapp',
      }),
    });

    const code = await runJamalCommand(['app', 'start'], deps);

    assert.equal(code, 1);
    assert.match(err.join('\n'), /config\.production is required for `jamal app`/);
  });

  it('reports a server without a live release as a value-free error', async () => {
    const { deps, err, calls } = makeDeps({ host: {} });

    const code = await runJamalCommand(['app', 'start'], deps);

    assert.equal(code, 1);
    assert.equal(calls.length, 0);
    assert.match(err.join('\n'), /the server has no live release of the app/);
  });

  it('reports an unknown verb as a usage error', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['app', 'bogus'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /a verb is required/);
  });

  it('rejects an unknown flag as a usage error', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['app', 'start', '--bogus'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /Unknown option/);
  });

  it('rejects --follow on a non-logs verb', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['app', 'start', '--follow'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /--follow is only valid for `jamal app logs`/);
  });

  it('reports a non-zero remote exit code value-free', async () => {
    const { deps, out, err } = makeDeps({ answer: () => ({ exitCode: 7, stdout: 'info\n' }) });

    const code = await runJamalCommand(['app', 'start'], deps);

    assert.equal(code, 7);
    assert.match(out.join('\n'), /info/);
    assert.match(err.join('\n'), /app start exited with code 7/);
  });

  it('--dry-run sends nothing but the reads', async () => {
    const container = CONTAINER;
    const { deps, out, calls } = makeDeps();

    const code = await runJamalCommand(['app', 'start', '--dry-run'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.match(
      out.join('\n'),
      new RegExp(`\\[dry-run\\] ssh 1\\.2\\.3\\.4 'docker start ${container}'`),
    );
  });

  it('containers does not read the host state', async () => {
    const { deps, calls } = makeDeps({ host: {} });

    const code = await runJamalCommand(['app', 'containers'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.remoteArgv, [
      'docker',
      'ps',
      '-a',
      '--filter',
      'label=jsails.service=myapp',
    ]);
  });
});
