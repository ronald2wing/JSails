/**
 * Tests for `scripts/verify-integrations.mjs` that need no live service.
 *
 * The jobs and cache stages run their workspace's suite through the
 * reconciling runner with its live files enabled and the `valkey` service
 * declared, which is what makes the Valkey-scoped entries of
 * `scripts/expected-failures/jobs.json` apply.
 *
 * The jamal stage (`scripts/verify-integrations/jamal.mjs`) is gated on
 * `JSAILS_TEST_DOCKER`, fails when enabled without Docker, and rewrites the
 * generated app's files through pure functions tested here against the real
 * starter templates, so a template change the stage cannot follow fails in
 * this suite rather than only in a Docker run.
 *
 * The jamal-secrets stage (`scripts/verify-integrations/jamal-secrets.mjs`)
 * shares that gate; its naming and comparison helpers are tested here, and so
 * is the harness's `--require`/`--only` parsing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { applies, declaredServices, readLedgers } from '../expected-failures.mjs';
import { STAGES, stageOptions, valkeySuiteRun } from '../verify-integrations.mjs';
import {
  containerPrefix,
  mismatchedNames,
  runJamalSecretsStage,
  STAGE_SECRETS,
} from '../verify-integrations/jamal-secrets.mjs';
import {
  appEnvironment,
  capture,
  composeProjectName,
  describeLeftovers,
  dotenvKeys,
  fillDotenv,
  jamalService,
  reportedRemovals,
  retargetJamalPorts,
  runJamalStage,
  serviceHealthProblems,
} from '../verify-integrations/jamal.mjs';
import { repoRoot } from '../workspaces.mjs';

const URL = 'redis://127.0.0.1:6379';

describe('valkeySuiteRun', () => {
  it('runs a workspace through run-tests with its live files enabled', () => {
    const run = valkeySuiteRun('jobs', { PATH: '/bin' }, URL);
    assert.equal(run.command, process.execPath);
    assert.deepEqual(run.args, [join(repoRoot, 'scripts', 'run-tests.mjs')]);
    assert.equal(run.cwd, join(repoRoot, 'packages', 'jobs'));
    assert.equal(valkeySuiteRun('cache', {}, URL).cwd, join(repoRoot, 'packages', 'cache'));
    assert.equal(run.env.PATH, '/bin');
    assert.equal(run.env.VALKEY_URL, URL);
    assert.equal(run.env.JSAILS_TEST_VALKEY, '1');
    assert.deepEqual(declaredServices(run.env.JSAILS_TEST_SERVICES), ['valkey']);
  });

  it('adds valkey to services the caller already declared, once, without changing its env', () => {
    const env = { JSAILS_TEST_SERVICES: 'valkey' };
    assert.equal(valkeySuiteRun('jobs', env, URL).env.JSAILS_TEST_SERVICES, 'valkey');
    assert.deepEqual(env, { JSAILS_TEST_SERVICES: 'valkey' });
  });

  it('declares what the Valkey-scoped jobs entries need, and they apply only then', () => {
    const scoped = readLedgers()
      .filter((ledger) => ledger.name === 'jobs')
      .flatMap((ledger) => ledger.entries)
      .filter((entry) => entry.services !== undefined);
    assert.ok(scoped.length > 0, 'jobs.json lists Valkey-scoped entries');
    const services = declaredServices(valkeySuiteRun('jobs', {}, URL).env.JSAILS_TEST_SERVICES);
    for (const entry of scoped) {
      assert.match(entry.file, /^packages\/jobs\/test\//);
      assert.equal(applies(entry, { platform: 'linux', database: 'sqlite', services }), true);
      assert.equal(applies(entry, { platform: 'linux', database: 'sqlite', services: [] }), false);
    }
  });
});

const TEMPLATES = join(repoRoot, 'core', 'templates', 'starter-web');
const readTemplate = (name) => readFileSync(join(TEMPLATES, name), 'utf8');

describe('jamal stage', () => {
  it('skips unless JSAILS_TEST_DOCKER is "1", without asking Docker', async () => {
    const result = await runJamalStage({ PATH: '' });
    assert.deepEqual(result, {
      stage: 'jamal',
      status: 'skipped',
      detail: 'JSAILS_TEST_DOCKER is not "1"',
    });
  });

  it('fails once enabled when Docker cannot be reached', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'jamal-stage-'));
    try {
      const result = await runJamalStage({ JSAILS_TEST_DOCKER: '1', PATH: empty });
      assert.deepEqual(result, {
        stage: 'jamal',
        status: 'failed',
        detail: 'the docker daemon is unavailable',
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('names a fresh lowercase prefix per run, valid for a Compose project', () => {
    assert.equal(composeProjectName({}, 42, 'abcd0123'), 'jsails-verify-jamal-42-abcd0123');
    assert.equal(
      composeProjectName({ JSAILS_TEST_DOCKER_PREFIX: 'jsails-m3w2-int' }, 7, 'ff'),
      'jsails-m3w2-int-7-ff',
    );
    assert.notEqual(composeProjectName(), composeProjectName());
    assert.match(`${composeProjectName()}-a`, /^[a-z0-9][a-z0-9_-]{0,62}$/);
    const longest = composeProjectName({ JSAILS_TEST_DOCKER_PREFIX: 'a'.repeat(41) }, 4194304);
    assert.match(`${longest}-a`, /^[a-z0-9][a-z0-9_-]{0,62}$/);
    for (const bad of ['Bad Name', 'dotted.name', '-leading', 'a'.repeat(42)]) {
      assert.throws(() => composeProjectName({ JSAILS_TEST_DOCKER_PREFIX: bad }));
    }
  });

  it('reads the one service line create writes into the --admin template', () => {
    const template = readTemplate('jamal.config.ts.template');
    assert.equal(jamalService(template), '__JSAILS_JAMAL_SERVICE__');
    assert.equal(jamalService("  service: 'shop',\n"), 'shop');
    assert.equal(jamalService('export default {};\n'), undefined);
    assert.equal(jamalService("  service: 'a',\n  service: 'b',\n"), undefined);
  });

  it("retargets the --admin template's ports and nothing else", () => {
    const template = readTemplate('jamal.config.ts.template');
    const out = retargetJamalPorts(template, { db: 40001, valkey: 40002 });
    assert.match(out, /^ {4}ports: \{ db: 40001, valkey: 40002 \},$/m);
    const changed = out.split('\n').filter((line, index) => line !== template.split('\n')[index]);
    assert.equal(changed.length, 1);
    assert.equal(jamalService(out), jamalService(template));
  });

  it('refuses a config whose ports line it cannot find exactly once', () => {
    assert.throws(
      () => retargetJamalPorts('export default {};\n', { db: 1, valkey: 2 }),
      /exactly one line/,
    );
  });

  it('reads the volumes down --volumes reported removing', () => {
    assert.deepEqual(
      reportedRemovals(
        'jamal: removed volume p_valkey-data\njamal: removed volume p_mariadb-data\nother\n',
      ),
      ['p_mariadb-data', 'p_valkey-data'],
    );
    assert.deepEqual(reportedRemovals('jamal: the project "p" has no volumes to remove\n'), []);
  });

  it('fills the committed .env example the way the guide says', () => {
    const example = readTemplate('.env.auth.example.template');
    const out = fillDotenv(example, {
      DATABASE_HOST: '127.0.0.1',
      DATABASE_PORT: '40001',
      DATABASE_PASSWORD: 'pw',
      VALKEY_URL: 'redis://127.0.0.1:40002',
    });
    assert.match(out, /^DATABASE_HOST=127\.0\.0\.1$/m);
    assert.match(out, /^DATABASE_PORT=40001$/m);
    assert.doesNotMatch(out, /^#DATABASE_PORT=/m);
    assert.match(out, /^DATABASE_PASSWORD=pw$/m);
    assert.ok(out.endsWith('\nVALKEY_URL=redis://127.0.0.1:40002\n'));
    assert.equal(out.match(/^DATABASE_HOST=/gm)?.length, 1);
  });

  it('names every variable a dotenv text assigns, and no commented-out one', () => {
    const out = fillDotenv(readTemplate('.env.auth.example.template'), {
      DATABASE_PORT: '40001',
      VALKEY_URL: 'redis://127.0.0.1:40002',
    });
    const keys = dotenvKeys(out);
    for (const key of ['BETTER_AUTH_SECRET', 'DATABASE_HOST', 'DATABASE_PORT', 'VALKEY_URL']) {
      assert.ok(keys.includes(key), key);
    }
    assert.ok(!keys.includes('BETTER_AUTH_URL'));
    assert.ok(!keys.includes('S3_BUCKET'));
  });

  it(
    'kills the whole process group of a verb that outlives its timeout',
    { skip: process.platform === 'win32' && 'process groups are POSIX' },
    async () => {
      // The shell stands in for the Node CLI and `sleep` for its `docker compose`
      // child: killing only the shell would leave `sleep` running.
      const started = Date.now();
      const result = await capture('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], {
        cwd: tmpdir(),
        env: process.env,
        timeoutMs: 500,
      });
      assert.equal(result.code, null);
      assert.match(result.stderr, /timed out after 500 ms/);
      assert.ok(Date.now() - started < 10_000);
      const grandchild = Number(result.stdout.trim());
      assert.ok(Number.isInteger(grandchild) && grandchild > 0, result.stdout);
      const deadline = Date.now() + 5_000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(grandchild, 0);
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch (error) {
          assert.equal(error.code, 'ESRCH');
          alive = false;
        }
      }
      assert.equal(alive, false, 'the grandchild outlived the timeout');
    },
  );

  it("runs the app's commands without the variables that would beat its .env", () => {
    const env = appEnvironment(
      {
        PATH: '/bin',
        DOCKER_HOST: 'unix:///run/docker.sock',
        NODE_ENV: 'test',
        COMPOSE_PROJECT_NAME: 'other',
        DATABASE_HOST: 'db.example',
        UNRELATED: '1',
      },
      ['DATABASE_HOST'],
    );
    assert.deepEqual(env, {
      PATH: '/bin',
      DOCKER_HOST: 'unix:///run/docker.sock',
      UNRELATED: '1',
    });
  });

  it('requires exactly the db and valkey services, each running and healthy', () => {
    assert.deepEqual(
      serviceHealthProblems(['db running healthy', 'valkey running healthy', '']),
      [],
    );
    assert.deepEqual(serviceHealthProblems(['db running starting', 'mailpit running healthy']), [
      'db: running/starting',
      'valkey: no container',
      'mailpit: unexpected container',
    ]);
    assert.deepEqual(serviceHealthProblems(['db exited']), [
      'db: exited/no healthcheck',
      'valkey: no container',
    ]);
  });

  it('describes leftovers by count, and an unanswered query as such', () => {
    assert.equal(describeLeftovers({ containers: [], networks: [], volumes: [] }), null);
    assert.equal(
      describeLeftovers({ containers: ['a'], networks: null, volumes: ['v1', 'v2'] }),
      '1 containers, networks: docker did not answer, 2 volumes',
    );
  });

  it('is required by the CI integrations job, which enables it', () => {
    const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const start = workflow.indexOf('\n  integrations:\n');
    assert.notEqual(start, -1);
    const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    const job = workflow.slice(start, next === -1 ? undefined : start + 1 + next);
    assert.match(job, /JSAILS_TEST_DOCKER: '1'/);
    const required = job.match(/npm run verify:integrations -- --require (\S+)/)?.[1].split(',');
    assert.ok(required?.includes('jamal'), 'the integrations job requires the jamal stage');
    assert.ok(
      required?.includes('jamal-secrets'),
      'the integrations job requires the jamal-secrets stage',
    );
    assert.ok(required?.includes('cache'), 'the integrations job requires the cache stage');
  });
});

describe('stage options', () => {
  it('runs every stage and requires none by default', () => {
    assert.deepEqual(stageOptions([]), { required: [], only: [...STAGES] });
  });

  it('runs only the named stages, and requires among them', () => {
    assert.deepEqual(stageOptions(['--only', 'jamal-secrets', '--require', 'jamal-secrets']), {
      required: ['jamal-secrets'],
      only: ['jamal-secrets'],
    });
  });

  it('refuses an unknown stage, an empty list, a required stage left out, and another flag', () => {
    for (const args of [
      ['--require', 'nope'],
      ['--only', ' , '],
      ['--only', 'jamal', '--require', 'jamal-secrets'],
      ['--verbose'],
    ]) {
      assert.ok('error' in stageOptions(args), args.join(' '));
    }
  });
});

describe('jamal-secrets stage', () => {
  it('skips unless JSAILS_TEST_DOCKER is "1", without asking Docker', async () => {
    assert.deepEqual(await runJamalSecretsStage({ PATH: '' }), {
      stage: 'jamal-secrets',
      status: 'skipped',
      detail: 'JSAILS_TEST_DOCKER is not "1"',
    });
  });

  it(
    'fails once enabled when Docker cannot be reached',
    { skip: process.platform === 'win32' && 'the stage skips on Windows' },
    async () => {
      const empty = mkdtempSync(join(tmpdir(), 'jamal-secrets-stage-'));
      try {
        const result = await runJamalSecretsStage({ JSAILS_TEST_DOCKER: '1', PATH: empty });
        assert.deepEqual(result, {
          stage: 'jamal-secrets',
          status: 'failed',
          detail: 'the docker daemon is unavailable',
        });
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    },
  );

  it('names its containers after the prefix variable, fresh per run', () => {
    assert.equal(containerPrefix({}, 42, 'abcd0123'), 'jsails-verify-secrets-42-abcd0123');
    assert.equal(
      containerPrefix({ JSAILS_TEST_DOCKER_PREFIX: 'jsails-m3w2-job11' }, 7, 'ff'),
      'jsails-m3w2-job11-7-ff',
    );
    assert.notEqual(containerPrefix({}), containerPrefix({}));
    assert.throws(() => containerPrefix({ JSAILS_TEST_DOCKER_PREFIX: 'Bad Name' }));
  });

  it('names the values that differ, never their contents', () => {
    assert.deepEqual(mismatchedNames({ A: '1', B: '2' }, { A: '1', B: '3', C: '' }), ['B', 'C']);
    assert.deepEqual(mismatchedNames(STAGE_SECRETS, { ...STAGE_SECRETS }), []);
  });

  it('carries what a Docker env file cannot: a newline, a carriage return, a line over 64 KiB', () => {
    const values = Object.values(STAGE_SECRETS);
    assert.ok(values.some((value) => value.includes('\n')));
    assert.ok(values.some((value) => value.includes('\r')));
    assert.ok(values.some((value) => Buffer.byteLength(value) > 64 * 1024));
  });
});
