/**
 * Tests for deploy and rollback execution, their helpers, and the fetch-based
 * health check.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { normalizeJamalConfig, type JamalConfig } from '../src/config/index.js';
import { runJamalCommand, type JamalDeps } from '../src/command.js';
import {
  containerNameForTag,
  planProduction,
  type ProductionPlan,
} from '../src/production/plan.js';
import {
  DeployExecuteError,
  RollbackError,
  HealthCheckError,
  createFetchHealthCheck,
  defaultImageTag,
  deployLockDir,
  remoteExecArgv,
  remoteLogsArgv,
  remoteStatusArgv,
  runDeployExecution,
  runRollbackExecution,
  type DeployExecutionOptions,
} from '../src/production/execute.js';
import {
  DEPLOYS_HISTORY_PATH,
  DeployHistoryError,
  appendDeployEntry,
  deploysHistoryFile,
  emptyDeployHistory,
  readDeployHistory,
  writeDeployHistory,
  type DeployHistory,
  type DeployHistoryEntry,
} from '../src/production/history.js';
import type { ProcessRunner } from '../src/production/process-runner.js';
import { lockReleaseArgv } from '../src/production/lock.js';
import type { RemoteRunner } from '../src/production/transport.js';
import type { HealthCheck } from '../src/production/release.js';

/**
 * Tests for the jamal production deploy/rollback execution and inspection
 * verbs. Every seam (command runner, remote runner, health check, hooks
 * filesystem/runner, tag resolver, history store) is injected, so no docker,
 * ssh, git, or HTTP call happens except the one opt-in health-check test
 * against a loopback server. Assertions target lock ordering, hook ordering,
 * failure stop points, error classes, history persistence, and the CLI routing
 * (execute-by-default, `--dry-run` preview, and remote logs/exec).
 */

function config(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
    production: { server: '1.2.3.4', domain: 'example.com' },
  });
}

function entry(service: string, tag: string): DeployHistoryEntry {
  return { service, tag, timestamp: '2026-01-01T00:00:00.000Z' };
}

interface RecordedRemote {
  server: string;
  remoteArgv: string[];
}

function makeRemoteRunner(
  exitCode = 0,
  stdout = '',
): { remote: RemoteRunner; calls: RecordedRemote[] } {
  const calls: RecordedRemote[] = [];
  const remote: RemoteRunner = {
    async run(server, remoteArgv) {
      calls.push({ server, remoteArgv: [...remoteArgv] });
      return { exitCode, stdout, stderr: '' };
    },
  };
  return { remote, calls };
}

/** The deploy lock directory of the test service. */
const LOCK_DIR = '.jamal/locks/myapp.deploy.lock';

/** Whether a remote argv is one of the lock scripts (acquire, status, release). */
function isLockOperation(remoteArgv: readonly string[]): boolean {
  return remoteArgv[0] === 'sh' && remoteArgv[4] === LOCK_DIR;
}

/**
 * Assert that `release` is the token-checked release of the lock `acquire`
 * took: the same directory and the token the acquire wrote, never the
 * unconditional forced release.
 */
function assertOwnedRelease(
  release: readonly string[] | undefined,
  acquire: readonly string[] | undefined,
): void {
  assert.ok(release !== undefined && acquire !== undefined);
  assert.ok(isLockOperation(release));
  assert.notDeepEqual([...release], [...lockReleaseArgv(LOCK_DIR)]);
  assert.match(release[2] ?? '', /token/);
  assert.match(acquire[6] ?? '', /^[0-9a-f]{32}$/);
  assert.equal(release[5], acquire[6]);
}

/**
 * A remote runner whose lock operations (acquire/release scripts) succeed so the lock
 * is acquired and released, while every release step (a `docker` command) fails
 * with `failExitCode`. This surfaces the failure at the first remote release
 * step ("pull") rather than during lock acquisition, which the uniform
 * {@link makeRemoteRunner} cannot distinguish.
 */
function makeFailingRemoteRunner(failExitCode: number): {
  remote: RemoteRunner;
  calls: RecordedRemote[];
} {
  const calls: RecordedRemote[] = [];
  const remote: RemoteRunner = {
    async run(server, remoteArgv) {
      calls.push({ server, remoteArgv: [...remoteArgv] });
      const isNetwork = /docker network create/.test(remoteArgv[2] ?? '');
      const exitCode = isLockOperation(remoteArgv) || isNetwork ? 0 : failExitCode;
      return { exitCode, stdout: '', stderr: '' };
    },
  };
  return { remote, calls };
}

/**
 * `deploy`, `rollback`, and `status` reach the production server, so Windows
 * refuses them with `unsupported_platform` (`cli/platform-guard.ts`;
 * `core/test/cli/platform-guard.test.ts` proves the refusal): the tests of the
 * verbs run on POSIX only.
 */
const serverVerb = {
  skip: process.platform === 'win32' && 'a server-facing jamal verb, which Windows refuses',
};

const okProcessRunner: ProcessRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });
const okHealthCheck: HealthCheck = async () => {};

/** A build context holding a Dockerfile, for the execution-level deploy tests. */
const buildContext = mkdtempSync(join(tmpdir(), 'jamal-build-context-'));
writeFileSync(join(buildContext, 'Dockerfile'), 'FROM scratch\n');
after(() => {
  rmSync(buildContext, { recursive: true, force: true });
});

function executionOptions(overrides: Partial<DeployExecutionOptions> = {}): DeployExecutionOptions {
  return {
    config: config(),
    cwd: buildContext,
    imageTag: '2.0.0',
    commandRunner: okProcessRunner,
    remoteRunner: makeRemoteRunner().remote,
    healthCheck: okHealthCheck,
    lockOwner: 'tester@laptop since then',
    signals: new EventEmitter(),
    ...overrides,
  };
}

describe('execute: runDeployExecution', () => {
  it('locks, runs the release, records the entry, and unlocks', async () => {
    const remote = makeRemoteRunner();
    const result = await runDeployExecution(executionOptions({ remoteRunner: remote.remote }));

    assert.deepEqual(result.entry.service, 'myapp');
    assert.equal(result.entry.tag, '2.0.0');
    assert.equal(typeof result.entry.timestamp, 'string');

    const acquire = remote.calls[0]?.remoteArgv ?? [];
    assert.ok(isLockOperation(acquire));
    assert.match(acquire[2] ?? '', /mkdir -- "\$1"/);
    assert.equal(acquire[5], 'tester@laptop since then');
    assertOwnedRelease(remote.calls[remote.calls.length - 1]?.remoteArgv, acquire);
  });

  it('releases the lock and raises DeployExecuteError on a failed step', async () => {
    const remote = makeFailingRemoteRunner(9);

    await assert.rejects(
      () => runDeployExecution(executionOptions({ remoteRunner: remote.remote })),
      (error: unknown) =>
        error instanceof DeployExecuteError && /deploy failed at step "pull"/.test(error.message),
    );

    // The lock is released even on failure.
    assertOwnedRelease(
      remote.calls[remote.calls.length - 1]?.remoteArgv,
      remote.calls[0]?.remoteArgv,
    );
  });

  it('releases the lock when interrupted mid-deploy, then hands the signal on', async () => {
    const signals = new EventEmitter();
    const interrupted: string[] = [];
    let releaseSeen!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseSeen = resolve;
    });
    const calls: string[][] = [];
    const remote: RemoteRunner = {
      async run(_server, remoteArgv) {
        calls.push([...remoteArgv]);
        if (isLockOperation(remoteArgv) && /rmdir/.test(remoteArgv[2] ?? '')) releaseSeen();
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    let interruptBuild!: () => void;
    const deploy = runDeployExecution(
      executionOptions({
        remoteRunner: remote,
        signals,
        onInterrupted: (signal) => interrupted.push(signal),
        commandRunner: async () => {
          interruptBuild();
          return new Promise<never>(() => {});
        },
      }),
    );
    await new Promise<void>((resolve) => {
      interruptBuild = resolve;
    });
    signals.emit('SIGINT');
    await released;
    await new Promise((resolve) => setImmediate(resolve));

    assertOwnedRelease(calls.at(-1), calls[0]);
    assert.deepEqual(interrupted, ['SIGINT']);
    assert.equal(signals.listenerCount('SIGTERM'), 0, 'the handlers are detached');
    void deploy;
  });

  it('detaches its signal handlers once the deploy ends', async () => {
    const signals = new EventEmitter();
    await runDeployExecution(executionOptions({ signals }));
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  });

  it('rejects a config without a production section before locking', async () => {
    const remote = makeRemoteRunner();
    await assert.rejects(
      () =>
        runDeployExecution(
          executionOptions({
            remoteRunner: remote.remote,
            config: normalizeJamalConfig({ service: 'myapp', image: 'ghcr.io/acme/myapp' }),
          }),
        ),
      (error: unknown) => error instanceof DeployExecuteError && /production/.test(error.message),
    );
    assert.equal(remote.calls.length, 0, 'no lock may be taken without a production config');
  });
});

describe('execute: runRollbackExecution', () => {
  it('raises RollbackError naming the failed step kind', async () => {
    await assert.rejects(
      () =>
        runRollbackExecution(executionOptions({ remoteRunner: makeFailingRemoteRunner(3).remote })),
      (error: unknown) =>
        error instanceof RollbackError && /rollback failed at step "pull"/.test(error.message),
    );
  });

  it('plans the target as the new image and the current as the previous', async () => {
    const remote = makeRemoteRunner();
    const result = await runRollbackExecution(
      executionOptions({ imageTag: '1.0.0', previousTag: '2.0.0', remoteRunner: remote.remote }),
    );

    assert.equal(result.entry.tag, '1.0.0');
    const stopCall = remote.calls.find(
      (call) => call.remoteArgv[0] === 'sh' && /docker stop/.test(call.remoteArgv[2] ?? ''),
    );
    assert.equal(
      stopCall?.remoteArgv.at(-1),
      containerNameForTag('myapp', '2.0.0'),
      'the current container is the one stopped',
    );
  });
});

describe('execute: helpers', () => {
  it('deployLockDir names the service', () => {
    assert.equal(deployLockDir('myapp'), LOCK_DIR);
  });

  it('remote argv builders assemble the fixed docker commands', () => {
    assert.deepEqual(remoteStatusArgv(), ['docker', 'ps']);
    assert.deepEqual(remoteLogsArgv('myapp-web-abc', { follow: false }), [
      'docker',
      'logs',
      'myapp-web-abc',
    ]);
    assert.deepEqual(remoteLogsArgv('myapp-web-abc', { follow: true }), [
      'docker',
      'logs',
      '--follow',
      'myapp-web-abc',
    ]);
    assert.deepEqual(remoteExecArgv('myapp-web-abc', ['sh', '-c', 'echo hi']), [
      'docker',
      'exec',
      'myapp-web-abc',
      'sh',
      '-c',
      'echo hi',
    ]);
  });

  it('remote argv builders reject an unsafe container name value-free', () => {
    for (const bad of ['', 'has space', 'leads\nnewline', '-opt']) {
      assert.throws(
        () => remoteLogsArgv(bad, { follow: false }),
        (error: unknown) => {
          assert.ok(error instanceof DeployExecuteError);
          assert.ok(!JSON.stringify(bad).includes(error.message));
          return true;
        },
      );
    }
  });

  it('defaultImageTag falls back to a timestamp outside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamal-tag-'));
    try {
      const tag = await defaultImageTag(dir);
      assert.match(tag, /^\d{14}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('execute: createFetchHealthCheck', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/up') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      } else {
        res.writeHead(500);
        res.end('down');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('resolves once the health URL returns ok', async () => {
    await createFetchHealthCheck()(`${baseUrl}/up`, { timeoutMs: 1000, intervalMs: 5 });
  });

  it('makes one bounded attempt and throws on an unhealthy response instead of polling', async () => {
    const started = Date.now();
    await assert.rejects(
      () => createFetchHealthCheck()(`${baseUrl}/down`, { timeoutMs: 1000, intervalMs: 5 }),
      (error: unknown) => error instanceof HealthCheckError && error.code === 'unhealthy',
    );
    assert.ok(Date.now() - started < 1000, 'returns after the first response');
  });
});

describe('history', () => {
  it('round-trips entries through write and read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamal-history-'));
    try {
      const history: DeployHistory = {
        version: 1,
        entries: [entry('myapp', '1.0.0'), entry('myapp', '2.0.0')],
      };
      await writeDeployHistory(dir, history);
      assert.deepEqual(await readDeployHistory(dir), history);
      assert.equal(DEPLOYS_HISTORY_PATH, '.jamal/deploys.json');
      assert.equal(deploysHistoryFile(dir), join(dir, '.jamal', 'deploys.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves an empty history when the file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamal-history-'));
    try {
      assert.deepEqual(await readDeployHistory(dir), emptyDeployHistory());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends entries oldest-first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamal-history-'));
    try {
      await appendDeployEntry(dir, entry('myapp', '1.0.0'));
      await appendDeployEntry(dir, entry('myapp', '2.0.0'));
      const history = await readDeployHistory(dir);
      assert.deepEqual(
        history.entries.map((value) => value.tag),
        ['1.0.0', '2.0.0'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a recorded container and reads entries written without one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamal-history-'));
    try {
      const history: DeployHistory = {
        version: 1,
        entries: [
          entry('myapp', '1.0.0'),
          { ...entry('myapp', '1.0.0'), container: 'myapp-web-1.0.0-r' },
        ],
      };
      await writeDeployHistory(dir, history);
      const read = await readDeployHistory(dir);
      assert.deepEqual(read, history);
      assert.equal(Object.hasOwn(read.entries[0] ?? {}, 'container'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed and unsupported history value-free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamal-history-'));
    const file = deploysHistoryFile(dir);
    try {
      mkdirSync(join(dir, '.jamal'), { recursive: true });
      for (const bad of [
        'not json',
        '{"version":2,"entries":[]}',
        '{"version":1,"entries":[{"x":1}]}',
        '{"version":1,"entries":[{"service":"a","tag":"b","timestamp":"c","container":"x y"}]}',
      ]) {
        writeFileSync(file, bad, 'utf8');
        await assert.rejects(
          () => readDeployHistory(dir),
          (error: unknown) => error instanceof DeployHistoryError,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CLI routing
// ---------------------------------------------------------------------------

interface Sinks {
  out: string[];
  err: string[];
}

function sinks(): Sinks {
  return { out: [], err: [] };
}

/** Build deps for the execute/inspect verbs; every seam is injected (no spawn). */
function deps(cwd: string, s: Sinks, overrides: Partial<JamalDeps> = {}): JamalDeps {
  return {
    cwd,
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
    loadJamalConfig: async () => config(),
    readHistory: async () => emptyDeployHistory(),
    appendHistory: async (_dir, value) => ({ version: 1, entries: [value] }),
    resolveTag: async () => 'abcdef1',
    processRunner: okProcessRunner,
    remoteRunner: makeRemoteRunner().remote,
    healthCheck: okHealthCheck,
    ...overrides,
  };
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'jamal-exec-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

/** A project directory under the fixtures root that holds a Dockerfile, as a deploy needs. */
function projectWithDockerfile(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
  return dir;
}

describe('jamal deploy: flag scoping', () => {
  it('scopes --tag and --dry-run to deploy/rollback', async () => {
    const s = sinks();
    const d = deps(join(fixturesRoot, 'scope'), s);
    assert.equal(await runJamalCommand(['up', '--tag', 'x'], d), 2);
    assert.match(s.err.join('\n'), /--tag is only valid/);
    assert.equal(await runJamalCommand(['up', '--dry-run'], d), 2);
    assert.match(s.err.join('\n'), /--dry-run is only valid/);
  });
});

describe('jamal deploy (kamal engine)', serverVerb, () => {
  it('executes by default and records the tag in history', async () => {
    const dir = projectWithDockerfile('deploy-ok');
    const s = sinks();
    const remote = makeRemoteRunner();
    const appended: DeployHistoryEntry[] = [];
    const d = deps(dir, s, {
      remoteRunner: remote.remote,
      appendHistory: async (_dir, value) => {
        appended.push(value);
        return { version: 1, entries: [value] };
      },
    });

    const code = await runJamalCommand(['deploy'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.service, 'myapp');
    assert.equal(appended[0]?.tag, 'abcdef1');
    assert.equal(appended[0]?.container, 'myapp-web-abcdef1');
    assert.match(s.out.join('\n'), /deployed ghcr\.io\/acme\/myapp:abcdef1/);
    const acquire = remote.calls[0]?.remoteArgv ?? [];
    assert.ok(isLockOperation(acquire));
    assert.match(acquire[2] ?? '', /mkdir -- "\$1"/);
    assert.match(acquire[5] ?? '', /^\S+@\S+ since \d{4}-\d\d-\d\dT/);
    assertOwnedRelease(remote.calls[remote.calls.length - 1]?.remoteArgv, acquire);
  });

  it('uses --tag when given', async () => {
    const s = sinks();
    const appended: DeployHistoryEntry[] = [];
    const d = deps(projectWithDockerfile('deploy-tag'), s, {
      appendHistory: async (_dir, value) => {
        appended.push(value);
        return { version: 1, entries: [value] };
      },
    });

    const code = await runJamalCommand(['deploy', '--tag', 'release-42'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(appended[0]?.tag, 'release-42');
  });

  it('--dry-run prints the engine plan and executes nothing', async () => {
    const s = sinks();
    const remote = makeRemoteRunner();
    const d = deps(join(fixturesRoot, 'deploy-dry-run'), s, { remoteRunner: remote.remote });

    const code = await runJamalCommand(['deploy', '--dry-run'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(remote.calls.length, 0, '--dry-run must not touch the remote server');
    const out = s.out.join('\n');
    assert.match(out, /image: ghcr\.io\/acme\/myapp:abcdef1/);
    for (const kind of ['build', 'push', 'pull', 'run', 'health', 'switch', 'stop']) {
      assert.match(out, new RegExp(`^${kind}:`, 'm'), `expected a "${kind}" step`);
    }
    assert.ok(!/deployed /.test(out), '--dry-run must not print the deploy summary');
  });

  it('reports a value-free failure and does not record history on a failed release', async () => {
    const s = sinks();
    let appended = 0;
    const d = deps(projectWithDockerfile('deploy-fail'), s, {
      remoteRunner: makeFailingRemoteRunner(5).remote,
      appendHistory: async (_dir, value) => {
        appended += 1;
        return { version: 1, entries: [value] };
      },
    });

    const code = await runJamalCommand(['deploy'], d);

    assert.equal(code, 1);
    assert.equal(appended, 0, 'no history entry is recorded after a failed release');
    assert.match(s.err.join('\n'), /deploy failed at step/);
    assert.ok(!s.err.join('\n').includes('ghcr.io'), 'image reference must not leak');
  });

  it('refuses a project without a Dockerfile before any remote or local command', async () => {
    const s = sinks();
    const remote = makeRemoteRunner();
    let localCommands = 0;
    const dir = join(fixturesRoot, 'deploy-no-dockerfile');
    mkdirSync(dir, { recursive: true });
    const d = deps(dir, s, {
      remoteRunner: remote.remote,
      processRunner: async () => {
        localCommands += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const code = await runJamalCommand(['deploy'], d);

    assert.equal(code, 1);
    assert.equal(remote.calls.length, 0, 'the server must not be touched, not even the lock');
    assert.equal(localCommands, 0, 'docker must not run');
    const err = s.err.join('\n');
    assert.match(err, /no Dockerfile was found in the project root/);
    assert.ok(!err.includes(dir), 'the project path must not leak');
  });
});

describe('jamal deploy: redeploying the live tag', serverVerb, () => {
  it('runs in the alternate container, records it, and retires the live one last', async () => {
    const s = sinks();
    const remote = makeRemoteRunner();
    const appended: DeployHistoryEntry[] = [];
    const d = deps(projectWithDockerfile('deploy-same-tag'), s, {
      readHistory: async () => ({ version: 1, entries: [entry('myapp', 'abcdef1')] }),
      remoteRunner: remote.remote,
      appendHistory: async (_dir, value) => {
        appended.push(value);
        return { version: 1, entries: [value] };
      },
    });

    const code = await runJamalCommand(['deploy'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(appended[0]?.container, 'myapp-web-abcdef1-r');
    const named = remote.calls.filter((call) => call.remoteArgv.includes('myapp-web-abcdef1'));
    assert.equal(named.length, 1, 'only the stop step names the live container');
    assert.match(named[0]?.remoteArgv[2] ?? '', /docker stop/);
  });
});

describe('jamal rollback', serverVerb, () => {
  it('executes by default without --execute', async () => {
    const dir = join(fixturesRoot, 'rb-default');
    const s = sinks();
    const remote = makeRemoteRunner();
    const appended: DeployHistoryEntry[] = [];
    const history: DeployHistory = {
      version: 1,
      entries: [entry('myapp', '1.0.0'), entry('myapp', '2.0.0')],
    };
    const d = deps(dir, s, {
      readHistory: async () => history,
      remoteRunner: remote.remote,
      appendHistory: async (_dir, value) => {
        appended.push(value);
        return { version: 1, entries: [...history.entries, value] };
      },
    });

    const code = await runJamalCommand(['rollback'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(appended[0]?.tag, '1.0.0');
    assert.match(s.out.join('\n'), /rolled back to ghcr\.io\/acme\/myapp:1\.0\.0/);
    const stopCall = remote.calls.find(
      (call) => call.remoteArgv[0] === 'sh' && /docker stop/.test(call.remoteArgv[2] ?? ''),
    );
    assert.equal(stopCall?.remoteArgv.at(-1), containerNameForTag('myapp', '2.0.0'));
  });

  it('--dry-run prints the rollback plan and executes nothing', async () => {
    const s = sinks();
    const remote = makeRemoteRunner();
    const d = deps(join(fixturesRoot, 'rb-dry-run'), s, {
      readHistory: async () => ({
        version: 1,
        entries: [entry('myapp', '1.0.0'), entry('myapp', '2.0.0')],
      }),
      remoteRunner: remote.remote,
    });

    const code = await runJamalCommand(['rollback', '--dry-run'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(remote.calls.length, 0, '--dry-run must not touch the remote server');
    const out = s.out.join('\n');
    assert.match(out, /image: ghcr\.io\/acme\/myapp:1\.0\.0/);
    assert.match(out, /^rollback:/m);
    assert.ok(!/rolled back/.test(out), '--dry-run must not print the rollback summary');
  });

  it('reports no history and no previous deploy value-free', async () => {
    const s = sinks();
    const empty = deps(join(fixturesRoot, 'rb-empty'), s, {
      readHistory: async () => emptyDeployHistory(),
    });
    assert.equal(await runJamalCommand(['rollback'], empty), 1);
    assert.match(s.err.join('\n'), /no deploy history/);

    const single = deps(join(fixturesRoot, 'rb-single'), s, {
      readHistory: async () => ({ version: 1, entries: [entry('myapp', '1.0.0')] }),
    });
    assert.equal(await runJamalCommand(['rollback'], single), 1);
    assert.match(s.err.join('\n'), /no previous deploy/);
  });
});

describe('jamal status', serverVerb, () => {
  it('requires a production config', async () => {
    const s = sinks();
    const d = deps(join(fixturesRoot, 'status-no-prod'), s, {
      loadJamalConfig: async () =>
        normalizeJamalConfig({ service: 'myapp', image: 'ghcr.io/acme/myapp' }),
    });
    assert.equal(await runJamalCommand(['status'], d), 1);
    assert.match(s.err.join('\n'), /config\.production is required/);
  });

  it('lists containers on the remote server', async () => {
    const s = sinks();
    const remote = makeRemoteRunner(0, 'CONTAINER ID   NAMES\n');
    const d = deps(join(fixturesRoot, 'status-ok'), s, { remoteRunner: remote.remote });
    const code = await runJamalCommand(['status'], d);
    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(remote.calls[0], { server: '1.2.3.4', remoteArgv: ['docker', 'ps'] });
    assert.match(s.out.join('\n'), /CONTAINER ID/);
  });
});

describe('jamal logs/exec stay local', () => {
  /** A project with a managed Compose file, deps whose config has a production section. */
  function localProject(name: string) {
    const dir = join(fixturesRoot, name);
    mkdirSync(join(dir, '.jamal'), { recursive: true });
    writeFileSync(join(dir, '.jamal', 'compose.yml'), 'services: {}\n');
    const s = sinks();
    const remote = makeRemoteRunner();
    const calls: (readonly string[])[] = [];
    const d = deps(dir, s, {
      readHistory: async () => ({ version: 1, entries: [entry('myapp', '2.0.0')] }),
      remoteRunner: remote.remote,
      runCommand: async (argv) => {
        calls.push(argv);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    assert.ok(config().production !== undefined, 'the fixture config deploys to a server');
    return { s, d, calls, remote };
  }

  it('reads local logs even when the config has a production section', async () => {
    const { s, d, calls, remote } = localProject('logs-local-with-prod');
    assert.equal(await runJamalCommand(['logs', '--follow', 'db'], d), 0, s.err.join('\n'));
    assert.equal(remote.calls.length, 0, 'logs must never reach the server');
    assert.deepEqual(calls[0], [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'logs',
      '--follow',
      'db',
    ]);
  });

  it('runs exec in a local service even when the config has a production section', async () => {
    const { s, d, calls, remote } = localProject('exec-local-with-prod');
    const code = await runJamalCommand(['exec', 'app', '--', 'sh', '-c', 'echo hi'], d);
    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(remote.calls.length, 0, 'exec must never reach the server');
    assert.deepEqual(calls[0]?.slice(-5), ['exec', 'app', 'sh', '-c', 'echo hi']);
  });

  it('never reroutes a server-style exec to the server', async () => {
    const { d, calls, remote } = localProject('exec-server-style');
    // Without a service name the first command word is read as one; Compose
    // then reports the unknown service. Nothing reaches the server.
    await runJamalCommand(['exec', '--', 'sh', '-c', 'echo hi'], d);
    assert.equal(remote.calls.length, 0);
    assert.deepEqual(calls[0]?.slice(-4), ['exec', 'sh', '-c', 'echo hi']);
  });

  it('falls back to local logs when no production config is present', async () => {
    const dir = join(fixturesRoot, 'logs-local');
    mkdirSync(join(dir, '.jamal'), { recursive: true });
    writeFileSync(join(dir, '.jamal', 'compose.yml'), 'services: {}\n');
    const s = sinks();
    const runCommandCalls: { argv: readonly string[] }[] = [];
    const d = deps(dir, s, {
      loadJamalConfig: async () =>
        normalizeJamalConfig({ service: 'myapp', image: 'ghcr.io/acme/myapp' }),
      runCommand: async (argv) => {
        runCommandCalls.push({ argv });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const code = await runJamalCommand(['logs'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.ok(runCommandCalls.length > 0, 'local logs must reach docker compose');
    assert.deepEqual(runCommandCalls[0]?.argv.slice(0, 2), ['docker', 'compose']);
  });
});

describe('planProduction integration', () => {
  it('containerNameForTag matches the plan container for a roll-forward', () => {
    const plan: ProductionPlan = planProduction(config(), {
      imageTag: '2.0.0',
      previousTag: '1.0.0',
    });
    assert.equal(plan.containerName, containerNameForTag('myapp', '2.0.0'));
  });
});
