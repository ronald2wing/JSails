/**
 * Tests for the production deploy planner: step order, argv shapes, secret
 * safety, env-file step, and container naming.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  JamalConfigError,
  normalizeJamalConfig,
  secret,
  type JamalConfig,
} from '../../src/config/index.js';
import type { ResolvedEnv } from '../../src/env-resolve.js';
import {
  formatProductionPlan,
  planProduction,
  type ProductionPlan,
  type ProductionStep,
} from '../../src/production/plan.js';
import { remoteCommandLine, shellQuote } from '../../src/production/transport.js';

/**
 * Tests for the pure production planner. `planProduction` never touches disk or
 * the environment and never resolves a secret, so these run entirely
 * in-process. Assertions target the ordered step kinds and argv shapes, the
 * value-free `env` reduction, container-name determinism, the conditional
 * rollback step, https-vs-http health URL selection, and invalid-tag rejection.
 */

/** A full production config (tagless image; the tag arrives via options). */
function fullConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    command: 'node server.js',
    health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
    env: {
      NODE_ENV: 'production',
      DB_PASSWORD: secret('DB_PASSWORD'),
      API_KEY: secret('API_KEY'),
      DATABASE_PASSWORD: secret('DATABASE_PASSWORD'),
    },
    services: { db: { type: 'mariadb' } },
    volumes: { storage: '/app/storage', data: '/var/lib/mysql' },
    production: {
      server: '1.2.3.4',
      domain: 'example.com',
      registry: { server: 'ghcr.io', username: 'acme' },
    },
  });
}

/** The step of a given kind, or undefined. */
function stepOf(plan: ProductionPlan, kind: ProductionStep['kind']): ProductionStep | undefined {
  return plan.steps.find((step) => step.kind === kind);
}

/** Capture a thrown JamalConfigError. */
function capture(fn: () => unknown): JamalConfigError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof JamalConfigError, `expected JamalConfigError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected a JamalConfigError, but nothing was thrown');
}

describe('planProduction: ordered step kinds and argv shapes', () => {
  it('prepends the backing-service accessory steps before the app flow', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });

    // `services: { db: { type: 'mariadb' } }` contributes one accessory step
    // each for its volume, credentials env file, container, and health poll,
    // all after the network step and before the app build.
    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      [
        'network',
        'accessory',
        'accessory',
        'accessory',
        'accessory',
        'build',
        'push',
        'pull',
        'run',
        'health',
        'switch',
        'stop',
      ],
    );
  });

  it('lays out the app steps in order when no backing service is declared', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4', domain: 'example.com' },
      }),
      { imageTag: '1.0.0' },
    );

    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      ['network', 'build', 'push', 'pull', 'run', 'health', 'switch', 'stop'],
    );
  });

  it('builds and pushes locally, then pulls/runs/stops over ssh', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });
    const imageRef = 'ghcr.io/acme/myapp:1.0.0';

    assert.deepEqual(stepOf(plan, 'build')?.argv, [
      'docker',
      'buildx',
      'build',
      '-t',
      imageRef,
      '.',
    ]);
    assert.deepEqual(stepOf(plan, 'push')?.argv, ['docker', 'push', imageRef]);
    assert.deepEqual(stepOf(plan, 'pull')?.argv, ['ssh', '1.2.3.4', 'docker', 'pull', imageRef]);
    assert.deepEqual(stepOf(plan, 'run')?.argv, [
      'ssh',
      '1.2.3.4',
      // A stopped leftover of the same name is removed before the run; a
      // running one is never force-removed.
      'sh',
      '-c',
      'n=$1; shift; docker rm "$n" >/dev/null 2>&1; "$@" && exit 0; ' +
        's=$?; docker rm "$n" >/dev/null 2>&1; exit $s',
      'sh',
      'myapp-web-1.0.0',
      'docker',
      'run',
      '-d',
      '--name',
      'myapp-web-1.0.0',
      '--network',
      'jamal',
      '--restart',
      'unless-stopped',
      '--label',
      'jamal.service=myapp',
      // The image need not set NODE_ENV; an unset one boots development defaults.
      '-e',
      'NODE_ENV=production',
      '-e',
      'JSAILS_HOST=0.0.0.0',
      '-e',
      'JSAILS_PORT=3000',
      // The MariaDB accessory is addressed by its container name on the shared
      // network; credentials are never repeated as -e flags.
      '-e',
      'DATABASE_HOST=db',
      '-e',
      'DATABASE_PORT=3306',
      '-e',
      'DATABASE_TYPE=mariadb',
      // Named volumes are mounted, prefixed with the service.
      '-v',
      'myapp_data:/var/lib/mysql',
      '-v',
      'myapp_storage:/app/storage',
      imageRef,
      // config.command follows the image.
      'node',
      'server.js',
    ]);
  });

  it('ensures the shared network and attaches the proxy and accessories to it', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });
    const argv = stepOf(plan, 'network')?.argv ?? [];
    assert.deepEqual(argv.slice(0, 3), ['ssh', '1.2.3.4', 'sh']);
    assert.match(argv[4] ?? '', /docker network create jamal/);
    // An image or volume named like an accessory must not pass for its container.
    assert.match(argv[4] ?? '', /docker inspect --type container "\$c" >/);
    assert.match(argv[4] ?? '', /docker inspect --type container -f /);
    assert.doesNotMatch(argv[4] ?? '', /docker inspect (?!--type container)/);
    assert.deepEqual(argv.slice(5), ['sh', 'kamal-proxy', 'db']);
  });

  it('skips the local build and push for a rollback', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0', skipBuild: true });
    assert.ok(!plan.steps.some((step) => step.kind === 'build' || step.kind === 'push'));
  });

  it('polls the health URL over ssh and emits the proxy deploy argv for the switch', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });

    // The probe runs inside the NEW container, not against the public URL the
    // previous release still answers.
    const health = stepOf(plan, 'health');
    assert.deepEqual(health?.argv?.slice(0, 7), [
      'ssh',
      '1.2.3.4',
      'docker',
      'exec',
      'myapp-web-1.0.0',
      'node',
      '-e',
    ]);
    assert.equal(
      health?.argv?.[7],
      'fetch("http://127.0.0.1:3000/up",{signal:AbortSignal.timeout(5000)})' +
        '.then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))',
    );
    assert.equal(health?.cleanupOnFailure, true);
    assert.match(health?.description ?? '', /5000 ms per probe/);

    // A domain is set, so the switch step carries the ssh-prefixed proxy deploy
    // argv targeting the new container with TLS and the production domain as host.
    const switchStep = stepOf(plan, 'switch');
    assert.deepEqual(switchStep?.argv, [
      'ssh',
      '1.2.3.4',
      'docker',
      'exec',
      'kamal-proxy',
      'kamal-proxy',
      'deploy',
      'myapp',
      '--target',
      'myapp-web-1.0.0:3000',
      '--host',
      'example.com',
      '--tls',
      '--health-check-path',
      '/up',
    ]);
    assert.match(switchStep?.description ?? '', /route traffic to/);
  });

  it('keeps the switch a pure directive when no production domain is set', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const switchStep = stepOf(plan, 'switch');
    assert.equal(switchStep?.argv, undefined);
    assert.match(switchStep?.description ?? '', /route traffic to/);
  });

  it('emits an on-demand TLS proxy deploy argv (host omitted) when onDemandTlsUrl is set', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4', onDemandTlsUrl: 'https://tls.example.com/check' },
      }),
      { imageTag: '1.0.0' },
    );

    const switchStep = stepOf(plan, 'switch');
    assert.deepEqual(switchStep?.argv, [
      'ssh',
      '1.2.3.4',
      'docker',
      'exec',
      'kamal-proxy',
      'kamal-proxy',
      'deploy',
      'myapp',
      '--target',
      'myapp-web-1.0.0:3000',
      '--tls',
      '--health-check-path',
      '/up',
      '--tls-on-demand-url',
      'https://tls.example.com/check',
    ]);
  });
});

describe('planProduction: secret safety', () => {
  it('reduces env to name + secret flag and never embeds a value', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });

    assert.deepEqual(plan.env, [
      { name: 'API_KEY', secret: true, alias: undefined, clear: false },
      { name: 'DATABASE_PASSWORD', secret: true, alias: undefined, clear: false },
      { name: 'DB_PASSWORD', secret: true, alias: undefined, clear: false },
      { name: 'NODE_ENV', secret: false, alias: undefined, clear: false },
    ]);

    for (const entry of plan.env) {
      assert.deepEqual(Object.keys(entry).sort(), ['alias', 'clear', 'name', 'secret']);
    }
    const serialized = JSON.stringify(plan);
    assert.ok(!serialized.includes('secret('), 'the redacted secret(<name>) form must not appear');
    assert.ok(!serialized.includes('"value":"production"'), 'no env value may appear');
  });

  it('keeps the health URL free of registry and secret values', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });

    assert.equal(plan.healthUrl, 'https://example.com/up');
    assert.ok(!plan.healthUrl.includes('ghcr.io'));
    assert.ok(!plan.healthUrl.includes('acme'));
  });
});

describe('planProduction: env-file step', () => {
  const env: ResolvedEnv = {
    clear: [
      { name: 'NODE_ENV', value: 'production', secret: false },
      { name: 'PUBLIC_URL', value: 'https://example.com', secret: false },
    ],
    secret: [
      { name: 'API_KEY', value: 'sk_live_do-not-leak', secret: true },
      { name: 'DB_PASSWORD', value: 'hunter2', secret: true },
    ],
    envFile: 'API_KEY=sk_live_do-not-leak\nDB_PASSWORD=hunter2\n',
  };

  it('inserts the env-file step between pull and run when secrets exist', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4', domain: 'example.com' },
      }),
      {
        imageTag: '1.0.0',
        env,
        envFilePath: '.jamal/apps/myapp/env',
      },
    );

    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      ['network', 'build', 'push', 'pull', 'env-file', 'run', 'health', 'switch', 'stop'],
    );
    assert.deepEqual(stepOf(plan, 'env-file')?.envFilePath, '.jamal/apps/myapp/env');
  });

  it('omits the env-file step when no env is supplied', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      ['network', 'build', 'push', 'pull', 'run', 'health', 'switch', 'stop'],
    );
  });

  it('passes only clear entries as -e flags and reads secrets via --env-file', () => {
    const plan = planProduction(fullConfig(), {
      imageTag: '1.0.0',
      env,
      envFilePath: '.jamal/apps/myapp/env',
    });

    const run = stepOf(plan, 'run');
    assert.ok(run?.argv !== undefined);
    // Clear entries become -e NAME=VALUE pairs.
    assert.ok(run.argv.includes('-e'));
    assert.ok(run.argv.includes('NODE_ENV=production'));
    assert.ok(run.argv.includes('PUBLIC_URL=https://example.com'));
    // Secrets are never a -e flag.
    const joined = run.argv.join(' ');
    assert.ok(!joined.includes('sk_live_do-not-leak'));
    assert.ok(!joined.includes('hunter2'));
    // The run step reads the env file instead.
    const envFileIndex = run.argv.indexOf('--env-file');
    assert.notEqual(envFileIndex, -1);
    assert.equal(run.argv[envFileIndex + 1], '.jamal/apps/myapp/env');
  });

  it('never embeds a secret value in the plan or its serialized form', () => {
    const plan = planProduction(fullConfig(), {
      imageTag: '1.0.0',
      env,
      envFilePath: '.jamal/apps/myapp/env',
    });

    const envFileStep = stepOf(plan, 'env-file');
    assert.ok(envFileStep !== undefined);
    assert.ok(!('envFile' in envFileStep), 'no secret contents may live on the step');
    assert.deepEqual(Object.keys(envFileStep).sort(), ['description', 'envFilePath', 'kind']);

    const serialized = JSON.stringify(plan);
    assert.ok(!serialized.includes('sk_live_do-not-leak'));
    assert.ok(!serialized.includes('hunter2'));
  });
});

describe('planProduction: container name determinism', () => {
  it('uses the full tag, so distinct tags never share a container name', () => {
    assert.equal(
      planProduction(fullConfig(), { imageTag: 'v1.2.3' }).containerName,
      'myapp-web-v1.2.3',
    );
    // Two timestamp tags in the same minute used to truncate to one name.
    assert.notEqual(
      planProduction(fullConfig(), { imageTag: '20261119120001' }).containerName,
      planProduction(fullConfig(), { imageTag: '20261119120002' }).containerName,
    );
  });

  it('rejects a tag outside the docker tag grammar', () => {
    for (const bad of ['Release/1.0', '---', '.hidden', 'a;rm', '$(id)', 'x'.repeat(129)]) {
      const error = capture(() => planProduction(fullConfig(), { imageTag: bad }));
      assert.match(error.message, /image tag/);
      assert.ok(!error.message.includes(bad));
    }
  });
});

describe('planProduction: rollback and stop', () => {
  it('adds a rollback step only when previousTag is provided, pointing at the previous image', () => {
    const withoutPrevious = planProduction(fullConfig(), { imageTag: '2.0.0' });
    assert.equal(
      withoutPrevious.steps.some((step) => step.kind === 'rollback'),
      false,
    );

    const withPrevious = planProduction(fullConfig(), {
      imageTag: '2.0.0',
      previousTag: '1.0.0',
    });
    assert.deepEqual(
      withPrevious.steps.map((step) => step.kind),
      [
        'network',
        'accessory',
        'accessory',
        'accessory',
        'accessory',
        'build',
        'push',
        'pull',
        'run',
        'health',
        'switch',
        'stop',
        'rollback',
      ],
    );

    const rollback = stepOf(withPrevious, 'rollback');
    assert.ok(rollback?.argv?.includes('ghcr.io/acme/myapp:1.0.0'));
    assert.match(rollback?.description ?? '', /ghcr\.io\/acme\/myapp:1\.0\.0/);
  });

  it('stops and removes the previous container by name when previousTag is known', () => {
    const plan = planProduction(fullConfig(), {
      imageTag: '2.0.0',
      previousTag: '1.0.0',
    });

    const stop = stepOf(plan, 'stop');
    assert.deepEqual(stop?.argv, [
      'ssh',
      '1.2.3.4',
      'sh',
      '-c',
      'docker inspect --type container "$1" >/dev/null 2>&1 || exit 0; ' +
        'docker stop "$1" >/dev/null && docker rm "$1" >/dev/null',
      'sh',
      'myapp-web-1.0.0',
    ]);
  });

  it('gives a same-tag redeploy its own container and retires the live one only at the end', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0', previousTag: '1.0.0' });
    assert.equal(plan.containerName, 'myapp-web-1.0.0-r');
    assert.deepEqual(plan.cleanupArgv, [
      'ssh',
      '1.2.3.4',
      'docker',
      'rm',
      '-f',
      'myapp-web-1.0.0-r',
    ]);
    // No step before the stop names the live container.
    const stopIndex = plan.steps.findIndex((step) => step.kind === 'stop');
    for (const step of plan.steps.slice(0, stopIndex)) {
      assert.ok(
        !(step.argv ?? []).includes('myapp-web-1.0.0'),
        `${step.kind} touches the live one`,
      );
    }
    assert.equal(stepOf(plan, 'stop')?.argv?.at(-1), 'myapp-web-1.0.0');
    assert.equal(stepOf(plan, 'run')?.cleanupOnFailure, undefined);
  });

  it('alternates back to the default name when the live container has the alternate one', () => {
    const plan = planProduction(fullConfig(), {
      imageTag: '1.0.0',
      previousTag: '1.0.0',
      previousContainer: 'myapp-web-1.0.0-r',
    });
    assert.equal(plan.containerName, 'myapp-web-1.0.0');
    assert.equal(stepOf(plan, 'stop')?.argv?.at(-1), 'myapp-web-1.0.0-r');
  });

  it('rejects a recorded previous container that is not a container name, value-free', () => {
    const error = capture(() =>
      planProduction(fullConfig(), {
        imageTag: '1.0.0',
        previousTag: '0.9.0',
        previousContainer: 'x;rm -rf',
      }),
    );
    assert.ok(!error.message.includes('rm -rf'));
  });

  it('runs the rollback image with the same flags as a deploy', () => {
    const plan = planProduction(fullConfig(), { imageTag: '2.0.0', previousTag: '1.0.0' });
    const rollback = stepOf(plan, 'rollback')?.argv ?? [];
    for (const flag of [
      '--network',
      '--restart',
      'DATABASE_HOST=db',
      'myapp_storage:/app/storage',
    ]) {
      assert.ok(rollback.includes(flag), `rollback is missing ${flag}`);
    }
  });

  it('leaves the stop step argv-less on a first deploy (no previous tag)', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });
    const stop = stepOf(plan, 'stop');
    assert.equal(stop?.argv, undefined);
    assert.match(stop?.description ?? '', /Stop the previous container/);
  });
});

describe('planProduction: health URL selection', () => {
  it('uses https when a domain is set and http otherwise', () => {
    assert.equal(
      planProduction(fullConfig(), { imageTag: '1.0.0' }).healthUrl,
      'https://example.com/up',
    );

    const serverOnly = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );
    assert.equal(serverOnly.healthUrl, 'http://1.2.3.4/up');
  });
});

describe('planProduction: health retry/readiness fields', () => {
  it('carries healthRetries, healthRetryDelayMs, and healthReadinessDelayMs when set', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        health: {
          path: '/up',
          timeoutMs: 5000,
          intervalMs: 30000,
          retries: 10,
          retryDelayMs: 2000,
          readinessDelayMs: 1500,
        },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    assert.equal(plan.healthRetries, 10);
    assert.equal(plan.healthRetryDelayMs, 2000);
    assert.equal(plan.healthReadinessDelayMs, 1500);
  });

  it('leaves healthRetries, healthRetryDelayMs, and healthReadinessDelayMs undefined when unset', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    assert.equal(plan.healthRetries, undefined);
    assert.equal(plan.healthRetryDelayMs, undefined);
    assert.equal(plan.healthReadinessDelayMs, undefined);
  });
});

describe('planProduction: env aliasing and clear flag', () => {
  it('reports alias and clear in ProductionEnvEntry', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        env: {
          DB_USER: { value: secret('DB_USER'), alias: 'DATABASE_USER' },
          PUBLIC_KEY: { value: 'pk_abc123', clear: true },
        },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const user = plan.env.find((e) => e.name === 'DB_USER');
    assert.ok(user !== undefined);
    assert.equal(user.secret, true);
    assert.equal(user.alias, 'DATABASE_USER');
    assert.equal(user.clear, false);

    const pub = plan.env.find((e) => e.name === 'PUBLIC_KEY');
    assert.ok(pub !== undefined);
    assert.equal(pub.secret, false);
    assert.equal(pub.alias, undefined);
    assert.equal(pub.clear, true);
  });

  it('renders an aliased env entry with alias and clear in the plan', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        env: { NODE_ENV: 'production', KEY: { value: secret('SEC'), alias: 'ALIAS', clear: true } },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    assert.deepEqual(plan.env, [
      { name: 'KEY', secret: true, alias: 'ALIAS', clear: true },
      { name: 'NODE_ENV', secret: false, alias: undefined, clear: false },
    ]);
  });
});

describe('planProduction: host volumes', () => {
  it('carries source, options, and host in ProductionVolumeEntry', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        volumes: { uploads: '/host/uploads:/app/uploads:ro', storage: '/app/storage' },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const hostVol = plan.volumes.find((v) => v.name === 'uploads');
    assert.ok(hostVol !== undefined);
    assert.equal(hostVol.source, '/host/uploads');
    assert.equal(hostVol.containerPath, '/app/uploads');
    assert.equal(hostVol.options, 'ro');
    assert.equal(hostVol.host, true);

    const namedVol = plan.volumes.find((v) => v.name === 'storage');
    assert.ok(namedVol !== undefined);
    assert.equal(namedVol.source, 'storage');
    assert.equal(namedVol.containerPath, '/app/storage');
    assert.equal(namedVol.options, undefined);
    assert.equal(namedVol.host, false);
  });

  it('adds -v flags to the run step argv for host volumes', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        volumes: { uploads: '/host/uploads:/app/uploads:ro' },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const run = stepOf(plan, 'run');
    const argv = run?.argv ?? [];
    const vIdx = argv.indexOf('-v');
    assert.ok(vIdx >= 0, 'expected -v flag in run argv');
    assert.equal(argv[vIdx + 1], '/host/uploads:/app/uploads:ro');
  });

  it('omits -v flags when volumes are absent', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const run = stepOf(plan, 'run');
    const argv = run?.argv ?? [];
    assert.ok(!argv.includes('-v'));
  });
});

describe('planProduction: logging args in run argv', () => {
  it('emits --log-driver and sorted --log-opt in the run step argv', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const run = stepOf(plan, 'run');
    assert.ok(run?.argv !== undefined);
    const argv = run?.argv ?? [];

    const driverIdx = argv.indexOf('--log-driver');
    assert.ok(driverIdx >= 0, 'expected --log-driver in run argv');
    assert.equal(argv[driverIdx + 1], 'json-file');

    const maxFileIdx = argv.indexOf('--log-opt');
    assert.ok(maxFileIdx >= 0, 'expected --log-opt in run argv');
    assert.equal(argv[maxFileIdx + 1], 'max-file=3');

    // Options are sorted alphabetically by key.
    const maxSizeIdx = argv.indexOf('max-size=10m');
    assert.ok(maxSizeIdx >= 0, 'expected max-size=10m in run argv');
    assert.ok(maxFileIdx < maxSizeIdx, 'max-file should appear before max-size (sorted by key)');
  });

  it('omits --log-driver and --log-opt when logging is unset', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const run = stepOf(plan, 'run');
    const argv = run?.argv ?? [];
    assert.ok(!argv.includes('--log-driver'));
    assert.ok(!argv.includes('--log-opt'));
  });
});

describe('planProduction: invalid tags and config', () => {
  it('rejects a tag with whitespace or control characters, value-free', () => {
    for (const bad of ['has space', 'line\nbreak', 'tab\tx', 'ctrl\u0001']) {
      const error = capture(() => planProduction(fullConfig(), { imageTag: bad }));
      assert.match(error.message, /image tag/);
      assert.ok(!error.message.includes(bad), `tag ${JSON.stringify(bad)} must not leak`);
    }
  });

  it('rejects an empty tag', () => {
    assert.match(
      capture(() => planProduction(fullConfig(), { imageTag: '' })).message,
      /non-empty/,
    );
  });

  it('rejects an invalid previousTag', () => {
    assert.match(
      capture(() =>
        planProduction(fullConfig(), {
          imageTag: '1.0.0',
          previousTag: 'bad tag',
        }),
      ).message,
      /image tag/,
    );
  });

  it('rejects a config without a production overlay', () => {
    assert.match(
      capture(() =>
        planProduction(normalizeJamalConfig({ service: 'x', image: 'y' }), {
          imageTag: '1.0.0',
        }),
      ).message,
      /production/,
    );
  });
});

describe('planProduction: determinism', () => {
  it('produces a deep-equal plan across calls for identical input', () => {
    const config = fullConfig();
    const first = planProduction(config, {
      imageTag: '1.0.0',
      previousTag: '0.9.0',
    });
    const second = planProduction(config, {
      imageTag: '1.0.0',
      previousTag: '0.9.0',
    });

    assert.deepEqual(first, second);
  });

  it('emits deterministic reminders for the registry and version skew', () => {
    const plan = planProduction(fullConfig(), {
      imageTag: '2.0.0',
      previousTag: '1.0.0',
    });

    assert.deepEqual(plan.warnings, [
      'Sign in to the registry before pushing: docker login ghcr.io.',
      'Rolling forward from ghcr.io/acme/myapp:1.0.0 to ghcr.io/acme/myapp:2.0.0: run any pending ' +
        'migrations before the proxy switch and keep 1.0.0 and 2.0.0 compatible during the cutover.',
    ]);
  });

  it('emits no reminders without a registry or previous tag', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );
    assert.deepEqual(plan.warnings, []);
  });
});

describe('formatProductionPlan: dry-run rendering', () => {
  it('renders image/container headers, kind-first steps, $ argv, and trailing warnings', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });
    const text = formatProductionPlan(plan);
    const lines = text.split('\n');

    assert.equal(lines[0], 'image: ghcr.io/acme/myapp:1.0.0');
    assert.equal(lines[1], 'container: myapp-web-1.0.0');
    assert.equal(lines[2], '');

    // Every step line begins with its kind; argv lines are the indented `$ ...`.
    for (const step of plan.steps) {
      assert.ok(lines.includes(`${step.kind}: ${step.description}`), `missing ${step.kind} line`);
      if (step.argv !== undefined) {
        const quoted = step.argv.map((token) => shellQuote(token)).join(' ');
        assert.ok(text.includes(`\n  $ ${quoted}`), `missing argv for ${step.kind}`);
      }
    }

    // Warnings trail every step, prefixed with `warning: `.
    assert.deepEqual(
      lines.filter((line) => line.startsWith('warning: ')),
      plan.warnings.map((warning) => `warning: ${warning}`),
    );

    // Value-free: no secret reference or credential name leaks into the preview.
    assert.ok(!text.includes('secret('));
    assert.ok(!text.includes('DB_PASSWORD'));
  });
});

// ---------------------------------------------------------------------------
// Cache-proxy deployment topology
// ---------------------------------------------------------------------------

/**
 * A full production config with the cache proxy enabled.
 */
function cacheProxyConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    production: {
      server: '1.2.3.4',
      domain: 'example.com',
    },
    cacheProxy: { enabled: true, image: 'varnish:7.7', size: '512m' },
  });
}

/**
 * A config with the cache proxy present but disabled.
 */
function cacheProxyDisabledConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    production: {
      server: '1.2.3.4',
      domain: 'example.com',
    },
    cacheProxy: { enabled: false },
  });
}

describe('planProduction: cache-proxy step ordering', () => {
  it('inserts cache-proxy steps after health and before switch when enabled', () => {
    const plan = planProduction(cacheProxyConfig(), { imageTag: '1.0.0' });

    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      [
        'network',
        'build',
        'push',
        'pull',
        'run',
        'health',
        'cache-proxy:write-vcl',
        'cache-proxy:boot',
        'cache-proxy:health',
        'switch',
        'stop',
      ],
    );
  });

  it('does NOT insert cache-proxy steps when disabled', () => {
    const plan = planProduction(cacheProxyDisabledConfig(), { imageTag: '1.0.0' });

    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      ['network', 'build', 'push', 'pull', 'run', 'health', 'switch', 'stop'],
    );
  });

  it('does NOT insert cache-proxy steps when cacheProxy is absent', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'ghcr.io/acme/myapp',
        production: { server: '1.2.3.4', domain: 'example.com' },
      }),
      { imageTag: '1.0.0' },
    );

    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      ['network', 'build', 'push', 'pull', 'run', 'health', 'switch', 'stop'],
    );
  });

  it('points the switch target at the cache-proxy container when enabled', () => {
    const plan = planProduction(cacheProxyConfig(), { imageTag: '1.0.0' });
    const switchStep = plan.steps.find((step) => step.kind === 'switch');

    // The proxyDeployArgv must target the cache-proxy container, not the app.
    assert.ok(switchStep?.argv !== undefined, 'switch step must have argv');
    const argv = switchStep.argv;
    const targetIndex = argv.indexOf('--target');
    assert.ok(targetIndex >= 0, 'switch argv must include --target');
    const target = argv[targetIndex + 1];
    assert.equal(target, 'jamal-cache-proxy:6081', 'switch must target the cache-proxy container');
  });

  it('points the switch target at the app container when cache-proxy is disabled', () => {
    const plan = planProduction(cacheProxyDisabledConfig(), { imageTag: '1.0.0' });
    const switchStep = plan.steps.find((step) => step.kind === 'switch');

    assert.ok(switchStep?.argv !== undefined, 'switch step must have argv');
    const argv = switchStep.argv;
    const targetIndex = argv.indexOf('--target');
    assert.ok(targetIndex >= 0, 'switch argv must include --target');
    const target = argv[targetIndex + 1];
    assert.ok(typeof target === 'string', 'target must be a string');
    assert.notEqual(
      target,
      'jamal-cache-proxy',
      'switch must not target cache-proxy when disabled',
    );
    assert.match(target, /^myapp-web-/, 'switch must target the app container when disabled');
  });

  it('writes a VCL file referencing the app container as backend', () => {
    const plan = planProduction(cacheProxyConfig(), { imageTag: 'v1' });
    const vclStep = plan.steps.find((step) => step.kind === 'cache-proxy:write-vcl');

    assert.ok(vclStep?.argv !== undefined, 'write-vcl step must have argv');
    // The sh -c script decodes the base64 VCL positional parameter; the plan
    // argv prepends ['ssh', server], so the script is at index 4.
    const vclScript = vclStep.argv[4] as string;
    assert.ok(vclScript.includes('base64 -d'), 'must decode base64 VCL');
    const vcl = Buffer.from(vclStep.argv[7] ?? '', 'base64').toString('utf8');
    assert.match(vcl, /\.host = "myapp-web-v1";/);
  });

  it('boots the cache-proxy container with custom image and size from config', () => {
    const plan = planProduction(cacheProxyConfig(), { imageTag: '1.0.0' });
    const bootStep = plan.steps.find((step) => step.kind === 'cache-proxy:boot');

    assert.ok(bootStep?.argv !== undefined);
    const dockerIndex = bootStep.argv.indexOf('docker');
    assert.ok(dockerIndex >= 0);
    // The docker run argv includes the custom image.
    const imageIndex = bootStep.argv.indexOf('varnish:7.7');
    assert.ok(imageIndex >= 0, 'boot must use the configured image');
    const sizeIndex = bootStep.argv.indexOf('VARNISH_SIZE=512m');
    assert.ok(sizeIndex >= 0, 'boot must use the configured size');
    // A running Varnish on the configured image reloads the VCL in place.
    assert.match(bootStep.argv[4] ?? '', /docker exec "\$n" varnishreload/);
    assert.deepEqual(bootStep.argv.slice(5, 8), ['sh', 'jamal-cache-proxy', 'varnish:7.7']);
    assert.ok(bootStep.argv.includes('--network'));
  });
});

describe('planProduction: cache-proxy config normalization', () => {
  it('normalizes cacheProxy with defaults when absent', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      production: { server: '1.2.3.4' },
    });
    assert.equal(config.cacheProxy, undefined);
  });

  it('normalizes cacheProxy with defaults when enabled is absent', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      production: { server: '1.2.3.4' },
      cacheProxy: {},
    });
    assert.ok(config.cacheProxy !== undefined);
    assert.equal(config.cacheProxy?.enabled, false);
    assert.equal(config.cacheProxy?.image, 'varnish:7.7');
    assert.equal(config.cacheProxy?.size, '256m');
  });

  it('normalizes cacheProxy with explicit values', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      production: { server: '1.2.3.4' },
      cacheProxy: { enabled: true, image: 'custom:v1', size: '1g' },
    });
    assert.equal(config.cacheProxy?.enabled, true);
    assert.equal(config.cacheProxy?.image, 'custom:v1');
    assert.equal(config.cacheProxy?.size, '1g');
  });

  it('rejects a cacheProxy with an unsafe image value', () => {
    const error = capture(() =>
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
        cacheProxy: { image: 'has space' },
      }),
    );
    assert.match(error.message, /must not contain whitespace/);
  });

  it('normalizes a cookie allowlist', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      production: { server: '1.2.3.4' },
      cacheProxy: { enabled: true, cookieAllowlist: ['session_id', 'theme'] },
    });
    assert.deepEqual(config.cacheProxy?.cookieAllowlist, ['session_id', 'theme']);
  });

  it('defaults cookieAllowlist to undefined when absent', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      production: { server: '1.2.3.4' },
      cacheProxy: { enabled: true },
    });
    assert.equal(config.cacheProxy?.cookieAllowlist, undefined);
  });

  it('rejects a cookieAllowlist entry with whitespace', () => {
    const error = capture(() =>
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
        cacheProxy: { cookieAllowlist: ['has space'] },
      }),
    );
    assert.match(error.message, /cacheProxy\.cookieAllowlist/);
  });
});

describe('planProduction: volumes and command in production', () => {
  it('maps a $PWD/ host source to a path relative to the deploy user home', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        volumes: { data: '$PWD/data:/app/data' },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );
    assert.ok(stepOf(plan, 'run')?.argv?.includes('./data:/app/data'));
  });

  it('splits a quoted command into argv tokens after the image', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        command: 'node -e "console.log(1 + 1)"',
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );
    const argv = stepOf(plan, 'run')?.argv ?? [];
    assert.deepEqual(argv.slice(argv.indexOf('img:1.0.0')), [
      'img:1.0.0',
      'node',
      '-e',
      'console.log(1 + 1)',
    ]);
  });

  it('refuses a database accessory without a DATABASE_PASSWORD entry', () => {
    const error = capture(() =>
      planProduction(
        normalizeJamalConfig({
          service: 'myapp',
          image: 'img',
          services: { db: { type: 'postgres' } },
          production: { server: '1.2.3.4' },
        }),
        { imageTag: '1.0.0' },
      ),
    );
    assert.match(error.message, /DATABASE_PASSWORD/);
  });
});

/**
 * Run a step's remote argv through a real `sh` with a fake `docker` on PATH.
 * The fake logs each call and answers from `script` (a shell `case` body over
 * "$*"); the log is returned one call per line.
 */
function runWithFakeDocker(step: ProductionStep | undefined, script: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'jamal-docker-'));
  try {
    const log = join(dir, 'calls.log');
    const docker = join(dir, 'docker');
    writeFileSync(
      docker,
      `#!/bin/sh\necho "$*" >> ${shellQuote(log)}\ncase "$*" in\n${script}\nesac\nexit 0\n`,
    );
    chmodSync(docker, 0o755);
    writeFileSync(log, '');
    spawnSync('sh', ['-c', remoteCommandLine(step?.argv?.slice(2) ?? [])], {
      cwd: dir,
      env: { PATH: `${dir}:${process.env.PATH ?? ''}` },
    });
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('planProduction: remote scripts through a real shell', () => {
  it('never force-removes a running container whose name the run conflicts with', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });
    // `docker rm` of a running container fails, and so does the run.
    const calls = runWithFakeDocker(stepOf(plan, 'run'), '"rm "*) exit 1 ;;\n"run "*) exit 125 ;;');
    assert.deepEqual(
      calls.map((call) => call.split(' ').slice(0, 2).join(' ')),
      ['rm myapp-web-1.0.0', 'run -d', 'rm myapp-web-1.0.0'],
    );
    assert.ok(!calls.some((call) => call.includes('-f')));
  });

  it('reloads a running cache proxy in place instead of replacing it', () => {
    const plan = planProduction(cacheProxyConfig(), { imageTag: '1.0.0' });
    const calls = runWithFakeDocker(
      stepOf(plan, 'cache-proxy:boot'),
      '"inspect "*) echo "true varnish:7.7" ;;',
    );
    assert.deepEqual(calls.slice(1), ['exec jamal-cache-proxy varnishreload']);
  });

  it('boots the cache proxy when it is missing', () => {
    const plan = planProduction(cacheProxyConfig(), { imageTag: '1.0.0' });
    const calls = runWithFakeDocker(stepOf(plan, 'cache-proxy:boot'), '"inspect "*) exit 1 ;;');
    assert.equal(calls[1], 'rm -f jamal-cache-proxy');
    assert.match(calls[2] ?? '', /^run -d .*varnish:7\.7$/);
  });
});
