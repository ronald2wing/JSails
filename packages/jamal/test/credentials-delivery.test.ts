/**
 * Tests for the credentials key ring jamal delivers to the deployed app: added
 * to the app's secret channel when the deployment's environment has sealed
 * credentials, nowhere else (no argv, no output, no accessory), refused when
 * the ring is unavailable or belongs to another environment than the
 * container's, and reserved in the secrets files, `config.env`, and the
 * `jamal secrets` verbs.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { KeyRing } from 'jsails/internal';

import { runJamalCommand, type JamalDeps } from '../src/command.js';
import {
  JamalConfigError,
  normalizeJamalConfig,
  secret,
  type JamalConfigInput,
} from '../src/config/index.js';
import {
  containerEnvironmentOf,
  CredentialsDeliveryErrors,
  deliversCredentialsKey,
  withCredentialsKey,
  type DeploymentCredentials,
} from '../src/credentials-delivery.js';
import { resolveJamalEnv, type ResolvedEnv } from '../src/env-resolve.js';
import { decodeRemoteOp, remoteOpArgv } from '../src/production/remote-op.js';
import { SecretsFileErrors } from '../src/production/secrets-file.js';
import { JamalSecretsError, loadJamalSecrets, requireSecret } from '../src/secrets.js';
import type { RemoteRunner } from '../src/production/transport.js';
import { FakeHost, isMutatingOp } from '../src/testing/fake-host.js';
import { createLocalDocker, FakeRegistry } from '../src/testing/fake-registry.js';

/** A rotating ring of two keys; its variable form is what must not leak. */
const RING = KeyRing.generate().withNewKey();
const KEY = RING.toVariable();
const SEALED: DeploymentCredentials = { status: 'sealed', environment: 'production', ring: RING };
const DB_PASSWORD = 'db-password-value';

const serverVerb = {
  skip: process.platform === 'win32' && 'a server-facing jamal verb, which Windows refuses',
};

const root = mkdtempSync(join(tmpdir(), 'jamal-credentials-key-'));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

function config(extra: Partial<JamalConfigInput> = {}) {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    env: { DATABASE_PASSWORD: secret('DATABASE_PASSWORD'), LOG_LEVEL: 'info' },
    services: { db: { type: 'mariadb' } },
    production: { server: '1.2.3.4' },
    ...extra,
  });
}

const SECRETS = { values: { DATABASE_PASSWORD: DB_PASSWORD }, files: [] };

describe('withCredentialsKey', () => {
  const env = resolveJamalEnv(config(), SECRETS);

  it('adds the whole ring to the secret channel, sorted, and to the secrets file', () => {
    const delivered = withCredentialsKey(env, SEALED);
    assert.deepEqual(
      delivered.secret.map((entry) => entry.name),
      ['DATABASE_PASSWORD', 'JSAILS_CREDENTIALS_KEY'],
    );
    assert.deepEqual(secretsOf(delivered), {
      DATABASE_PASSWORD: DB_PASSWORD,
      JSAILS_CREDENTIALS_KEY: KEY,
    });
    assert.match(KEY, /^[A-Za-z0-9_-]{43},[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(delivered.clear, env.clear);
    assert.ok(!delivered.clear.some((entry) => entry.value === KEY));
    assert.equal(deliversCredentialsKey(SEALED), true);
  });

  it('delivers nothing without sealed credentials or without a deployment bootstrap', () => {
    for (const credentials of [{ status: 'none' } as const, undefined]) {
      assert.equal(withCredentialsKey(env, credentials), env);
      assert.equal(deliversCredentialsKey(credentials), false);
    }
  });

  it('refuses sealed credentials whose ring this process does not hold, value-free', () => {
    assert.throws(
      () => withCredentialsKey(env, { status: 'unavailable', environment: 'production' }),
      (error: unknown) =>
        CredentialsDeliveryErrors.is(error) &&
        error.code === 'jamal_credentials.credentials_key_unavailable' &&
        /^config\/credentials\/production\.enc is sealed/.test(error.message),
    );
  });

  it('refuses a ring for another environment than the one the container runs as', () => {
    const staging: DeploymentCredentials = { status: 'sealed', environment: 'staging', ring: RING };
    assert.throws(
      () => withCredentialsKey(env, staging),
      (error: unknown) =>
        CredentialsDeliveryErrors.is(error) &&
        error.code === 'jamal_credentials.environment_mismatch' &&
        !error.message.includes(KEY),
    );
    const stagingEnv = resolveJamalEnv(
      config({
        env: { DATABASE_PASSWORD: secret('DATABASE_PASSWORD'), JSAILS_ENV: 'staging' },
      }),
      SECRETS,
    );
    assert.equal(secretsOf(withCredentialsKey(stagingEnv, staging)).JSAILS_CREDENTIALS_KEY, KEY);
    assert.throws(
      () => withCredentialsKey(stagingEnv, SEALED),
      (error: unknown) => CredentialsDeliveryErrors.is(error, 'environment_mismatch'),
    );
  });

  it('judges the container by its clear JSAILS_ENV, a secret reference opted onto the command line included', () => {
    const staging: DeploymentCredentials = { status: 'sealed', environment: 'staging', ring: RING };
    const clearRef = resolveJamalEnv(
      config({ env: { JSAILS_ENV: { value: secret('DEPLOY_ENVIRONMENT'), clear: true } } }),
      { values: { DEPLOY_ENVIRONMENT: 'staging' }, files: [] },
    );
    assert.equal(secretsOf(withCredentialsKey(clearRef, staging)).JSAILS_CREDENTIALS_KEY, KEY);
    // The release's `-e JSAILS_ENV=production` beats a value in the secrets
    // file; the config refuses one there (`config/safety.ts`), the judgement
    // ignores it all the same, and the secrets file refuses to carry it.
    const inSecretsFile = {
      clear: [],
      secret: [{ name: 'JSAILS_ENV', value: 'staging', secret: true }],
      secretsFile: Buffer.from('{"v":1,"values":{"JSAILS_ENV":"staging"}}\n'),
    };
    assert.throws(
      () => withCredentialsKey(inSecretsFile, staging),
      (error: unknown) => CredentialsDeliveryErrors.is(error, 'environment_mismatch'),
    );
    assert.throws(
      () => withCredentialsKey(inSecretsFile, SEALED),
      (error: unknown) => SecretsFileErrors.is(error, 'reserved_key'),
    );
  });

  it('refuses a clear secret JSAILS_ENV that resolves to no environment name, value-free', () => {
    const bad = 'not a name; rm -rf /';
    const clearRef = resolveJamalEnv(
      config({ env: { JSAILS_ENV: { value: secret('DEPLOY_ENVIRONMENT'), clear: true } } }),
      { values: { DEPLOY_ENVIRONMENT: bad }, files: [] },
    );
    assert.throws(
      () => containerEnvironmentOf(clearRef),
      (error: unknown) =>
        error instanceof JamalConfigError &&
        /JSAILS_ENV resolved to a value that is not an environment name/.test(error.message) &&
        !error.message.includes(bad),
    );
    assert.throws(() => withCredentialsKey(clearRef, SEALED), JamalConfigError);
  });
});

interface Recorded {
  /** The argv, a fenced command's inner one. */
  readonly argv: readonly string[];
  /** The stdin, without a fenced command's token line. */
  readonly stdin: Buffer | undefined;
}

/** The values of a resolved env's secrets file. */
function secretsOf(env: ResolvedEnv): Record<string, string> {
  return (
    JSON.parse(Buffer.from(env.secretsFile).toString('utf8')) as { values: Record<string, string> }
  ).values;
}

/** The path of every release's app secrets file. */
const APP_SECRETS = /^\.jamal\/apps\/myapp\/releases\/[^/]+\/secrets\/secrets\.json$/;

/**
 * A project whose deploys reach a modelled server: a FakeHost answers every
 * remote command, a modelled local Docker builds and pushes, and each remote
 * call is recorded with its stdin.
 */
function harness(credentials: DeploymentCredentials | undefined) {
  const cwd = join(root, `project-${seq++}`);
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'Dockerfile'), 'FROM scratch\n');
  const out: string[] = [];
  const err: string[] = [];
  const calls: Recorded[] = [];
  const local: string[][] = [];
  const registry = new FakeRegistry();
  const host = new FakeHost({ registry });
  const client = host.connect('a');
  let builds = 0;
  const docker = createLocalDocker({
    registry,
    context: () => ({ content: `tree ${(builds += 1)}`, behaviour: { healthy: true } }),
  });
  let clock = Date.parse('2026-11-23T10:00:00.000Z');
  const remote: RemoteRunner = {
    async run(server, remoteArgv, options) {
      const given = typeof options === 'string' ? options : options?.stdin;
      let stdin = given === undefined ? undefined : Buffer.from(given);
      const decoded = decodeRemoteOp(remoteArgv);
      let argv: readonly string[] = remoteArgv;
      if (decoded?.kind === 'fenced') {
        argv = remoteOpArgv(decoded.op);
        stdin = stdin?.subarray(stdin.indexOf(0x0a) + 1);
      }
      calls.push({ argv: [...argv], stdin });
      return client.run(server, remoteArgv, options);
    },
  };
  const deps: JamalDeps = {
    cwd,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    loadJamalConfig: async () => config(),
    readGitState: async () => ({ sha: 'a'.repeat(40), dirty: false }),
    now: () => new Date((clock += 1000)),
    processRunner: async (argv, runOptions) => {
      local.push([...argv]);
      return docker.runner(argv, runOptions);
    },
    remoteRunner: remote,
    healthCheck: async () => {},
    loadSecrets: () => SECRETS,
    ...(credentials === undefined ? {} : { deploymentCredentials: credentials }),
  };
  return { deps, out, err, calls, local, host };
}

/** The writes of a run, as `[path, payload]`: the stdin after the integrity header. */
function writes(calls: readonly Recorded[]): (readonly [string, string])[] {
  return calls.flatMap((entry) => {
    const op = decodeRemoteOp(entry.argv);
    if (op?.kind !== 'file.write' || entry.stdin === undefined) return [];
    const payload = entry.stdin.subarray(entry.stdin.indexOf(0x0a) + 1).toString('utf8');
    return [[op.path, payload] as const];
  });
}

/** The payload written to `path` on the server. */
function written(calls: readonly Recorded[], path: string): string | undefined {
  return writes(calls).find(([target]) => target === path)?.[1];
}

/** The values of the app secrets file a deploy wrote. */
function appSecrets(calls: readonly Recorded[]): Record<string, string> | undefined {
  const text = writes(calls).find(([target]) => APP_SECRETS.test(target))?.[1];
  return text === undefined
    ? undefined
    : (JSON.parse(text) as { values: Record<string, string> }).values;
}

/** Assert the key appears in no argv, local or remote, and in no output line. */
function assertNowhereElse(h: ReturnType<typeof harness>): void {
  for (const call of h.calls) assert.ok(!call.argv.join(' ').includes(KEY), call.argv.join(' '));
  for (const argv of h.local) assert.ok(!argv.join(' ').includes(KEY));
  assert.ok(![...h.out, ...h.err].join('\n').includes(KEY));
}

describe('jamal deploy: the credentials key', serverVerb, () => {
  it('writes the key into the release secrets file only, never an accessory env file, argv, or output', async () => {
    const h = harness(SEALED);
    assert.equal(await runJamalCommand(['deploy'], h.deps), 0, h.err.join('\n'));

    assert.deepEqual(appSecrets(h.calls), {
      DATABASE_PASSWORD: DB_PASSWORD,
      JSAILS_CREDENTIALS_KEY: KEY,
    });
    const accessory = written(h.calls, '.jamal/apps/myapp/accessories/db.env');
    assert.ok(accessory?.includes(DB_PASSWORD));
    assert.ok(!accessory?.includes(KEY));
    assert.ok(!accessory?.includes('JSAILS_CREDENTIALS_KEY'));
    // The manifest names the variables the file holds, never a value.
    const manifest = writes(h.calls).find(([target]) => target.endsWith('/manifest.json'))?.[1];
    assert.ok(manifest !== undefined && !manifest.includes(KEY));
    assert.deepEqual((JSON.parse(manifest) as { secretNames: string[] }).secretNames, [
      'DATABASE_PASSWORD',
      'JSAILS_CREDENTIALS_KEY',
    ]);
    assertNowhereElse(h);
  });

  it('a rollback writes no secrets file: the release keeps the key it was deployed with', async () => {
    const h = harness(SEALED);
    assert.equal(await runJamalCommand(['deploy'], h.deps), 0, h.err.join('\n'));
    const first = Object.keys(h.host.fs.snapshot('.jamal/apps/myapp/releases').files).find((path) =>
      path.endsWith('/secrets/secrets.json'),
    );
    assert.equal(await runJamalCommand(['deploy'], h.deps), 0, h.err.join('\n'));
    const from = h.calls.length;
    assert.equal(await runJamalCommand(['rollback'], h.deps), 0, h.err.join('\n'));
    assert.equal(appSecrets(h.calls.slice(from)), undefined);
    const kept = h.host.fs.file(`.jamal/apps/myapp/releases/${first}`)?.data.toString('utf8');
    assert.ok(kept?.includes(KEY));
    assertNowhereElse(h);
  });

  it('plans the delivery without printing the key or changing the server', async () => {
    const h = harness(SEALED);
    assert.equal(await runJamalCommand(['deploy', '--dry-run'], h.deps), 0, h.err.join('\n'));
    assert.match(h.out.join('\n'), /Write the release's secrets file \(2 entries\)/);
    for (const call of h.calls) {
      const op = decodeRemoteOp(call.argv);
      assert.ok(op !== undefined && !isMutatingOp(op), call.argv.slice(0, 2).join(' '));
    }
    assert.equal(h.local.length, 0, 'a dry run builds nothing');
    assertNowhereElse(h);
  });

  it('delivers nothing when the environment has no sealed credentials', async () => {
    for (const credentials of [{ status: 'none' } as const, undefined]) {
      const h = harness(credentials);
      assert.equal(await runJamalCommand(['deploy'], h.deps), 0, h.err.join('\n'));
      assert.deepEqual(appSecrets(h.calls), { DATABASE_PASSWORD: DB_PASSWORD });
    }
  });

  it('refuses before touching the server when the sealed key is unavailable', async () => {
    const h = harness({ status: 'unavailable', environment: 'production' });
    assert.equal(await runJamalCommand(['deploy'], h.deps), 1);
    assert.equal(h.calls.length, 0);
    assert.match(h.err.join('\n'), /^jamal: config\/credentials\/production\.enc is sealed, but /);
  });

  it('never hands the key to an accessory booted on its own', async () => {
    const h = harness(SEALED);
    assert.equal(await runJamalCommand(['accessory', 'boot', 'db'], h.deps), 0, h.err.join('\n'));
    const accessory = written(h.calls, '.jamal/apps/myapp/accessories/db.env');
    assert.ok(accessory?.includes(DB_PASSWORD));
    assert.ok(!accessory?.includes(KEY));
    assertNowhereElse(h);
  });
});

describe('the credentials key is reserved', () => {
  it('refuses a secrets file that defines it before any of its commands run', () => {
    const dir = join(root, `secrets-${seq++}`);
    mkdirSync(join(dir, '.jamal'), { recursive: true });
    writeFileSync(
      join(dir, '.jamal', 'secrets-common'),
      'EARLIER=$(echo earlier)\nJSAILS_CREDENTIALS_KEY=$(cat config/credentials/production.key)\n',
    );
    const ran: string[] = [];
    assert.throws(
      () =>
        loadJamalSecrets({
          rootDir: dir,
          runCommand: (command) => {
            ran.push(command);
            return 'value';
          },
        }),
      (error: unknown) =>
        error instanceof JamalSecretsError &&
        error.code === 'reserved_secret' &&
        /jamal deploy delivers the credentials key/.test(error.message),
    );
    assert.deepEqual(ran, []);
  });

  it('refuses to resolve it by name', () => {
    assert.throws(
      () => requireSecret({ values: {}, files: [] }, 'JSAILS_CREDENTIALS_KEY'),
      (error: unknown) => error instanceof JamalSecretsError && error.code === 'reserved_secret',
    );
  });

  it('refuses config.env entries that name it as a variable, an alias, or a secret', () => {
    const entries: NonNullable<JamalConfigInput['env']>[] = [
      { JSAILS_CREDENTIALS_KEY: secret('CREDENTIALS') },
      { JSAILS_CREDENTIALS_KEY: 'literal' },
      { KEY: { value: secret('CREDENTIALS'), alias: 'JSAILS_CREDENTIALS_KEY' } },
      { KEY: secret('JSAILS_CREDENTIALS_KEY') },
      { KEY: { value: secret('JSAILS_CREDENTIALS_KEY'), clear: true } },
    ];
    for (const env of entries) {
      assert.throws(
        () => config({ env }),
        (error: unknown) =>
          error instanceof JamalConfigError &&
          /must not name JSAILS_CREDENTIALS_KEY: jamal deploy delivers/.test(error.message),
        JSON.stringify(Object.keys(env)),
      );
    }
  });
});

describe('jamal secrets and the credentials key', serverVerb, () => {
  it('print lists the delivered key by name only, after the file entries', async () => {
    const h = harness(SEALED);
    assert.equal(await runJamalCommand(['secrets', 'print'], h.deps), 0, h.err.join('\n'));
    assert.deepEqual(h.out, [
      'DATABASE_PASSWORD',
      'JSAILS_CREDENTIALS_KEY  (delivered by jamal deploy from the sealed credentials)',
    ]);
    assertNowhereElse(h);

    const none = harness({ status: 'none' });
    assert.equal(await runJamalCommand(['secrets', 'print'], none.deps), 0);
    assert.deepEqual(none.out, ['DATABASE_PASSWORD']);
  });

  it('fetch and extract refuse it, value-free', async () => {
    for (const args of [
      ['secrets', 'fetch', 'JSAILS_CREDENTIALS_KEY'],
      ['secrets', 'extract', 'JSAILS_CREDENTIALS_KEY/x'],
    ]) {
      const h = harness(SEALED);
      assert.equal(await runJamalCommand(args, h.deps), 1, args.join(' '));
      assert.deepEqual(h.out, []);
      assert.match(
        h.err.join('\n'),
        /^jamal: reserved_secret: JSAILS_CREDENTIALS_KEY is not a deploy secret/,
      );
      assertNowhereElse(h);
    }
  });
});
