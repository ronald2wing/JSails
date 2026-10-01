/**
 * Tests for the production accessory planner and executor across MariaDB,
 * Postgres, and Valkey.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  JamalConfigError,
  normalizeJamalConfig,
  secret,
  type JamalConfig,
} from '../../src/config/index.js';
import {
  ACCESSORY_HEALTH_MAX_ATTEMPTS,
  ACCESSORY_HEALTH_RETRY_DELAY_MS,
  AccessoryError,
  accessoryEnvFileContents,
  planAccessories,
  runAccessories,
  type AccessoryAction,
} from '../../src/production/accessories.js';
import {
  planProduction,
  type ProductionPlan,
  type ProductionStep,
} from '../../src/production/plan.js';
import { DeployExecuteError, runDeployExecution } from '../../src/production/execute.js';
import type { ProcessRunner } from '../../src/production/process-runner.js';
import type { HealthCheck } from '../../src/production/release.js';
import type { RemoteRunner } from '../../src/production/transport.js';

/**
 * Tests for production service accessories. `planAccessories` and
 * `runAccessories` never touch a process or the network: the remote runner is
 * injected, and the health-retry delay is an injected `sleep`. Assertions
 * target the per-service argv shapes, secret-name-only credentials, the
 * inspect-gated container reuse, the bounded health retry, and the
 * deploy-executor abort before the app release on a failed accessory step.
 */

/** A config with one MariaDB backing service and explicit database credentials. */
function dbConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    env: {
      DATABASE_NAME: 'myapp',
      DATABASE_USER: 'appuser',
      DATABASE_PASSWORD: secret('DB_PASSWORD'),
    },
    services: { db: { type: 'mariadb' } },
    production: { server: '1.2.3.4', domain: 'example.com' },
  });
}

/** A config with a Valkey service and no password. */
function valkeyConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    services: { cache: { type: 'valkey' } },
    production: { server: '1.2.3.4' },
  });
}

/** A config with a Valkey service whose password is a secret reference. */
function valkeySecretConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    env: { VALKEY_PASSWORD: secret('VALKEY_PASSWORD') },
    services: { cache: { type: 'valkey' } },
    production: { server: '1.2.3.4' },
  });
}

/** A config with no backing services. */
function noServiceConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    production: { server: '1.2.3.4' },
  });
}

/** Find a plan step by kind, or undefined. */
function stepOf(plan: ProductionPlan, kind: ProductionStep['kind']): ProductionStep | undefined {
  return plan.steps.find((step) => step.kind === kind);
}

/** The remote part of a plan step (after `ssh <server>`), or undefined. */
function remotePart(step: ProductionStep | undefined): string[] | undefined {
  const argv = step?.argv;
  if (argv === undefined || argv[0] !== 'ssh') return undefined;
  return [...argv.slice(2)];
}

/** A scriptable remote runner that records every remote argv. */
function makeRemote(script: (remoteArgv: readonly string[]) => number = () => 0): {
  remote: RemoteRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const remote: RemoteRunner = {
    async run(_server, remoteArgv) {
      calls.push([...remoteArgv]);
      return { exitCode: script(remoteArgv), stdout: '', stderr: '' };
    },
  };
  return { remote, calls };
}

/** An instant sleep seam that records every delay. */
function makeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { sleep, delays };
}

/** Build a hand-crafted accessory step for `runAccessories` tests. */
function accessoryStep(
  action: AccessoryAction,
  name: string,
  remoteArgv: string[],
): ProductionStep {
  return {
    kind: 'accessory',
    description: 'test accessory step',
    argv: ['ssh', '1.2.3.4', ...remoteArgv],
    accessory: { action, service: 'mariadb', name },
  };
}

describe('planAccessories: MariaDB', () => {
  it('plans volume, env-file, run, and health steps with the pinned image and conventions', () => {
    const plan = planAccessories(dbConfig());

    assert.deepEqual(
      plan.steps.map((step) => step.accessory?.action),
      ['volume', 'env-file', 'run', 'health'],
    );
    assert.deepEqual(plan.containers, ['db']);

    assert.deepEqual(remotePart(plan.steps[0]), ['docker', 'volume', 'create', 'mariadb-data']);
    assert.equal(plan.steps[1]?.envFilePath, '.jamal/apps/myapp/accessories/db.env');
    assert.deepEqual(plan.steps[1]?.accessory?.envSources, [
      { name: 'MARIADB_RANDOM_ROOT_PASSWORD', value: '1' },
      { name: 'MARIADB_DATABASE', from: 'DATABASE_NAME' },
      { name: 'MARIADB_PASSWORD', from: 'DATABASE_PASSWORD' },
      { name: 'MARIADB_USER', from: 'DATABASE_USER' },
    ]);
    // Credentials come from the env file: no -e flag, no host port, shared network.
    assert.deepEqual(remotePart(plan.steps[2]), [
      'docker',
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '--name',
      'db',
      '--network',
      'jamal',
      '-v',
      'mariadb-data:/var/lib/mysql',
      '--env-file',
      '.jamal/apps/myapp/accessories/db.env',
      'mariadb:11.4',
    ]);
    assert.deepEqual(remotePart(plan.steps[3]), ['docker', 'exec', 'db', 'mariadb-admin', 'ping']);
  });

  it('points the app at the accessory by container name and never repeats credentials', () => {
    const plan = planAccessories(dbConfig());
    assert.deepEqual(plan.appEnv, [
      { name: 'DATABASE_HOST', value: 'db' },
      { name: 'DATABASE_PORT', value: '3306' },
      { name: 'DATABASE_TYPE', value: 'mariadb' },
    ]);
  });

  it('never places the secret name or value on a command line', () => {
    const plan = planAccessories(dbConfig());
    const argvText = plan.steps.flatMap((step) => step.argv ?? []).join(' ');
    assert.ok(!argvText.includes('DB_PASSWORD'));
    assert.ok(!argvText.includes('PASSWORD='));
  });
});

describe('planAccessories: Postgres', () => {
  it('uses the postgres image, volume, env vars, and probe', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      env: { DATABASE_NAME: 'mydb', DATABASE_USER: 'pguser', DATABASE_PASSWORD: 'hunter2' },
      services: { pg: { type: 'postgres' } },
      production: { server: '1.2.3.4', destination: 'staging' },
    });
    const plan = planAccessories(config);

    assert.deepEqual(remotePart(plan.steps[0]), ['docker', 'volume', 'create', 'postgres-data']);
    assert.equal(plan.steps[1]?.envFilePath, '.jamal/apps/myapp-staging/accessories/pg.env');
    assert.deepEqual(
      plan.steps[1]?.accessory?.envSources?.map((source) => source.name),
      ['POSTGRES_DB', 'POSTGRES_PASSWORD', 'POSTGRES_USER'],
    );
    assert.ok(!JSON.stringify(plan).includes('hunter2'), 'a literal password stays off the plan');
    assert.deepEqual(remotePart(plan.steps[3]), ['docker', 'exec', 'pg', 'pg_isready']);
    assert.deepEqual(plan.appEnv, [
      { name: 'DATABASE_HOST', value: 'pg' },
      { name: 'DATABASE_PORT', value: '5432' },
      { name: 'DATABASE_TYPE', value: 'postgres' },
    ]);
  });
});

describe('planAccessories: Valkey', () => {
  it('runs valkey with AOF persistence and no env file when no password is set', () => {
    const plan = planAccessories(valkeyConfig());

    assert.deepEqual(
      plan.steps.map((step) => step.accessory?.action),
      ['volume', 'run', 'health'],
    );
    assert.deepEqual(remotePart(plan.steps[1]), [
      'docker',
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '--name',
      'cache',
      '--network',
      'jamal',
      '-v',
      'valkey-data:/data',
      'valkey/valkey:8.0-alpine',
      '--appendonly',
      'yes',
    ]);
    assert.deepEqual(remotePart(plan.steps[2]), ['docker', 'exec', 'cache', 'valkey-cli', 'ping']);
    assert.deepEqual(plan.appEnv, [{ name: 'VALKEY_URL', value: 'redis://cache:6379' }]);
  });

  it('reads requirepass from the env file, never from the argv', () => {
    const plan = planAccessories(valkeySecretConfig());

    assert.deepEqual(plan.steps[1]?.accessory?.envSources, [
      { name: 'REDISCLI_AUTH', from: 'VALKEY_PASSWORD' },
      { name: 'VALKEY_PASSWORD', from: 'VALKEY_PASSWORD' },
    ]);
    const argv = remotePart(plan.steps[2]) ?? [];
    assert.deepEqual(argv.slice(-5, -1), [
      '.jamal/apps/myapp/accessories/cache.env',
      'valkey/valkey:8.0-alpine',
      'sh',
      '-c',
    ]);
    const script = argv.at(-1) ?? '';
    // Through the image entrypoint, which drops root only for `valkey-server`.
    assert.match(script, /exec docker-entrypoint\.sh valkey-server - --appendonly yes/);
    assert.doesNotMatch(script, /--requirepass/);
    assert.deepEqual(remotePart(plan.steps[3]), ['docker', 'exec', 'cache', 'valkey-cli', 'ping']);
  });

  it(
    'hands the password to the entrypoint as escaped config on stdin',
    {
      // The container shell is Linux. On Windows the local `sh` is MSYS, which
      // re-parses the Windows command line Node builds and collapses the `\\`
      // in the sed expression, so it would run a script production never runs.
      skip:
        process.platform === 'win32' &&
        'the command runs in a Linux container; MSYS sh re-parses the Windows command line',
    },
    () => {
      const plan = planAccessories(valkeySecretConfig());
      // The exec-form command the container runs, verbatim: `sh -c <script>`.
      const [shell = '', ...shellArgs] = remotePart(plan.steps[2])?.slice(-3) ?? [];
      assert.equal(shell, 'sh');
      assert.equal(shellArgs[0], '-c');
      const bin = mkdtempSync(join(tmpdir(), 'jamal-valkey-'));
      try {
        const entrypoint = join(bin, 'docker-entrypoint.sh');
        writeFileSync(entrypoint, '#!/bin/sh\nprintf "%s|" "$@"\necho\ncat\n');
        chmodSync(entrypoint, 0o755);
        const password = 'a b"c\\d$(touch x)`id`';
        const result = spawnSync(shell, shellArgs, {
          cwd: bin,
          encoding: 'utf8',
          env: { PATH: `${bin}:${process.env.PATH ?? ''}`, VALKEY_PASSWORD: password },
        });
        assert.equal(result.status, 0);
        assert.equal(
          result.stdout,
          'valkey-server|-|--appendonly|yes|\n' + 'requirepass "a b\\"c\\\\d$(touch x)`id`"\n',
        );
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    },
  );
});

describe('accessoryEnvFileContents', () => {
  it('renders values from the resolved env, by container name', () => {
    const contents = accessoryEnvFileContents(
      [
        { name: 'MARIADB_RANDOM_ROOT_PASSWORD', value: '1' },
        { name: 'MARIADB_PASSWORD', from: 'DATABASE_PASSWORD' },
      ],
      {
        clear: [],
        secret: [{ name: 'DATABASE_PASSWORD', value: 's3cret pass', secret: true }],
        envFile: '',
      },
    );
    assert.equal(contents, 'MARIADB_RANDOM_ROOT_PASSWORD=1\nMARIADB_PASSWORD=s3cret pass\n');
  });

  it('fails value-free when a source did not resolve', () => {
    assert.throws(
      () => accessoryEnvFileContents([{ name: 'X', from: 'DATABASE_PASSWORD' }], undefined),
      (error: unknown) =>
        error instanceof AccessoryError &&
        error.code === 'missing_env' &&
        error.action === 'env-file',
    );
  });
});

describe('planAccessories: omissions and safety', () => {
  it('refuses a database without a DATABASE_PASSWORD entry', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      services: { db: { type: 'mariadb' } },
      production: { server: '1.2.3.4' },
    });
    assert.throws(
      () => planAccessories(config),
      (error: unknown) =>
        error instanceof JamalConfigError && /DATABASE_PASSWORD/.test(error.message),
    );
  });

  it('accepts a password supplied through an alias', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      env: { DB_PASS: { value: secret('DB_PASS'), alias: 'DATABASE_PASSWORD' } },
      services: { db: { type: 'mariadb' } },
      production: { server: '1.2.3.4' },
    });
    assert.equal(planAccessories(config).steps[1]?.accessory?.action, 'env-file');
  });

  it('skips dev tools (mailpit/adminer) entirely', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      services: { mail: { type: 'mailpit' }, admin: { type: 'adminer' } },
      production: { server: '1.2.3.4' },
    });
    assert.deepEqual(planAccessories(config).steps, []);
    assert.deepEqual(planAccessories(config).appEnv, []);
  });

  it('produces an empty plan for a service-less config', () => {
    const plan = planAccessories(noServiceConfig());
    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.appEnv, []);
  });

  it('never embeds the redacted secret form in the plan', () => {
    const plan = planAccessories(dbConfig());
    const serialized = JSON.stringify(plan);
    assert.ok(!serialized.includes('secret('), 'the redacted secret(<name>) form must not appear');
  });

  it('rejects a config without a production overlay, value-free', () => {
    assert.throws(
      () =>
        planAccessories(
          normalizeJamalConfig({
            service: 'myapp',
            image: 'img',
            services: { db: { type: 'mariadb' } },
          }),
        ),
      (error: unknown) => error instanceof JamalConfigError && /production/.test(error.message),
    );
  });
});

describe('planProduction: accessory wiring', () => {
  it('places accessory steps after the network step and adds env refs to the app run step', () => {
    const plan = planProduction(dbConfig(), { imageTag: '1.0.0' });

    assert.deepEqual(
      plan.steps.slice(0, 5).map((step) => step.accessory?.action ?? step.kind),
      ['network', 'volume', 'env-file', 'run', 'health'],
    );
    assert.deepEqual(
      plan.steps.slice(5).map((step) => step.kind),
      ['build', 'push', 'pull', 'run', 'health', 'switch', 'stop'],
    );

    const run = stepOf(plan, 'run')?.argv ?? [];
    for (const flag of ['DATABASE_HOST=db', 'DATABASE_PORT=3306', 'DATABASE_TYPE=mariadb']) {
      assert.ok(run.includes(flag), `missing ${flag}`);
    }
    assert.ok(!run.some((token) => token.startsWith('DATABASE_PASSWORD=')));
  });
});

describe('runAccessories: execution', () => {
  it('runs volume, gates run on inspect, and polls health in order', async () => {
    // The container already exists, so the run step is skipped.
    const remote = makeRemote((argv) => (argv[0] === 'docker' && argv[1] === 'inspect' ? 0 : 0));
    const steps = [
      accessoryStep('volume', 'db', ['docker', 'volume', 'create', 'mariadb-data']),
      accessoryStep('run', 'db', ['docker', 'run', '--name', 'db', 'mariadb:11.4']),
      accessoryStep('health', 'db', ['docker', 'exec', 'db', 'mariadb-admin', 'ping']),
    ];

    await runAccessories(steps, { remoteRunner: remote.remote, sleep: makeSleep().sleep });

    assert.deepEqual(remote.calls[0], ['docker', 'volume', 'create', 'mariadb-data']);
    assert.deepEqual(remote.calls[1], ['docker', 'inspect', '--type', 'container', 'db']);
    assert.deepEqual(remote.calls[2], ['docker', 'exec', 'db', 'mariadb-admin', 'ping']);
    assert.equal(remote.calls.length, 3, 'an existing container must not be recreated');
  });

  it('recreates the container when the inspect reports it is absent', async () => {
    const remote = makeRemote((argv) => (argv[0] === 'docker' && argv[1] === 'inspect' ? 1 : 0));
    const step = accessoryStep('run', 'db', ['docker', 'run', '--name', 'db', 'mariadb:11.4']);

    await runAccessories([step], { remoteRunner: remote.remote, sleep: makeSleep().sleep });

    assert.deepEqual(remote.calls[0], ['docker', 'inspect', '--type', 'container', 'db']);
    assert.deepEqual(remote.calls[1], ['docker', 'run', '--name', 'db', 'mariadb:11.4']);
  });

  it('retries a failing health probe up to the attempt cap, then fails value-free', async () => {
    const remote = makeRemote(() => 1);
    const { sleep, delays } = makeSleep();
    const step = accessoryStep('health', 'db', ['docker', 'exec', 'db', 'mariadb-admin', 'ping']);

    await assert.rejects(
      () => runAccessories([step], { remoteRunner: remote.remote, sleep }),
      (error: unknown) => error instanceof AccessoryError && error.action === 'health',
    );

    assert.equal(remote.calls.length, ACCESSORY_HEALTH_MAX_ATTEMPTS);
    assert.equal(delays.length, ACCESSORY_HEALTH_MAX_ATTEMPTS - 1);
    assert.ok(delays.every((ms) => ms === ACCESSORY_HEALTH_RETRY_DELAY_MS));
  });

  it('resolves once a health probe succeeds', async () => {
    let attempts = 0;
    const remote = makeRemote(() => {
      attempts += 1;
      return attempts < 3 ? 1 : 0;
    });
    const step = accessoryStep('health', 'db', ['docker', 'exec', 'db', 'mariadb-admin', 'ping']);

    await runAccessories([step], { remoteRunner: remote.remote, sleep: makeSleep().sleep });

    assert.equal(attempts, 3);
  });

  it('raises a volume failure naming the action', async () => {
    const remote = makeRemote(() => 1);
    const step = accessoryStep('volume', 'db', ['docker', 'volume', 'create', 'mariadb-data']);

    await assert.rejects(
      () => runAccessories([step], { remoteRunner: remote.remote, sleep: makeSleep().sleep }),
      (error: unknown) => error instanceof AccessoryError && error.action === 'volume',
    );
  });

  it('raises a run failure when the recreate exits non-zero', async () => {
    const remote = makeRemote((argv) => (argv[0] === 'docker' && argv[1] === 'inspect' ? 1 : 5));
    const step = accessoryStep('run', 'db', ['docker', 'run', '--name', 'db', 'mariadb:11.4']);

    await assert.rejects(
      () => runAccessories([step], { remoteRunner: remote.remote, sleep: makeSleep().sleep }),
      (error: unknown) => error instanceof AccessoryError && error.action === 'run',
    );
  });
});

describe('runDeployExecution: accessory abort', () => {
  const okHealthCheck: HealthCheck = async () => {};

  it('aborts before the app release with a value-free accessory error', async () => {
    // mkdir/rmdir and the volume/inspect steps succeed; the health probe fails.
    const remote = makeRemote((argv) => (argv[0] === 'docker' && argv[1] === 'exec' ? 1 : 0));
    const buildCalls: string[][] = [];
    const commandRunner: ProcessRunner = async (argv) => {
      buildCalls.push([...argv]);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const project = mkdtempSync(join(tmpdir(), 'jamal-project-'));
    writeFileSync(join(project, 'Dockerfile'), 'FROM scratch\n');

    await assert.rejects(
      () =>
        runDeployExecution({
          config: dbConfig(),
          imageTag: '1.0.0',
          cwd: project,
          commandRunner,
          remoteRunner: remote.remote,
          healthCheck: okHealthCheck,
          sleep: makeSleep().sleep,
          lockOwner: 'test',
          env: {
            clear: [
              { name: 'DATABASE_NAME', value: 'myapp', secret: false },
              { name: 'DATABASE_USER', value: 'appuser', secret: false },
            ],
            secret: [{ name: 'DATABASE_PASSWORD', value: 'pw', secret: true }],
            envFile: 'DATABASE_PASSWORD=pw\n',
          },
          envFilePath: '.jamal/apps/myapp/env',
        }),
      (error: unknown) =>
        error instanceof DeployExecuteError &&
        /deploy failed at accessory step "health"/.test(error.message),
    );

    assert.equal(buildCalls.length, 0, 'the app release must not start after an accessory failure');
  });
});
