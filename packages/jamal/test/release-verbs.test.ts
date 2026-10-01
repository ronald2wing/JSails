/**
 * Tests for deploy and rollback execution and their verbs, their helpers, the
 * fetch-based health check, and the server as the only deploy record.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeJamalConfig, type JamalConfig } from '../src/config/index.js';
import { runJamalCommand, type JamalDeps } from '../src/command.js';
import { resolveJamalEnv } from '../src/env-resolve.js';
import {
  DeployExecuteError,
  RollbackError,
  HealthCheckError,
  createFetchHealthCheck,
  deployLockDir,
  remoteExecArgv,
  remoteLogsArgv,
  remoteStatusArgv,
  runDeployExecution,
  runRollbackExecution,
  type DeployExecutionOptions,
} from '../src/production/execute.js';
import { HostHomeErrors } from '../src/production/host-home.js';
import { parseHostState } from '../src/production/host-state.js';
import { hostManifestFile, hostStateFile } from '../src/production/host-layout.js';
import { PlanErrors } from '../src/production/plan.js';
import type { CommandResult, ProcessRunner } from '../src/production/process-runner.js';
import { decodeRemoteOp, remoteOpArgv } from '../src/production/remote-op.js';
import type { RemoteRunner } from '../src/production/transport.js';
import { isMutatingOp } from '../src/testing/fake-host.js';
import {
  createWorld,
  IMAGE,
  lockHeld,
  SERVICE,
  serverVerbs,
  signalSource,
  type Checkout,
  type World,
} from './scenarios/world.js';

/**
 * The deploy and rollback paths run against a modelled host and a modelled
 * local Docker (`scenarios/world.ts`): a git checkout per machine, a host
 * that answers every remote command the engine sends, and a registry
 * between them. So the assertions target what the host holds afterwards (its
 * state record, its manifests, its lock) and the commands it saw, not an argv
 * the test predicted.
 */

function config(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
    production: { server: '1.2.3.4', domain: 'example.com' },
  });
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

const okProcessRunner: ProcessRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });

/** The world of the test running now, closed after it. */
let world: World | undefined;

afterEach(() => {
  world?.close();
  world = undefined;
});

/** A new world for this test, with one checkout `a`. */
async function freshWorld(): Promise<{ world: World; a: Checkout }> {
  world = await createWorld();
  return { world, a: world.checkout('a') };
}

/** A clock after the world's own, one second per reading. */
function clock(): () => Date {
  let at = Date.parse('2026-12-01T10:00:00.000Z');
  return () => new Date((at += 1000));
}

/** The engine's options for a release from `checkout`. */
function executionOptions(
  w: World,
  checkout: Checkout,
  overrides: Partial<DeployExecutionOptions> = {},
): DeployExecutionOptions {
  return {
    config: w.config,
    commandRunner: checkout.docker.runner,
    remoteRunner: checkout.client,
    cwd: checkout.dir,
    env: resolveJamalEnv(w.config, { values: { ...w.secrets }, files: [] }),
    logger: { info: () => {}, warn: () => {} },
    now: clock(),
    lockOwner: { who: checkout.name, host: 'test', since: '2026-12-01T10:00:00.000Z' },
    signals: signalSource(),
    ...overrides,
  };
}

/** The deps `jamal` runs with in `checkout`, its output collected. */
function cli(
  w: World,
  checkout: Checkout,
  overrides: Partial<JamalDeps> = {},
): { deps: JamalDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: JamalDeps = {
    cwd: checkout.dir,
    platform: 'linux',
    loadJamalConfig: async () => w.config,
    loadSecrets: () => ({ values: Object.freeze({ ...w.secrets }), files: [] }),
    now: clock(),
    processRunner: checkout.docker.runner,
    remoteRunner: checkout.client,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...overrides,
  };
  return { deps, out, err };
}

/** The ops the host saw from `from` on, by kind. */
function opKinds(w: World, from = 0): string[] {
  return w.host.log.slice(from).map((command) => command.op?.kind ?? 'unmodelled');
}

/** The host's state record of the app. */
function hostState(w: World) {
  const file = w.host.fs.file(hostStateFile(SERVICE, undefined));
  assert.ok(file !== undefined, 'the host records a state');
  return parseHostState(file.data);
}

/** The manifest the host holds for `release`, parsed. */
function manifest(w: World, release: string): Record<string, unknown> {
  const file = w.host.fs.file(hostManifestFile(SERVICE, undefined, release));
  assert.ok(file !== undefined, 'the host holds the release manifest');
  return JSON.parse(file.data.toString('utf8')) as Record<string, unknown>;
}

/** A process runner that counts the local commands `runner` runs. */
function counting(runner: ProcessRunner): { runner: ProcessRunner; count: () => number } {
  let count = 0;
  return {
    runner: async (argv, options) => {
      count += 1;
      return runner(argv, options);
    },
    count: () => count,
  };
}

describe('execute: runDeployExecution', serverVerbs, () => {
  it('builds, then locks, observes, releases, and unlocks, the image pinned by digest', async () => {
    const { world: w, a } = await freshWorld();
    const from = w.host.log.length;
    const { plan } = await runDeployExecution(executionOptions(w, a));

    assert.match(plan.releaseId, /^\d{14}-[0-9a-f]{12}$/);
    assert.ok(plan.releaseId.slice(15).startsWith(a.head()), 'the release id names the commit');
    assert.equal(plan.imageRef, `${IMAGE}@${a.builtDigest()}`);
    const kinds = opKinds(w, from);
    assert.deepEqual(kinds.slice(0, 3), ['lock.acquire', 'host.home', 'host.read-state']);
    assert.equal(kinds.at(-1), 'lock.release');
    for (const command of w.host.log.slice(from)) {
      const op = command.op;
      if (op?.kind.startsWith('lock.') === true) continue;
      // A write that checks the lock's token itself is sent unwrapped.
      if (op?.kind === 'file.write' && op.lockDir === deployLockDir(SERVICE, undefined)) continue;
      assert.ok(command.fenced, `${op?.kind ?? 'unmodelled'} runs fenced by the lock`);
    }
    assert.equal(lockHeld(w), false);
    const state = hostState(w);
    assert.equal(state.live, plan.releaseId);
    assert.equal(state.previous, null);
    assert.equal(manifest(w, plan.releaseId).image, plan.imageRef);
  });

  it('releases the lock and raises DeployExecuteError naming the failed step, value-free', async () => {
    const { world: w, a } = await freshWorld();
    a.commit('break the health check', { UNHEALTHY: '' });
    await assert.rejects(
      () => runDeployExecution(executionOptions(w, a)),
      (error: unknown) =>
        error instanceof DeployExecuteError &&
        /^deploy failed at step "health"/.test(error.message) &&
        !error.message.includes(IMAGE),
    );
    assert.equal(lockHeld(w), false);
    assert.equal(w.host.fs.file(hostStateFile(SERVICE, undefined)), undefined);
  });

  it('releases the lock when interrupted under it, then hands the signal on', async () => {
    const { world: w, a } = await freshWorld();
    const signals = signalSource();
    const interrupted: string[] = [];
    let fired = false;
    const stop = w.host.onCommand((event) => {
      if (!fired && event.op?.kind === 'host.read-state') {
        fired = true;
        assert.ok(signals.fire('SIGINT'), 'the deploy handles the interrupt');
      }
    });
    const settled = await runDeployExecution(
      executionOptions(w, a, { signals, onInterrupted: (signal) => interrupted.push(signal) }),
    ).then(
      () => 'finished',
      () => 'failed',
    );
    stop();
    assert.equal(settled, 'failed', 'a deploy whose lock was released stops');
    assert.deepEqual(interrupted, ['SIGINT']);
    assert.equal(lockHeld(w), false);
    assert.equal(w.host.fs.file(hostStateFile(SERVICE, undefined)), undefined);
  });

  it('stops before any step when the server home cannot be mounted from, releasing the lock', async () => {
    world = await createWorld({ sshUser: { name: 'deploy', home: '/home/odd:name' } });
    const a = world.checkout('a');
    const from = world.host.log.length;
    await assert.rejects(
      () => runDeployExecution(executionOptions(world!, a)),
      (error: unknown) =>
        HostHomeErrors.is(error, 'unusable_home') && !error.message.includes('odd'),
    );
    assert.deepEqual(opKinds(world, from), ['lock.acquire', 'host.home', 'lock.release']);
  });

  it('detaches its signal handlers once the deploy ends', async () => {
    const { world: w, a } = await freshWorld();
    const listeners: string[] = [];
    const signals = {
      once: (signal: string) => listeners.push(`+${signal}`),
      removeListener: (signal: string) => listeners.push(`-${signal}`),
    };
    await runDeployExecution(executionOptions(w, a, { signals }));
    assert.deepEqual(listeners.filter((entry) => entry.startsWith('+')).length, 2);
    assert.deepEqual(listeners.filter((entry) => entry.startsWith('-')).length, 2);
  });

  it('rejects a config without a production section before building or locking', async () => {
    const { world: w, a } = await freshWorld();
    const local = counting(a.docker.runner);
    const from = w.host.log.length;
    await assert.rejects(
      () =>
        runDeployExecution(
          executionOptions(w, a, {
            commandRunner: local.runner,
            config: normalizeJamalConfig({ service: SERVICE, image: IMAGE }),
          }),
        ),
      (error: unknown) => error instanceof DeployExecuteError && /production/.test(error.message),
    );
    assert.equal(w.host.log.length, from, 'no lock may be taken without a production config');
    assert.equal(local.count(), 0);
  });

  it('refuses a dirty tree before building, and records one deployed with allowDirty as dirty', async () => {
    const { world: w, a } = await freshWorld();
    a.edit({ 'app.js': 'export const version = 2;\n' });
    const local = counting(a.docker.runner);
    const from = w.host.log.length;
    await assert.rejects(() =>
      runDeployExecution(executionOptions(w, a, { commandRunner: local.runner })),
    );
    assert.equal(local.count(), 0, 'a dirty tree builds nothing');
    assert.equal(w.host.log.length, from, 'a dirty tree reaches no server');

    const { plan } = await runDeployExecution(executionOptions(w, a, { allowDirty: true }));
    assert.deepEqual((manifest(w, plan.releaseId).git as { dirty: boolean }).dirty, true);
  });
});

describe('execute: runRollbackExecution', serverVerbs, () => {
  it('returns to the previous release the host records, by its digest', async () => {
    const { world: w, a } = await freshWorld();
    const first = await runDeployExecution(executionOptions(w, a));
    a.commit('second', { 'app.js': 'export const version = 2;\n' });
    const second = await runDeployExecution(executionOptions(w, a));

    const { plan } = await runRollbackExecution(executionOptions(w, a));

    assert.equal(plan.kind, 'rollback');
    assert.equal(plan.releaseId, first.plan.releaseId);
    assert.equal(plan.imageRef, first.plan.imageRef);
    const state = hostState(w);
    assert.equal(state.live, first.plan.releaseId);
    assert.equal(state.previous, second.plan.releaseId);
    assert.equal(lockHeld(w), false);
  });

  it('refuses with no previous release, value-free, releasing the lock', async () => {
    const { world: w, a } = await freshWorld();
    await runDeployExecution(executionOptions(w, a));
    await assert.rejects(
      () => runRollbackExecution(executionOptions(w, a)),
      (error: unknown) => PlanErrors.is(error, 'no_previous'),
    );
    assert.equal(lockHeld(w), false);
  });

  it('raises RollbackError naming the failed step', async () => {
    const { world: w, a } = await freshWorld();
    await runDeployExecution(executionOptions(w, a));
    a.commit('second', { 'app.js': 'export const version = 2;\n' });
    await runDeployExecution(executionOptions(w, a));
    // A registry outage: every pull fails, whatever the lock fences.
    const remote: RemoteRunner = {
      run(server, remoteArgv, options) {
        const decoded = decodeRemoteOp(remoteArgv);
        const op = decoded?.kind === 'fenced' ? decoded.op : decoded;
        if (op?.kind === 'docker' && remoteOpArgv(op)[1] === 'pull') {
          return Promise.resolve<CommandResult>({ exitCode: 1, stdout: '', stderr: 'denied' });
        }
        return a.client.run(server, remoteArgv, options);
      },
    };
    await assert.rejects(
      () => runRollbackExecution(executionOptions(w, a, { remoteRunner: remote })),
      (error: unknown) =>
        error instanceof RollbackError && /^rollback failed at step "pull"/.test(error.message),
    );
  });
});

describe('execute: helpers', () => {
  it('deployLockDir names the app, and its destination', () => {
    assert.equal(deployLockDir('myapp', undefined), '.jamal/apps/myapp/lock');
    assert.equal(deployLockDir('myapp', 'staging'), '.jamal/apps/myapp.staging/lock');
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

interface Sinks {
  out: string[];
  err: string[];
}

function sinks(): Sinks {
  return { out: [], err: [] };
}

/** Build deps for the verbs that never reach a modelled host; every seam is injected. */
function deps(cwd: string, s: Sinks, overrides: Partial<JamalDeps> = {}): JamalDeps {
  return {
    cwd,
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
    loadJamalConfig: async () => config(),
    processRunner: okProcessRunner,
    remoteRunner: makeRemoteRunner().remote,
    ...overrides,
  };
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'jamal-exec-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

describe('jamal deploy: flag scoping', () => {
  it('scopes --dry-run to deploy/rollback and --allow-dirty to deploy', async () => {
    const s = sinks();
    const d = deps(join(fixturesRoot, 'scope'), s);
    assert.equal(await runJamalCommand(['up', '--dry-run'], d), 2);
    assert.match(s.err.join('\n'), /--dry-run is only valid/);
    assert.equal(await runJamalCommand(['rollback', '--allow-dirty'], d), 2);
    assert.match(s.err.join('\n'), /--allow-dirty is only valid for `jamal deploy`/);
    assert.equal(await runJamalCommand(['deploy', '--tag', 'x'], d), 2);
    assert.match(s.err.join('\n'), /Unknown option/);
  });

  it('reports a misplaced flag as a usage error on Windows too, before refusing the verb', async () => {
    const s = sinks();
    const d = deps(join(fixturesRoot, 'scope-win32'), s, { platform: 'win32' });
    assert.equal(await runJamalCommand(['rollback', '--allow-dirty'], d), 2);
    assert.match(s.err.join('\n'), /--allow-dirty is only valid for `jamal deploy`/);
    assert.doesNotMatch(s.err.join('\n'), /does not run on Windows/);
    assert.equal(await runJamalCommand(['rollback'], d), 1);
    assert.match(s.err.join('\n'), /does not run on Windows/);
  });
});

describe('jamal deploy', serverVerbs, () => {
  it('executes by default and prints the release id and the pinned image', async () => {
    const { world: w, a } = await freshWorld();
    const { deps: d, out, err } = cli(w, a);

    assert.equal(await runJamalCommand(['deploy'], d), 0, err.join('\n'));

    const live = hostState(w).live;
    assert.ok(live !== null);
    assert.ok(
      out.includes(`deployed ${live} (${IMAGE}@${a.builtDigest()})`),
      'the summary names the release and its digest',
    );
  });

  it('--dry-run reads the host, builds and changes nothing, and prints the plan', async () => {
    const { world: w, a } = await freshWorld();
    const local = counting(a.docker.runner);
    const { deps: d, out, err } = cli(w, a, { processRunner: local.runner });
    const from = w.host.log.length;

    assert.equal(await runJamalCommand(['deploy', '--dry-run'], d), 0, err.join('\n'));

    assert.equal(local.count(), 0, 'a preview builds nothing');
    for (const command of w.host.log.slice(from)) {
      assert.ok(
        command.op !== undefined && !isMutatingOp(command.op),
        command.op?.kind ?? 'unmodelled',
      );
    }
    const text = out.join('\n');
    assert.match(text, /^image: ghcr\.io\/acme\/myapp@<digest>$/m);
    assert.match(text, /^live now: none$/m);
    // The preview reads the home from the server, so it mounts from it.
    assert.match(text, /\/home\/deploy\/\.jamal\/apps\/myapp\/releases\//);
    for (const kind of ['pull', 'secrets-file', 'manifest', 'run', 'health', 'switch', 'state']) {
      assert.match(text, new RegExp(`^${kind}:`, 'm'), `expected a "${kind}" step`);
    }
    assert.ok(!/^deployed /m.test(text), '--dry-run must not print the deploy summary');
  });

  it('reports a value-free failure and records nothing on a failed release', async () => {
    const { world: w, a } = await freshWorld();
    a.commit('break the health check', { UNHEALTHY: '' });
    const { deps: d, err } = cli(w, a);

    assert.equal(await runJamalCommand(['deploy'], d), 1);

    assert.match(err.join('\n'), /deploy failed at step "health"/);
    assert.ok(!err.join('\n').includes('ghcr.io'), 'the image reference must not leak');
    assert.equal(w.host.fs.file(hostStateFile(SERVICE, undefined)), undefined);
  });

  it('refuses a project without a Dockerfile before any remote or local command', async () => {
    const { world: w, a } = await freshWorld();
    rmSync(join(a.dir, 'Dockerfile'));
    a.commit('drop the Dockerfile', {});
    const local = counting(a.docker.runner);
    const { deps: d, err } = cli(w, a, { processRunner: local.runner });
    const from = w.host.log.length;

    assert.equal(await runJamalCommand(['deploy'], d), 1);

    assert.equal(w.host.log.length, from, 'the server must not be touched, not even the lock');
    assert.equal(local.count(), 0, 'docker must not run');
    assert.match(err.join('\n'), /no Dockerfile was found in the project root/);
    assert.ok(!err.join('\n').includes(a.dir), 'the project path must not leak');
  });
});

describe('jamal rollback', serverVerbs, () => {
  it('executes by default and returns to the previous release', async () => {
    const { world: w, a } = await freshWorld();
    const { deps: d, out, err } = cli(w, a);
    assert.equal(await runJamalCommand(['deploy'], d), 0, err.join('\n'));
    const first = hostState(w).live;
    a.commit('second', { 'app.js': 'export const version = 2;\n' });
    assert.equal(await runJamalCommand(['deploy'], d), 0, err.join('\n'));

    assert.equal(await runJamalCommand(['rollback'], d), 0, err.join('\n'));

    assert.equal(hostState(w).live, first);
    assert.match(
      out.join('\n'),
      new RegExp(`^rolled back to ${first} \\(ghcr\\.io/acme/myapp@sha256:`, 'm'),
    );
  });

  it('--dry-run prints the rollback plan and changes nothing', async () => {
    const { world: w, a } = await freshWorld();
    const { deps: d, out, err } = cli(w, a);
    assert.equal(await runJamalCommand(['deploy'], d), 0, err.join('\n'));
    const first = hostState(w).live;
    a.commit('second', { 'app.js': 'export const version = 2;\n' });
    assert.equal(await runJamalCommand(['deploy'], d), 0, err.join('\n'));
    const live = hostState(w).live;
    const from = w.host.log.length;
    out.length = 0;

    assert.equal(await runJamalCommand(['rollback', '--dry-run'], d), 0, err.join('\n'));

    for (const command of w.host.log.slice(from)) {
      assert.ok(
        command.op !== undefined && !isMutatingOp(command.op),
        command.op?.kind ?? 'unmodelled',
      );
    }
    assert.equal(hostState(w).live, live);
    const text = out.join('\n');
    assert.match(text, new RegExp(`^release: ${first}$`, 'm'));
    assert.match(text, /^switch:/m);
    assert.doesNotMatch(text, /^(secrets-file|manifest):/m, 'a rollback writes no release files');
    assert.ok(!/^rolled back/m.test(text), '--dry-run must not print the rollback summary');
  });

  it('reports a server with no previous release value-free', async () => {
    const { world: w, a } = await freshWorld();
    const { deps: d, err } = cli(w, a);
    assert.equal(await runJamalCommand(['rollback'], d), 1);
    assert.match(err.join('\n'), /the server has no previous release to roll back to/);
    assert.equal(await runJamalCommand(['deploy'], d), 0, err.join('\n'));
    assert.equal(await runJamalCommand(['rollback'], d), 1);
    assert.equal(lockHeld(w), false);
  });
});

describe('jamal status', serverVerbs, () => {
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

describe('the server is the only deploy record', () => {
  /** Every source file of the package, by its path relative to `src/`. */
  function sources(): Map<string, string> {
    const root = fileURLToPath(new URL('../../src/', import.meta.url));
    const files = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          files.set(path.slice(root.length), readFileSync(path, 'utf8'));
        }
      }
    };
    walk(root);
    return files;
  }

  it('no code path reads or writes .jamal/deploys.json, and no local history module exists', () => {
    const files = sources();
    assert.ok(files.size > 50, 'the package sources were found');
    const naming = [...files]
      .filter(([, text]) => /deploys\.json/.test(text))
      .map(([path]) => path);
    assert.deepEqual(naming, []);
    assert.ok(!files.has('production/history.ts'));
  });

  it('a deploy and a rollback leave nothing under the checkout', serverVerbs, async () => {
    const { world: w, a } = await freshWorld();
    const { deps: d, err } = cli(w, a);
    assert.equal(await runJamalCommand(['deploy'], d), 0, err.join('\n'));
    a.commit('second', { 'app.js': 'export const version = 2;\n' });
    assert.equal(await runJamalCommand(['deploy'], d), 0, err.join('\n'));
    assert.equal(await runJamalCommand(['rollback'], d), 0, err.join('\n'));
    assert.equal(existsSync(join(a.dir, '.jamal')), false);
  });
});
