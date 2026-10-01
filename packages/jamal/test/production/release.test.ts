/**
 * Tests for the release executor: every step of a plan reaches the remote
 * runner in order, file steps carry their precondition and the lock fence,
 * the first failure stops the release value-free, a failed health check
 * removes only a container this run started, a lost lock ends the run, and a
 * failed retire is a warning.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { normalizeJamalConfig, type JamalConfig } from '../../src/config/index.js';
import type { ResolvedEnv } from '../../src/env-resolve.js';
import { LockErrors } from '../../src/production/lock.js';
import type { ProductionPlan } from '../../src/production/plan.js';
import {
  executeReleaseSteps,
  type HealthCheck,
  type ReleaseSummary,
} from '../../src/production/release.js';
import { remoteWriteFileArgv, remoteWriteFileStdin } from '../../src/production/remote-file.js';
import { decodeRemoteOp } from '../../src/production/remote-op.js';
import {
  remoteCommandLine,
  type RemoteRunner,
  type RemoteRunOptions,
} from '../../src/production/transport.js';
import {
  deployPlan,
  imageOf,
  observation,
  release,
  rollbackPlan,
  stateOf,
  webContainer,
} from './host-observation.js';

function config(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
    production: { server: '1.2.3.4', domain: 'example.com' },
  });
}

/** A domain-less production config: the switch step carries no proxy argv. */
function serverOnlyConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
    production: { server: '1.2.3.4' },
  });
}

/** A first deploy of release 1 onto an empty host. */
function firstPlan(cfg: JamalConfig = config()): ProductionPlan {
  return deployPlan(cfg, 1);
}

/** A deploy of release 2 over live release 1. */
function secondPlan(cfg: JamalConfig = config()): ProductionPlan {
  const observed = observation(cfg, {
    releases: [1],
    state: stateOf(1),
    containers: [1],
    ...(cfg.production?.domain === undefined ? {} : { serving: 1 }),
  });
  return deployPlan(cfg, 2, { observed });
}

/** What a resolved env without secrets writes. */
const EMPTY_ENV: ResolvedEnv = {
  clear: [],
  secret: [],
  secretsFile: Buffer.from('{"v":1,"values":{}}\n'),
};

interface RecordedRemote {
  server: string;
  remoteArgv: string[];
  stdin?: string | Uint8Array;
  options?: RemoteRunOptions;
}

function makeRemoteRunner(exitCodeOf: (remoteArgv: readonly string[]) => number = () => 0): {
  remote: RemoteRunner;
  calls: RecordedRemote[];
} {
  const calls: RecordedRemote[] = [];
  const remote: RemoteRunner = {
    async run(server, remoteArgv, options) {
      const stdin = typeof options === 'string' ? options : options?.stdin;
      const call: RecordedRemote = { server, remoteArgv: [...remoteArgv] };
      if (stdin !== undefined) call.stdin = stdin;
      if (typeof options === 'object') call.options = options;
      calls.push(call);
      return { exitCode: exitCodeOf(remoteArgv), stdout: '', stderr: '' };
    },
  };
  return { remote, calls };
}

function makeHealthCheck(
  onCall?: (url: string, options: { timeoutMs: number; intervalMs: number }) => void,
): { healthCheck: HealthCheck; calls: { url: string; options: unknown }[] } {
  const calls: { url: string; options: unknown }[] = [];
  const healthCheck: HealthCheck = async (url, options) => {
    calls.push({ url, options });
    onCall?.(url, options);
  };
  return { healthCheck, calls };
}

/** An instant sleep seam that records every delay, so retry tests never wait. */
function makeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { sleep, delays };
}

/** The remote part (after `ssh <server>`) of the plan step of a kind. */
function remoteArgvOf(plan: ProductionPlan, kind: string): string[] {
  return [...(plan.steps.find((step) => step.kind === kind)?.argv ?? []).slice(2)];
}

/** Whether a remote argv is the health probe run inside the new container. */
function isProbe(remoteArgv: readonly string[]): boolean {
  return remoteArgv[0] === 'docker' && remoteArgv[1] === 'exec' && remoteArgv.includes('node');
}

/** Whether a remote argv is the proxy switch. */
function isSwitch(remoteArgv: readonly string[]): boolean {
  return remoteArgv.includes('kamal-proxy') && remoteArgv.includes('deploy');
}

/** The path a file-write argv writes, or `undefined`. */
function writtenPath(remoteArgv: readonly string[]): string | undefined {
  const op = decodeRemoteOp(remoteArgv);
  return op?.kind === 'file.write' ? op.path : undefined;
}

describe('executeReleaseSteps: successful order', () => {
  it('runs every step on the plan server in order and records the release', async () => {
    const plan = secondPlan();
    const remote = makeRemoteRunner();
    const health = makeHealthCheck();

    const summary = await executeReleaseSteps(plan, {
      remoteRunner: remote.remote,
      healthCheck: health.healthCheck,
      env: EMPTY_ENV,
    });

    assert.equal(summary.failedStep, undefined);
    assert.deepEqual(summary.completed, [
      'network',
      'pull',
      'secrets-file',
      'check',
      'manifest',
      'run',
      'health',
      'switch',
      'state',
      'retire',
    ]);
    assert.ok(remote.calls.every((call) => call.server === '1.2.3.4'));
    assert.deepEqual(
      remote.calls.map(
        (call) => writtenPath(call.remoteArgv) ?? call.remoteArgv.slice(0, 2).join(' '),
      ),
      [
        'sh -c',
        'docker pull',
        `.jamal/apps/myapp/releases/${release(2)}/secrets/secrets.json`,
        'docker run',
        `.jamal/apps/myapp/releases/${release(2)}/manifest.json`,
        'sh -c',
        'docker exec',
        '.jamal/apps/myapp/state.json',
        'sh -c',
      ],
    );
    assert.deepEqual(remote.calls[1]?.remoteArgv, ['docker', 'pull', imageOf(config(), 2)]);
    assert.deepEqual(remote.calls[5]?.remoteArgv, remoteArgvOf(plan, 'run'));
    assert.deepEqual(remote.calls.at(-1)?.remoteArgv, remoteArgvOf(plan, 'retire'));
    assert.equal(health.calls[0]?.url, 'https://example.com/up');
    assert.deepEqual(health.calls[0]?.options, { timeoutMs: 5000, intervalMs: 30000 });
  });

  it('writes the manifest create-only and the state over the bytes it observed', async () => {
    const plan = secondPlan();
    const remote = makeRemoteRunner();
    await executeReleaseSteps(plan, {
      remoteRunner: remote.remote,
      healthCheck: makeHealthCheck().healthCheck,
      env: EMPTY_ENV,
    });
    for (const kind of ['manifest', 'state'] as const) {
      const file = plan.steps.find((step) => step.kind === kind)?.file;
      assert.ok(file !== undefined);
      const call = remote.calls.find((c) => writtenPath(c.remoteArgv) === file.path);
      assert.deepEqual(call?.remoteArgv, [
        ...remoteWriteFileArgv(file.path, {
          mode: file.mode,
          directoryMode: file.directoryMode,
          ...(file.expect === undefined ? {} : { expect: file.expect }),
        }),
      ]);
      assert.deepEqual(call?.stdin, remoteWriteFileStdin(Buffer.from(file.contents ?? '', 'utf8')));
    }
  });

  it('defers the switch with a warning when the app is not routed', async () => {
    const summary = await executeReleaseSteps(secondPlan(serverOnlyConfig()), {
      remoteRunner: makeRemoteRunner().remote,
      healthCheck: makeHealthCheck().healthCheck,
      env: EMPTY_ENV,
    });
    assert.ok(!summary.completed.includes('switch'));
    assert.ok(summary.completed.includes('state'));
    assert.ok(summary.warnings.some((warning) => warning.includes('proxy switch is deferred')));
  });

  it('returns deep-equal summaries for identical input', async () => {
    const summaries: ReleaseSummary[] = [];
    for (let index = 0; index < 2; index += 1) {
      summaries.push(
        await executeReleaseSteps(secondPlan(), {
          remoteRunner: makeRemoteRunner().remote,
          healthCheck: makeHealthCheck().healthCheck,
          env: EMPTY_ENV,
        }),
      );
    }
    assert.deepEqual(summaries[0], summaries[1]);
  });
});

describe('executeReleaseSteps: health retries', () => {
  it('sleeps readinessDelayMs once before the first health probe', async () => {
    const cfg = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp',
      health: { path: '/up', timeoutMs: 5000, intervalMs: 30000, readinessDelayMs: 600 },
      production: { server: '1.2.3.4' },
    });
    const { sleep, delays } = makeSleep();
    const health = makeHealthCheck();
    await executeReleaseSteps(firstPlan(cfg), {
      remoteRunner: makeRemoteRunner().remote,
      healthCheck: health.healthCheck,
      env: EMPTY_ENV,
      sleep,
    });
    assert.deepEqual(delays, [600]);
    assert.equal(health.calls.length, 1);
  });

  it('honors healthRetries / healthRetryDelayMs from the plan', async () => {
    const cfg = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp',
      health: { path: '/up', timeoutMs: 5000, intervalMs: 30000, retries: 2, retryDelayMs: 100 },
      production: { server: '1.2.3.4' },
    });
    const health = makeHealthCheck(() => {
      throw new Error('fail');
    });
    const { sleep, delays } = makeSleep();
    await executeReleaseSteps(firstPlan(cfg), {
      remoteRunner: makeRemoteRunner().remote,
      healthCheck: health.healthCheck,
      env: EMPTY_ENV,
      sleep,
    });
    assert.equal(health.calls.length, 3);
    assert.deepEqual(delays, [100, 100]);
  });

  it('retries a failing health check, then reports a value-free timeout', async () => {
    const health = makeHealthCheck(() => {
      throw new Error('poll timed out');
    });
    const { sleep, delays } = makeSleep();
    const summary = await executeReleaseSteps(firstPlan(), {
      remoteRunner: makeRemoteRunner().remote,
      healthCheck: health.healthCheck,
      env: EMPTY_ENV,
      sleep,
    });
    assert.deepEqual(summary.completed, [
      'network',
      'pull',
      'secrets-file',
      'check',
      'manifest',
      'run',
    ]);
    assert.deepEqual(summary.failedStep, {
      kind: 'health',
      exitCode: 1,
      message: 'the health check timed out',
    });
    assert.equal(health.calls.length, 6);
    assert.deepEqual(delays, [10_000, 10_000, 10_000, 10_000, 10_000]);
  });

  it('succeeds when the health check recovers within the retry budget', async () => {
    let attempts = 0;
    const health = makeHealthCheck(() => {
      attempts += 1;
      if (attempts < 3) throw new Error('poll timed out');
    });
    const summary = await executeReleaseSteps(firstPlan(), {
      remoteRunner: makeRemoteRunner().remote,
      healthCheck: health.healthCheck,
      env: EMPTY_ENV,
      sleep: makeSleep().sleep,
    });
    assert.equal(summary.failedStep, undefined);
    assert.equal(attempts, 3);
  });

  it('caps total attempts at maxAttempts even when retries is higher', async () => {
    const health = makeHealthCheck(() => {
      throw new Error('poll timed out');
    });
    const { sleep, delays } = makeSleep();
    const summary = await executeReleaseSteps(firstPlan(), {
      remoteRunner: makeRemoteRunner().remote,
      healthCheck: health.healthCheck,
      env: EMPTY_ENV,
      sleep,
      healthRetry: { retries: 5, delayMs: 20, maxAttempts: 2 },
    });
    assert.equal(summary.failedStep?.kind, 'health');
    assert.equal(health.calls.length, 2);
    assert.deepEqual(delays, [20]);
  });
});

describe('executeReleaseSteps: failures', () => {
  it('reports a value-free remote failure on a non-zero pull exit', async () => {
    const { remote, calls } = makeRemoteRunner((argv) => (argv[1] === 'pull' ? 7 : 0));
    const summary = await executeReleaseSteps(firstPlan(), {
      remoteRunner: remote,
      healthCheck: makeHealthCheck().healthCheck,
      env: EMPTY_ENV,
    });
    assert.deepEqual(summary.completed, ['network']);
    assert.deepEqual(summary.failedStep, {
      kind: 'pull',
      exitCode: 7,
      message: 'pull exited with code 7',
    });
    assert.equal(calls.length, 2);
  });

  it('reports a value-free switch failure and removes the container that never served', async () => {
    const { remote, calls } = makeRemoteRunner((argv) => (isSwitch(argv) ? 4 : 0));
    const plan = secondPlan();
    const summary = await executeReleaseSteps(plan, {
      remoteRunner: remote,
      healthCheck: makeHealthCheck().healthCheck,
      env: EMPTY_ENV,
    });
    assert.deepEqual(summary.failedStep, {
      kind: 'switch',
      exitCode: 4,
      message: 'switch exited with code 4',
    });
    assert.deepEqual(calls.at(-1)?.remoteArgv, ['docker', 'rm', '-f', plan.containerName]);
    assert.ok(!calls.some((call) => writtenPath(call.remoteArgv)?.endsWith('state.json')));
  });

  it('stops before the retire when the state changed since it was observed', async () => {
    const { remote, calls } = makeRemoteRunner((argv) =>
      writtenPath(argv)?.endsWith('state.json') === true ? 7 : 0,
    );
    const summary = await executeReleaseSteps(secondPlan(), {
      remoteRunner: remote,
      healthCheck: makeHealthCheck().healthCheck,
      env: EMPTY_ENV,
    });
    assert.deepEqual(summary.failedStep, {
      kind: 'state',
      exitCode: 1,
      message: 'state failed: jamal_remote_file.precondition_failed',
    });
    assert.ok(!calls.some((call) => call.remoteArgv.includes(webContainer(config(), 1))));
  });

  it('ends the release at the first command the lock refuses', async () => {
    const calls: string[][] = [];
    const remote: RemoteRunner = {
      async run(_server, remoteArgv) {
        calls.push([...remoteArgv]);
        if (decodeRemoteOp(remoteArgv)?.kind === 'container.run-fresh') {
          throw new LockErrors.Error('lock_lost');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const summary = await executeReleaseSteps(firstPlan(), {
      remoteRunner: remote,
      healthCheck: makeHealthCheck().healthCheck,
      env: EMPTY_ENV,
    });
    assert.deepEqual(summary.failedStep, {
      kind: 'run',
      exitCode: 1,
      message: 'run failed: jamal_lock.lock_lost',
    });
    assert.equal(decodeRemoteOp(calls.at(-1) ?? [])?.kind, 'container.run-fresh');
  });

  it('stops retrying the health check once the lock is lost', async () => {
    let probes = 0;
    const remote: RemoteRunner = {
      async run(_server, remoteArgv) {
        if (isProbe(remoteArgv)) {
          probes += 1;
          throw new LockErrors.Error('lock_lost');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const summary = await executeReleaseSteps(firstPlan(), {
      remoteRunner: remote,
      env: EMPTY_ENV,
      sleep: makeSleep().sleep,
    });
    assert.equal(summary.failedStep?.message, 'health failed: jamal_lock.lock_lost');
    assert.equal(probes, 1);
  });

  it('reports a failed retire as a warning: the release is live and recorded', async () => {
    const { remote } = makeRemoteRunner((argv) =>
      argv.includes(webContainer(config(), 1)) ? 1 : 0,
    );
    const summary = await executeReleaseSteps(secondPlan(), {
      remoteRunner: remote,
      healthCheck: makeHealthCheck().healthCheck,
      env: EMPTY_ENV,
    });
    assert.equal(summary.failedStep, undefined);
    assert.ok(summary.completed.includes('state'));
    assert.ok(!summary.completed.includes('retire'));
    assert.ok(summary.warnings.some((warning) => /next deploy retires it/.test(warning)));
  });

  it('reports the tail of a failed remote command stderr to the logger', async () => {
    const warnings: string[] = [];
    const remote: RemoteRunner = {
      async run(_server, remoteArgv) {
        return remoteArgv[1] === 'pull'
          ? { exitCode: 1, stdout: '', stderr: 'manifest unknown\n' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const summary = await executeReleaseSteps(firstPlan(), {
      remoteRunner: remote,
      env: EMPTY_ENV,
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
    });
    assert.equal(summary.failedStep?.message, 'pull exited with code 1');
    assert.ok(warnings.some((warning) => warning.includes('manifest unknown')));
  });

  it('stops before the run on a failed deploy check, logging its findings', async () => {
    const warnings: string[] = [];
    const calls: string[][] = [];
    const remote: RemoteRunner = {
      async run(_server, remoteArgv) {
        calls.push([...remoteArgv]);
        return remoteArgv.includes('--deploy')
          ? {
              exitCode: 1,
              stdout: 'config loads\nerror proxy_untrusted: the deploy states proxies\n',
              stderr: '',
            }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const summary = await executeReleaseSteps(firstPlan(), {
      remoteRunner: remote,
      env: EMPTY_ENV,
      logger: { info: () => {}, warn: (line) => warnings.push(line) },
    });
    assert.equal(summary.failedStep?.kind, 'check');
    assert.deepEqual(summary.completed, ['network', 'pull', 'secrets-file']);
    assert.ok(calls.at(-1)?.includes('--deploy'), 'nothing ran after the check');
    assert.match(warnings.join('\n'), /check stdout \(last lines\):\n.*\nerror proxy_untrusted: /);
  });
});

describe('executeReleaseSteps: the default in-container health probe', () => {
  it('runs the plan probe over ssh with a bounded timeout when no checker is injected', async () => {
    const plan = firstPlan();
    const remote = makeRemoteRunner();
    const summary = await executeReleaseSteps(plan, {
      remoteRunner: remote.remote,
      env: EMPTY_ENV,
    });
    assert.equal(summary.failedStep, undefined);
    const probe = remote.calls.find((call) => isProbe(call.remoteArgv));
    assert.deepEqual(probe?.remoteArgv, remoteArgvOf(plan, 'health'));
    assert.equal(probe?.options?.timeoutMs, 5000 + 15_000);
  });

  it('fails after the retry budget and removes the new container, never the live one', async () => {
    const plan = secondPlan();
    const { remote, calls } = makeRemoteRunner((argv) => (isProbe(argv) ? 1 : 0));
    const summary = await executeReleaseSteps(plan, {
      remoteRunner: remote,
      env: EMPTY_ENV,
      sleep: makeSleep().sleep,
    });
    assert.equal(summary.failedStep?.kind, 'health');
    assert.equal(calls.filter((call) => isProbe(call.remoteArgv)).length, 6);
    assert.deepEqual(calls.at(-1)?.remoteArgv, ['docker', 'rm', '-f', webContainer(config(), 2)]);
    assert.ok(!calls.some((call) => call.remoteArgv.includes(webContainer(config(), 1))));
    assert.ok(!calls.some((call) => isSwitch(call.remoteArgv)), 'no switch after a failure');
  });

  it('never removes a running container a rollback reuses', async () => {
    const cfg = config();
    const observed = observation(cfg, {
      releases: [1, [2, 1]],
      state: stateOf(1),
      containers: [1, 2],
      serving: 2,
    });
    const { remote, calls } = makeRemoteRunner((argv) => (isProbe(argv) ? 1 : 0));
    const summary = await executeReleaseSteps(rollbackPlan(cfg, observed), {
      remoteRunner: remote,
      sleep: makeSleep().sleep,
    });
    assert.equal(summary.failedStep?.kind, 'health');
    assert.ok(!calls.some((call) => call.remoteArgv.includes('rm')));
  });
});

describe('executeReleaseSteps: required seams', () => {
  it('rejects a call missing the remote runner', async () => {
    await assert.rejects(
      () =>
        executeReleaseSteps(firstPlan(), {
          remoteRunner: undefined as unknown as RemoteRunner,
        }),
      (error: unknown) => error instanceof Error && /remote runner/.test(error.message),
    );
  });

  it('refuses a preview plan before any step runs', async () => {
    const cfg = config();
    const preview = deployPlan(cfg, 1, { preview: true });
    const { remote, calls } = makeRemoteRunner();
    await assert.rejects(
      () => executeReleaseSteps(preview, { remoteRunner: remote }),
      (error: unknown) => error instanceof Error && /preview/.test(error.message),
    );
    assert.deepEqual(calls, []);
  });
});

describe('executeReleaseSteps: the secrets-file step', () => {
  const env: ResolvedEnv = {
    clear: [{ name: 'LOG_LEVEL', value: 'info', secret: false }],
    secret: [
      { name: 'API_KEY', value: 'sk_live_do-not-leak', secret: true },
      { name: 'DB_PASSWORD', value: 'hunter2', secret: true },
    ],
    secretsFile: Buffer.from(
      '{"v":1,"values":{"API_KEY":"sk_live_do-not-leak","DB_PASSWORD":"hunter2"}}\n',
    ),
  };
  const SECRETS_PATH = `.jamal/apps/myapp/releases/${release(1)}/secrets/secrets.json`;
  const FENCE = { dir: '.jamal/apps/myapp/lock', token: 'c'.repeat(32) };

  function secretPlan(): ProductionPlan {
    return deployPlan(config(), 1, { env });
  }

  it('writes the file create-only, its contents and the lock token on stdin only', async () => {
    const remote = makeRemoteRunner();
    const summary = await executeReleaseSteps(secretPlan(), {
      remoteRunner: remote.remote,
      healthCheck: makeHealthCheck().healthCheck,
      env,
      fence: FENCE,
    });
    assert.equal(summary.failedStep, undefined);
    const writeCall = remote.calls.find((call) => writtenPath(call.remoteArgv) === SECRETS_PATH);
    assert.ok(writeCall !== undefined);
    assert.deepEqual(writeCall.remoteArgv, [
      ...remoteWriteFileArgv(SECRETS_PATH, {
        mode: 0o444,
        directoryMode: 0o755,
        fence: FENCE,
        expect: 'absent',
      }),
    ]);
    assert.deepEqual(writeCall.stdin, remoteWriteFileStdin(env.secretsFile, FENCE));
    const everyArgv = remote.calls.flatMap((call) => call.remoteArgv).join(' ');
    assert.ok(!everyArgv.includes('sk_live_do-not-leak'));
    assert.ok(!everyArgv.includes('hunter2'));
    assert.ok(!everyArgv.includes(FENCE.token));
    const runCall = remote.calls.find((call) => call.remoteArgv.includes('run'));
    assert.ok(runCall?.remoteArgv.includes('LOG_LEVEL=info'));
  });

  it('fails value-free when the plan expects secrets the executor was not given', async () => {
    const remote = makeRemoteRunner();
    const summary = await executeReleaseSteps(secretPlan(), {
      remoteRunner: remote.remote,
      healthCheck: makeHealthCheck().healthCheck,
    });
    assert.deepEqual(summary.failedStep, {
      kind: 'secrets-file',
      exitCode: 1,
      message: 'the secrets-file step has no contents or destination path',
    });
    assert.ok(!remote.calls.some((call) => call.remoteArgv.includes('run')));
  });

  for (const [exitCode, code] of [
    [4, 'checksum_mismatch'],
    [5, 'lock_lost'],
    [6, 'no_hasher'],
    [7, 'precondition_failed'],
  ] as const) {
    it(`stops before the check when the write fails with ${code}, naming only the code`, async () => {
      const remote: RemoteRunner = {
        async run(_server, remoteArgv) {
          const failed = writtenPath(remoteArgv) === SECRETS_PATH;
          return { exitCode: failed ? exitCode : 0, stdout: '', stderr: 'hunter2' };
        },
      };
      const summary = await executeReleaseSteps(secretPlan(), {
        remoteRunner: remote,
        healthCheck: makeHealthCheck().healthCheck,
        env,
      });
      assert.deepEqual(summary.failedStep, {
        kind: 'secrets-file',
        exitCode: 1,
        message: `secrets-file failed: jamal_remote_file.${code}`,
      });
      assert.deepEqual(summary.completed, ['network', 'pull']);
    });
  }

  it(
    'creates private parents and a read-only file in a readable directory on a fresh server',
    {
      skip:
        process.platform === 'win32' &&
        'the remote end is a POSIX shell and file modes are POSIX; Windows reads every writable file as 0o666',
    },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'jamal-home-'));
      try {
        const contents = Buffer.from('{"v":1,"values":{"API_KEY":"sk $(id) `x` \'q\'\\n"}}\n');
        const secretEnv: ResolvedEnv = {
          clear: [],
          secret: [{ name: 'API_KEY', value: 'v', secret: true }],
          secretsFile: contents,
        };
        const plan = deployPlan(config(), 1, { env: secretEnv });
        const secretsOnly = {
          ...plan,
          steps: plan.steps.filter((step) => step.kind === 'secrets-file'),
        };
        const remote: RemoteRunner = {
          async run(_server, remoteArgv, options) {
            const stdin = typeof options === 'string' ? options : options?.stdin;
            const result = spawnSync('sh', ['-c', remoteCommandLine(remoteArgv)], {
              cwd: home,
              input: stdin ?? '',
              encoding: 'utf8',
            });
            return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
          },
        };
        const summary = await executeReleaseSteps(secretsOnly, {
          remoteRunner: remote,
          env: secretEnv,
        });
        assert.equal(summary.failedStep, undefined);
        const file = join(home, SECRETS_PATH);
        assert.ok(readFileSync(file).equals(contents));
        assert.equal(statSync(file).mode & 0o777, 0o444);
        assert.equal(statSync(join(file, '..')).mode & 0o777, 0o755);
        assert.equal(
          statSync(join(home, `.jamal/apps/myapp/releases/${release(1)}`)).mode & 0o777,
          0o700,
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
