/**
 * Tests for the production planner: the exact step list `planRelease` and
 * `planRollback` give for each host they can observe (an empty host, one live
 * release, stale containers, a dead release, a same-commit redeploy, and
 * every point a run can be killed between the proxy switch and the state
 * write), what `reconcile` makes of each of those points, and the argv,
 * environment, volume, and file shapes of the steps. The planner is pure, so
 * every host is a hand-built observation.
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
import { CACHE_PROXY_IMAGE_DEFAULT } from '../../src/production/cache-proxy.js';
import { HostHomeErrors } from '../../src/production/host-home.js';
import { encodeHostState, parseHostState } from '../../src/production/host-state.js';
import { parseManifest } from '../../src/production/manifest.js';
import type { ObservedState } from '../../src/production/observe.js';
import {
  DIGEST_PLACEHOLDER,
  PlanErrors,
  formatProductionPlan,
  type ProductionPlan,
  type ProductionStep,
} from '../../src/production/plan.js';
import { reconcile, type RepairReason } from '../../src/production/reconcile.js';
import { sha256Hex } from '../../src/production/remote-file.js';
import { releaseIdFor } from '../../src/production/release-id.js';
import { remoteCommandLine, shellQuote } from '../../src/production/transport.js';
import {
  BY,
  HOME,
  NOW,
  SEQ,
  commit,
  deployPlan,
  imageOf,
  manifestOf,
  observation,
  plannedRelease,
  release,
  rollbackPlan,
  stateOf,
  webContainer,
  type HostSpec,
} from './host-observation.js';

/** A routed app with nothing else: the shortest real step list. */
function routedConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    production: { server: '1.2.3.4', domain: 'example.com' },
  });
}

/** A full production config. */
function fullConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    command: 'node server.js',
    health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
    env: {
      LOG_LEVEL: 'info',
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

/** A pinned cache-proxy image other than the default. */
const CUSTOM_VARNISH = `varnish@sha256:${'c'.repeat(64)}`;

function cacheProxyConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    production: { server: '1.2.3.4', domain: 'example.com' },
    cacheProxy: { enabled: true, image: CUSTOM_VARNISH, size: '512m' },
  });
}

function bareConfig(extra: Record<string, unknown> = {}): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'img',
    production: { server: '1.2.3.4' },
    ...extra,
  });
}

/** The `-v` mounts of an argv, in order. */
function mounts(argv: readonly string[]): readonly string[] {
  return argv.flatMap((word, index) => (argv[index - 1] === '-v' ? [word] : []));
}

function secretsMount(n: number): string {
  return `${HOME}/.jamal/apps/myapp/releases/${release(n)}/secrets:/run/jsails/secrets:ro`;
}

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

/** `text` with every numbered release id (and its container) written `R<n>`. */
function short(text: string): string {
  let result = text;
  for (let n = 0; n < 10; n += 1) result = result.replaceAll(release(n), `R${n}`);
  return result.replaceAll('myapp-web-', '');
}

/**
 * A plan as one line per step: its kind, and for the steps whose subject
 * varies, the subject: the container a run starts or a retire removes, the
 * repair's reason, and what a state write records and expects to replace
 * (`absent`, the `observed` bytes, or the `repaired` bytes).
 */
function summary(plan: ProductionPlan, observed: ObservedState): string[] {
  let repaired: string | undefined;
  return plan.steps.map((step) => {
    switch (step.kind) {
      case 'run':
        return `run ${short(plan.containerName)}`;
      case 'retire':
        return `retire ${short(step.argv?.at(-1) ?? '')}`;
      case 'repair-state':
        repaired = sha256Hex(Buffer.from(step.file?.contents ?? '', 'utf8'));
        return `repair-state ${plan.reconciled.repair?.reason}`;
      case 'state': {
        const state = parseHostState(Buffer.from(step.file?.contents ?? '', 'utf8'));
        const expect = step.file?.expect;
        const observedSha =
          observed.hostState.kind === 'absent' ? undefined : observed.hostState.sha256;
        const label =
          expect === 'absent'
            ? 'absent'
            : expect === repaired
              ? 'repaired'
              : expect === observedSha
                ? 'observed'
                : String(expect);
        return short(
          `state live=${state.live} previous=${state.previous ?? 'none'} expect=${label}`,
        );
      }
      default:
        return step.kind;
    }
  });
}

/** A deploy of release 3 onto `spec`, as a summary. */
function deployOnto(config: JamalConfig, spec: HostSpec): string[] {
  const observed = observation(config, spec);
  return summary(deployPlan(config, 3, { observed }), observed);
}

/** The steps every deploy of release 3 runs before its state is recorded. */
const DEPLOY_R3 = [
  'network',
  'pull',
  'secrets-file',
  'check',
  'manifest',
  'run R3',
  'health',
  'switch',
];

describe('planRelease: the step list for each host', () => {
  const config = routedConfig();
  const table: readonly { name: string; host: HostSpec; steps: readonly string[] }[] = [
    {
      name: 'an empty host',
      host: {},
      steps: [...DEPLOY_R3, 'state live=R3 previous=none expect=absent'],
    },
    {
      name: 'one live release',
      host: { releases: [1], state: stateOf(1), containers: [1], serving: 1 },
      steps: [...DEPLOY_R3, 'state live=R3 previous=R1 expect=observed', 'retire R1'],
    },
    {
      name: 'stale foreign containers: an exited one, and one a killed run started',
      host: {
        releases: [1, [2, 1]],
        state: stateOf(1),
        containers: [{ n: 0, state: 'exited' }, 1, 2],
        serving: 1,
      },
      steps: [
        ...DEPLOY_R3,
        'state live=R3 previous=R1 expect=observed',
        'retire R0',
        'retire R1',
        'retire R2',
      ],
    },
    {
      name: 'a dead release: its container exited and the proxy serves nothing',
      host: {
        releases: [1],
        state: stateOf(1),
        containers: [{ n: 1, state: 'exited' }],
        serving: null,
      },
      steps: [
        'repair-state route-missing',
        ...DEPLOY_R3,
        'state live=R3 previous=R1 expect=repaired',
        'retire R1',
      ],
    },
    {
      name: 'a proxy serving a container that is no release of the app',
      host: { releases: [1], state: stateOf(1), containers: [1], serving: 'someone-else' },
      steps: [
        'repair-state route-unknown',
        ...DEPLOY_R3,
        'state live=R3 previous=R1 expect=repaired',
        'retire R1',
      ],
    },
    {
      name: 'a state.json that is no v1 document',
      host: { releases: [1], state: 'unreadable', containers: [1], serving: 1 },
      steps: [
        'repair-state unreadable',
        ...DEPLOY_R3,
        'state live=R3 previous=R1 expect=repaired',
        'retire R1',
      ],
    },
    {
      name: 'a previous release whose manifest is gone',
      host: { releases: [2], state: stateOf(2, 1), containers: [2], serving: 2 },
      steps: [
        'repair-state previous-missing',
        ...DEPLOY_R3,
        'state live=R3 previous=R2 expect=repaired',
        'retire R2',
      ],
    },
  ];
  for (const row of table) {
    it(row.name, () => {
      assert.deepEqual(deployOnto(config, row.host), row.steps);
    });
  }

  it('a same-commit redeploy is a new release: its own id and container, the live one retired last', () => {
    const observed = observation(config, {
      releases: [1],
      state: stateOf(1),
      containers: [1],
      serving: 1,
    });
    const again = {
      ...plannedRelease(config, 1),
      id: releaseIdFor(new Date(Date.UTC(2026, 10, 23, 11, 0)), commit(1)),
    };
    const plan = deployPlan(config, 1, { observed, release: again });
    assert.notEqual(plan.releaseId, release(1));
    assert.notEqual(plan.containerName, webContainer(config, 1));
    assert.deepEqual(summary(plan, observed).map(short), [
      'network',
      'pull',
      'secrets-file',
      'check',
      'manifest',
      `run ${plan.releaseId}`,
      'health',
      'switch',
      `state live=${plan.releaseId} previous=R1 expect=observed`,
      'retire R1',
    ]);
    // Nothing before the retire touches the live release's container.
    const retire = plan.steps.findIndex((step) => step.kind === 'retire');
    for (const step of plan.steps.slice(0, retire)) {
      assert.ok(!(step.argv ?? []).includes(webContainer(config, 1)), step.kind);
    }
    const manifest = parseManifest(Buffer.from(stepOf(plan, 'manifest')?.file?.contents ?? ''));
    assert.equal(manifest.git.sha, commit(1));
    assert.equal(manifest.previous, release(1));
  });

  it('an app jamal does not route keeps the state as its record and switches nothing', () => {
    const bare = bareConfig();
    const observed = observation(bare, { releases: [1], state: stateOf(1), containers: [1] });
    assert.deepEqual(summary(deployPlan(bare, 3, { observed }), observed), [
      ...DEPLOY_R3,
      'state live=R3 previous=R1 expect=observed',
      'retire R1',
    ]);
    assert.equal(stepOf(deployPlan(bare, 3, { observed }), 'switch')?.argv, undefined);
  });

  it('runs the accessory steps after the network and before the pull', () => {
    assert.deepEqual(
      deployPlan(fullConfig(), 1).steps.map((step) => step.kind),
      [
        'network',
        'accessory',
        'accessory',
        'accessory',
        'accessory',
        'pull',
        'secrets-file',
        'check',
        'manifest',
        'run',
        'health',
        'switch',
        'state',
      ],
    );
  });

  it('runs the cache-proxy steps after the health check and before the switch', () => {
    assert.deepEqual(
      deployPlan(cacheProxyConfig(), 1).steps.map((step) => step.kind),
      [
        'network',
        'pull',
        'secrets-file',
        'check',
        'manifest',
        'run',
        'health',
        'cache-proxy:write-vcl',
        'cache-proxy:boot',
        'cache-proxy:health',
        'switch',
        'state',
      ],
    );
  });
});

/**
 * Deploying release 2 over live release 1, a run killed at each point from
 * the health check to the retire leaves one of these hosts. The proxy's
 * target is the truth: `reconcile` must name the release it serves, and the
 * next deploy (release 3) must repair the record before anything else.
 */
const CRASH_POINTS: readonly {
  readonly name: string;
  readonly host: HostSpec;
  readonly serving: number;
  readonly reconciled: { live: number; previous: number | null; repair: RepairReason | undefined };
  readonly next: readonly string[];
  readonly rollback: readonly string[];
}[] = [
  {
    name: 'killed after the health check, before the switch',
    host: { releases: [1, [2, 1]], state: stateOf(1), containers: [1, 2], serving: 1 },
    serving: 1,
    reconciled: { live: 1, previous: null, repair: undefined },
    next: [...DEPLOY_R3, 'state live=R3 previous=R1 expect=observed', 'retire R1', 'retire R2'],
    rollback: [],
  },
  {
    name: 'killed after the switch, before the state write',
    host: { releases: [1, [2, 1]], state: stateOf(1), containers: [1, 2], serving: 2 },
    serving: 2,
    reconciled: { live: 2, previous: 1, repair: 'live-mismatch' },
    next: [
      'repair-state live-mismatch',
      ...DEPLOY_R3,
      'state live=R3 previous=R2 expect=repaired',
      'retire R1',
      'retire R2',
    ],
    // Release 1's container still runs: it is reused, not started again.
    rollback: [
      'repair-state live-mismatch',
      'network',
      'pull',
      'check',
      'health',
      'switch',
      'state live=R1 previous=R2 expect=repaired',
      'retire R2',
    ],
  },
  {
    name: 'killed after the state write, before the retire',
    host: { releases: [1, [2, 1]], state: stateOf(2, 1), containers: [1, 2], serving: 2 },
    serving: 2,
    reconciled: { live: 2, previous: 1, repair: undefined },
    next: [...DEPLOY_R3, 'state live=R3 previous=R2 expect=observed', 'retire R1', 'retire R2'],
    rollback: [
      'network',
      'pull',
      'check',
      'health',
      'switch',
      'state live=R1 previous=R2 expect=observed',
      'retire R2',
    ],
  },
  {
    name: 'finished: the retire removed release 1',
    host: { releases: [1, [2, 1]], state: stateOf(2, 1), containers: [2], serving: 2 },
    serving: 2,
    reconciled: { live: 2, previous: 1, repair: undefined },
    next: [...DEPLOY_R3, 'state live=R3 previous=R2 expect=observed', 'retire R2'],
    rollback: [
      'network',
      'pull',
      'check',
      'run R1',
      'health',
      'switch',
      'state live=R1 previous=R2 expect=observed',
      'retire R2',
    ],
  },
  {
    name: 'a first deploy killed after the switch, before the state write',
    host: { releases: [1], containers: [1], serving: 1 },
    serving: 1,
    reconciled: { live: 1, previous: null, repair: 'missing' },
    next: [
      'repair-state missing',
      ...DEPLOY_R3,
      'state live=R3 previous=R1 expect=repaired',
      'retire R1',
    ],
    rollback: [],
  },
];

describe('crash points between the proxy switch and the state write', () => {
  const config = routedConfig();
  for (const point of CRASH_POINTS) {
    describe(point.name, () => {
      const observed = observation(config, point.host);

      it("reconciles to the proxy's truth", () => {
        const reconciled = reconcile(observed);
        assert.equal(reconciled.live, release(point.serving));
        assert.deepEqual(
          {
            live: reconciled.live,
            previous: reconciled.previous,
            repair: reconciled.repair?.reason,
          },
          {
            live: release(point.reconciled.live),
            previous:
              point.reconciled.previous === null ? null : release(point.reconciled.previous),
            repair: point.reconciled.repair,
          },
        );
      });

      it('a repaired record reconciles with nothing left to repair', () => {
        const plan = deployPlan(config, 3, { observed });
        const repair = stepOf(plan, 'repair-state');
        const repaired =
          repair === undefined
            ? observed
            : observation(config, {
                ...point.host,
                state: parseHostState(Buffer.from(repair.file?.contents ?? '', 'utf8')),
              });
        const again = reconcile(repaired);
        assert.equal(again.repair, undefined);
        assert.equal(again.live, release(point.serving));
      });

      it('the next deploy repairs the record first', () => {
        assert.deepEqual(summary(deployPlan(config, 3, { observed }), observed), point.next);
      });

      it('a rollback returns to the previous release, or is refused without one', () => {
        if (point.rollback.length === 0) {
          assert.throws(
            () => rollbackPlan(config, observed),
            (error: unknown) => PlanErrors.is(error, 'no_previous'),
          );
          return;
        }
        const plan = rollbackPlan(config, observed);
        assert.deepEqual(summary(plan, observed), point.rollback);
        assert.equal(plan.imageRef, imageOf(config, 1));
      });
    });
  }

  it('never removes a reused container on a failure', () => {
    const observed = observation(config, CRASH_POINTS[1]!.host);
    const plan = rollbackPlan(config, observed);
    for (const step of plan.steps) {
      assert.notEqual(step.cleanupOnFailure, true, step.kind);
    }
  });
});

describe('planRelease: what the release records', () => {
  it('writes the manifest create-only, read-only, before the run', () => {
    const config = routedConfig();
    const plan = deployPlan(config, 1);
    const step = stepOf(plan, 'manifest');
    assert.deepEqual(
      { ...step?.file, contents: undefined },
      {
        path: `.jamal/apps/myapp/releases/${release(1)}/manifest.json`,
        mode: 0o444,
        directoryMode: 0o700,
        source: 'text',
        contents: undefined,
        expect: 'absent',
      },
    );
    const kinds = plan.steps.map((s) => s.kind);
    assert.ok(kinds.indexOf('manifest') < kinds.indexOf('run'));
    assert.deepEqual(parseManifest(Buffer.from(step?.file?.contents ?? '')), {
      ...manifestOf(config, 1),
      infra: { proxyImage: null },
      createdAt: NOW,
      by: BY,
    });
  });

  it('records the pinned proxy and cache-proxy images the release is served through', () => {
    const config = cacheProxyConfig();
    const observed = observation(config, { serving: null });
    const manifest = parseManifest(
      Buffer.from(stepOf(deployPlan(config, 1, { observed }), 'manifest')?.file?.contents ?? ''),
    );
    assert.deepEqual(manifest.infra, {
      proxyImage:
        'basecamp/kamal-proxy@sha256:8278e2f5c565bb957962e32fb45eeb5ac7287c6c8033616c26e7784afaa1ebfc',
      cacheProxyImage: CUSTOM_VARNISH,
    });
  });

  it('refuses to serve a routed release through a proxy no digest names', () => {
    const config = routedConfig();
    const observed: ObservedState = { ...observation(config), proxyImage: { kind: 'unpinned' } };
    assert.throws(
      () => deployPlan(config, 1, { observed }),
      (error: unknown) => PlanErrors.is(error, 'unpinned_proxy'),
    );
  });

  it('writes the state as a compare-and-replace of what it observed, private', () => {
    const config = routedConfig();
    const state = stateOf(1);
    const observed = observation(config, { releases: [1], state, containers: [1], serving: 1 });
    const step = stepOf(deployPlan(config, 3, { observed }), 'state');
    assert.equal(step?.file?.path, '.jamal/apps/myapp/state.json');
    assert.equal(step?.file?.mode, 0o600);
    assert.equal(step?.file?.directoryMode, 0o700);
    assert.equal(step?.file?.expect, sha256Hex(encodeHostState(state)));
    assert.deepEqual(parseHostState(Buffer.from(step?.file?.contents ?? '')), {
      v: 1,
      seq: SEQ,
      live: release(3),
      previous: release(1),
      updatedAt: NOW,
      by: BY,
    });
  });

  it('refuses a release id or image that is not one, value-free', () => {
    const config = routedConfig();
    const bad = [
      { ...plannedRelease(config, 1), id: 'latest' },
      { ...plannedRelease(config, 1), image: 'ghcr.io/acme/myapp:latest' },
      { ...plannedRelease(config, 1), image: `ghcr.io/acme/other@sha256:${'a'.repeat(64)}` },
      { ...plannedRelease(config, 1), image: `ghcr.io/acme/myapp@${DIGEST_PLACEHOLDER}` },
    ];
    for (const planned of bad) {
      assert.throws(
        () => deployPlan(config, 1, { release: planned }),
        (error: unknown) =>
          PlanErrors.is(error, 'invalid_release') && !String(error).includes('latest'),
      );
    }
  });

  it('accepts the digest placeholder in a preview, and says what it stands for', () => {
    const config = routedConfig();
    const plan = deployPlan(config, 1, {
      preview: true,
      release: { ...plannedRelease(config, 1), image: `ghcr.io/acme/myapp@${DIGEST_PLACEHOLDER}` },
    });
    assert.equal(plan.preview, true);
    assert.match(
      formatProductionPlan(plan),
      /^<digest> stands for the digest the registry gives the pushed image$/m,
    );
  });

  it('warns when the release is built from a dirty tree', () => {
    const config = bareConfig();
    const plan = deployPlan(config, 1, {
      release: { ...plannedRelease(config, 1), git: { sha: commit(1), dirty: true } },
    });
    assert.deepEqual(plan.warnings, [
      `Deploying uncommitted changes (--allow-dirty): the release records commit ${commit(1).slice(0, 12)} with a dirty tree.`,
    ]);
  });
});

describe('planRollback', () => {
  const config = fullConfig();
  const host: HostSpec = {
    releases: [1, [2, 1]],
    state: stateOf(2, 1),
    containers: [2],
    serving: 2,
  };

  it('runs the previous release by the digest and with the secrets it was deployed with', () => {
    const plan = rollbackPlan(config, observation(config, host));
    assert.equal(plan.kind, 'rollback');
    assert.equal(plan.releaseId, release(1));
    assert.equal(plan.imageRef, imageOf(config, 1));
    assert.ok(!plan.steps.some((step) => step.kind === 'secrets-file' || step.kind === 'manifest'));
    const run = stepOf(plan, 'run')?.argv ?? [];
    assert.ok(run.includes(imageOf(config, 1)));
    assert.deepEqual(mounts(run).slice(0, 1), [secretsMount(1)]);
    // The same flags as a deploy.
    for (const flag of [
      '--network',
      '--restart',
      'DATABASE_HOST=db',
      'myapp_storage:/app/storage',
    ]) {
      assert.ok(run.includes(flag), `rollback is missing ${flag}`);
    }
    assert.match(plan.warnings.at(-1) ?? '', /^Rolling back to /);
  });

  it('runs the command its manifest records, not the one the config names now', () => {
    const deployed = bareConfig({ command: 'node server-v1.js' });
    const observed = observation(deployed, {
      releases: [1, [2, 1]],
      state: stateOf(2, 1),
      containers: [2],
    });
    const plan = rollbackPlan(bareConfig({ command: 'node server-v2.js' }), observed);
    const run = stepOf(plan, 'run')?.argv ?? [];
    const image = imageOf(deployed, 1);
    assert.deepEqual(run.slice(run.indexOf(image)), [image, 'node', 'server-v1.js']);
  });

  it("runs the image's own command when its manifest records none, whatever the config names now", () => {
    const deployed = bareConfig();
    const observed = observation(deployed, {
      releases: [1, [2, 1]],
      state: stateOf(2, 1),
      containers: [2],
    });
    const plan = rollbackPlan(bareConfig({ command: 'node worker.js' }), observed);
    const run = stepOf(plan, 'run')?.argv ?? [];
    const image = imageOf(deployed, 1);
    assert.deepEqual(run.slice(run.indexOf(image)), [image]);
  });

  it('is refused when the release it returns to records no web role', () => {
    const observed = observation(config, host);
    const manifests = new Map(observed.manifests);
    manifests.set(release(1), {
      ...manifestOf(config, 1),
      roles: { worker: { container: 'myapp-worker', command: [], replicas: 1 } },
    });
    assert.throws(
      () => rollbackPlan(config, { ...observed, manifests }),
      (error: unknown) => PlanErrors.is(error, 'no_web_role'),
    );
  });

  it('is refused without a previous release, or when its secrets file is gone', () => {
    assert.throws(
      () =>
        rollbackPlan(
          config,
          observation(config, { releases: [1], state: stateOf(1), containers: [1], serving: 1 }),
        ),
      (error: unknown) => PlanErrors.is(error, 'no_previous'),
    );
    assert.throws(
      () => rollbackPlan(config, observation(config, { ...host, secretsGone: [1] })),
      (error: unknown) => PlanErrors.is(error, 'secrets_missing'),
    );
  });
});

describe('planning while kamal-proxy is down', () => {
  const config = routedConfig();
  for (const proxy of ['stopped', 'missing'] as const) {
    const observed = observation(config, {
      releases: [1, [2, 1]],
      state: stateOf(2, 1),
      containers: [2],
      proxy,
    });

    it(`refuses a deploy and a rollback when kamal-proxy is ${proxy}`, () => {
      for (const plan of [
        () => deployPlan(config, 3, { observed }),
        () => deployPlan(config, 3, { observed, preview: true }),
        () => rollbackPlan(config, observed),
      ]) {
        assert.throws(plan, (error: unknown) => {
          assert.ok(PlanErrors.is(error, 'proxy_down'));
          assert.doesNotMatch(error.message, /1\.2\.3\.4|example\.com|myapp/);
          return true;
        });
      }
    });
  }
});

describe('planRelease: argv shapes', () => {
  it('pulls by digest, then runs the release with its labels, env, secrets, and volumes', () => {
    const config = fullConfig();
    const plan = deployPlan(config, 1);
    const image = imageOf(config, 1);
    const container = webContainer(config, 1);

    assert.deepEqual(stepOf(plan, 'pull')?.argv, ['ssh', '1.2.3.4', 'docker', 'pull', image]);
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
      container,
      'docker',
      'run',
      '-d',
      '--name',
      container,
      '--network',
      'jamal',
      '--restart',
      'unless-stopped',
      '--label',
      'jsails.service=myapp',
      '--label',
      'jsails.destination=',
      '--label',
      'jsails.role=web',
      '--label',
      `jsails.release=${release(1)}`,
      '-e',
      'JSAILS_ENV=production',
      '-e',
      'NODE_ENV=production',
      '-e',
      'JSAILS_HOST=0.0.0.0',
      '-e',
      'JSAILS_PORT=3000',
      '-e',
      'JSAILS_TRUSTED_PROXIES=hops=1',
      '-e',
      'DATABASE_HOST=db',
      '-e',
      'DATABASE_PORT=3306',
      '-e',
      'DATABASE_TYPE=mariadb',
      '-v',
      secretsMount(1),
      '-e',
      'JSAILS_SECRETS_FILE=/run/jsails/secrets/secrets.json',
      '-v',
      'myapp_data:/var/lib/mysql',
      '-v',
      'myapp_storage:/app/storage',
      image,
      'node',
      'server.js',
    ]);
  });

  it('labels a destination release with its destination', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      production: { server: '1.2.3.4', destination: 'staging' },
    });
    const plan = deployPlan(config, 1);
    assert.equal(plan.containerName, `myapp.staging-web-${release(1)}`);
    assert.ok(stepOf(plan, 'run')?.argv?.includes('jsails.destination=staging'));
    assert.equal(stepOf(plan, 'state')?.file?.path, '.jamal/apps/myapp.staging/state.json');
  });

  it('ensures the shared network and attaches the proxy and accessories to it', () => {
    const argv = stepOf(deployPlan(fullConfig(), 1), 'network')?.argv ?? [];
    assert.deepEqual(argv.slice(0, 3), ['ssh', '1.2.3.4', 'sh']);
    assert.match(argv[4] ?? '', /docker network create jamal/);
    assert.match(argv[4] ?? '', /docker inspect --type container "\$c" >/);
    assert.doesNotMatch(argv[4] ?? '', /docker inspect (?!--type container)/);
    assert.deepEqual(argv.slice(5), ['sh', 'kamal-proxy', 'db']);
  });

  it('probes the new container and switches the proxy to it', () => {
    const config = fullConfig();
    const plan = deployPlan(config, 1);
    const container = webContainer(config, 1);
    const health = stepOf(plan, 'health');
    assert.deepEqual(health?.argv?.slice(0, 7), [
      'ssh',
      '1.2.3.4',
      'docker',
      'exec',
      container,
      'node',
      '-e',
    ]);
    assert.equal(
      health?.argv?.[7],
      'fetch("http://127.0.0.1:3000/up",{signal:AbortSignal.timeout(5000)})' +
        '.then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))',
    );
    assert.equal(health?.cleanupOnFailure, true);
    assert.deepEqual(stepOf(plan, 'switch')?.argv, [
      'ssh',
      '1.2.3.4',
      'docker',
      'exec',
      'kamal-proxy',
      'kamal-proxy',
      'deploy',
      'myapp',
      '--target',
      `${container}:3000`,
      '--host',
      'example.com',
      '--tls',
      '--health-check-path',
      '/up',
    ]);
  });

  it('emits an on-demand TLS proxy deploy (no host) when onDemandTlsUrl is set', () => {
    const config = bareConfig({
      production: { server: '1.2.3.4', onDemandTlsUrl: 'https://tls.example.com/check' },
    });
    assert.deepEqual(stepOf(deployPlan(config, 1), 'switch')?.argv?.slice(7), [
      'myapp',
      '--target',
      `${webContainer(config, 1)}:3000`,
      '--tls',
      '--health-check-path',
      '/up',
      '--tls-on-demand-url',
      'https://tls.example.com/check',
    ]);
  });

  it('retires a container by the remote retire op', () => {
    const config = routedConfig();
    const observed = observation(config, {
      releases: [1],
      state: stateOf(1),
      containers: [1],
      serving: 1,
    });
    const retire = stepOf(deployPlan(config, 3, { observed }), 'retire');
    assert.deepEqual(retire?.argv?.slice(0, 3), ['ssh', '1.2.3.4', 'sh']);
    assert.equal(retire?.argv?.at(-1), webContainer(config, 1));
  });

  it('uses https when a domain is set and http otherwise', () => {
    assert.equal(deployPlan(fullConfig(), 1).healthUrl, 'https://example.com/up');
    assert.equal(deployPlan(bareConfig(), 1).healthUrl, 'http://1.2.3.4/up');
  });

  it('carries the health retry and readiness fields', () => {
    const plan = deployPlan(
      bareConfig({
        health: {
          path: '/up',
          timeoutMs: 5000,
          intervalMs: 30000,
          retries: 10,
          retryDelayMs: 2000,
          readinessDelayMs: 1500,
        },
      }),
      1,
    );
    assert.equal(plan.healthRetries, 10);
    assert.equal(plan.healthRetryDelayMs, 2000);
    assert.equal(plan.healthReadinessDelayMs, 1500);
    const unset = deployPlan(bareConfig(), 1);
    assert.equal(unset.healthRetries, undefined);
    assert.equal(unset.healthReadinessDelayMs, undefined);
  });

  it('refuses a config without a production overlay', () => {
    assert.match(
      capture(() => deployPlan(normalizeJamalConfig({ service: 'x', image: 'y' }), 1)).message,
      /production/,
    );
  });

  it('produces a deep-equal plan across calls for identical input', () => {
    const config = fullConfig();
    const observed = observation(config, {
      releases: [1],
      state: stateOf(1),
      containers: [1],
      serving: 1,
    });
    assert.deepEqual(deployPlan(config, 3, { observed }), deployPlan(config, 3, { observed }));
  });
});

describe('planRelease: secrets and environment', () => {
  const env: ResolvedEnv = {
    clear: [
      { name: 'LOG_LEVEL', value: 'info', secret: false },
      { name: 'PUBLIC_URL', value: 'https://example.com', secret: false },
    ],
    secret: [
      { name: 'API_KEY', value: 'sk_live_do-not-leak', secret: true },
      { name: 'DB_PASSWORD', value: 'hunter2', secret: true },
    ],
    secretsFile: Buffer.from(
      '{"v":1,"values":{"API_KEY":"sk_live_do-not-leak","DB_PASSWORD":"hunter2"}}\n',
    ),
  };

  it('writes the release secrets file create-only, read-only in a world-readable directory', () => {
    const plan = deployPlan(fullConfig(), 1, { env });
    assert.deepEqual(stepOf(plan, 'secrets-file')?.file, {
      path: `.jamal/apps/myapp/releases/${release(1)}/secrets/secrets.json`,
      mode: 0o444,
      directoryMode: 0o755,
      source: 'secrets',
      expect: 'absent',
    });
  });

  it('passes only clear entries as -e flags and mounts the secrets directory', () => {
    const plan = deployPlan(fullConfig(), 1, { env });
    for (const kind of ['check', 'run'] as const) {
      const argv = stepOf(plan, kind)?.argv ?? [];
      assert.ok(argv.includes('LOG_LEVEL=info'), kind);
      assert.ok(argv.includes('PUBLIC_URL=https://example.com'), kind);
      const joined = argv.join(' ');
      assert.ok(!joined.includes('sk_live_do-not-leak'));
      assert.ok(!joined.includes('hunter2'));
      assert.ok(!argv.includes('--env-file'), kind);
      assert.ok(joined.includes(`-v ${secretsMount(1)}`), kind);
    }
  });

  it('derives the container NODE_ENV from the clear JSAILS_ENV it runs as', () => {
    const pair = (environment: string | undefined) => {
      const clear =
        environment === undefined
          ? []
          : [{ name: 'JSAILS_ENV', value: environment, secret: false }];
      const argv =
        stepOf(
          deployPlan(fullConfig(), 1, {
            env: { clear, secret: [], secretsFile: Buffer.from('{"v":1,"values":{}}\n') },
          }),
          'run',
        )?.argv ?? [];
      const values = argv.filter((_, index) => argv[index - 1] === '-e');
      return {
        environment: values.findLast((value) => value.startsWith('JSAILS_ENV=')),
        nodeEnv: values.filter((value) => value.startsWith('NODE_ENV=')),
      };
    };
    assert.deepEqual(pair(undefined), {
      environment: 'JSAILS_ENV=production',
      nodeEnv: ['NODE_ENV=production'],
    });
    assert.deepEqual(pair('staging'), {
      environment: 'JSAILS_ENV=staging',
      nodeEnv: ['NODE_ENV=production'],
    });
    assert.deepEqual(pair('test'), { environment: 'JSAILS_ENV=test', nodeEnv: ['NODE_ENV=test'] });
  });

  it('reduces env to name, secret flag, alias, and clear, and never embeds a value', () => {
    const plan = deployPlan(fullConfig(), 1, { env });
    assert.deepEqual(plan.env, [
      { name: 'API_KEY', secret: true, alias: undefined, clear: false },
      { name: 'DATABASE_PASSWORD', secret: true, alias: undefined, clear: false },
      { name: 'DB_PASSWORD', secret: true, alias: undefined, clear: false },
      { name: 'LOG_LEVEL', secret: false, alias: undefined, clear: false },
    ]);
    const secretsStep = stepOf(plan, 'secrets-file');
    assert.equal(secretsStep?.file?.contents, undefined);
    const serialized = JSON.stringify(plan);
    assert.ok(!serialized.includes('sk_live_do-not-leak'));
    assert.ok(!serialized.includes('hunter2'));
    assert.ok(!serialized.includes('secret('));
  });

  it('reports alias and clear in each env entry', () => {
    const plan = deployPlan(
      bareConfig({
        env: { LOG_LEVEL: 'info', KEY: { value: secret('SEC'), alias: 'ALIAS', clear: true } },
      }),
      1,
    );
    assert.deepEqual(plan.env, [
      { name: 'KEY', secret: true, alias: 'ALIAS', clear: true },
      { name: 'LOG_LEVEL', secret: false, alias: undefined, clear: false },
    ]);
  });

  it('refuses a database accessory without a DATABASE_PASSWORD entry', () => {
    const error = capture(() =>
      deployPlan(bareConfig({ services: { db: { type: 'postgres' } } }), 1),
    );
    assert.match(error.message, /DATABASE_PASSWORD/);
  });
});

describe('planRelease: volumes, logging, and command', () => {
  it('carries each volume as plain data and mounts host volumes', () => {
    const plan = deployPlan(
      bareConfig({
        volumes: { uploads: '/host/uploads:/app/uploads:ro', storage: '/app/storage' },
      }),
      1,
    );
    assert.deepEqual(plan.volumes, [
      {
        name: 'storage',
        source: 'storage',
        containerPath: '/app/storage',
        options: undefined,
        host: false,
      },
      {
        name: 'uploads',
        source: '/host/uploads',
        containerPath: '/app/uploads',
        options: 'ro',
        host: true,
      },
    ]);
    assert.deepEqual(mounts(stepOf(plan, 'run')?.argv ?? []), [
      secretsMount(1),
      'myapp_storage:/app/storage',
      '/host/uploads:/app/uploads:ro',
    ]);
  });

  it('mounts a ./ or $PWD/ host source by absolute path under the deploy user home', () => {
    const plan = deployPlan(
      bareConfig({ volumes: { data: '$PWD/data:/app/data', logs: './logs:/app/logs:ro' } }),
      1,
    );
    assert.deepEqual(mounts(stepOf(plan, 'run')?.argv ?? []), [
      secretsMount(1),
      `${HOME}/data:/app/data`,
      `${HOME}/logs:/app/logs:ro`,
    ]);
  });

  it('leaves no bind-mount source relative in any step, the cache proxy included', () => {
    const plan = deployPlan(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        volumes: { data: '$PWD/data:/app/data', storage: 'storage:/app/storage' },
        cacheProxy: { enabled: true },
        production: { server: '1.2.3.4', domain: 'example.com' },
      }),
      1,
    );
    const sources = plan.steps
      .flatMap((step) => mounts(step.argv ?? []))
      .map((spec) => spec.split(':')[0]!);
    for (const source of sources) {
      assert.ok(source.startsWith('/') || !source.includes('/'), source);
    }
    assert.ok(sources.includes(`${HOME}/.jamal/cache-proxy`));
  });

  it('refuses a home that is not one absolute path free of ":", value-free', () => {
    for (const hostHome of ['home/deploy', '/home/a:b', '/home/deploy\nbanner', '']) {
      assert.throws(
        () => deployPlan(bareConfig(), 1, { hostHome }),
        (error: unknown) =>
          HostHomeErrors.is(error, 'unusable_home') &&
          (hostHome === '' || !error.message.includes(hostHome)),
      );
    }
  });

  it('emits --log-driver and sorted --log-opt flags', () => {
    const argv =
      stepOf(
        deployPlan(
          bareConfig({
            logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
          }),
          1,
        ),
        'run',
      )?.argv ?? [];
    const at = argv.indexOf('--log-driver');
    assert.deepEqual(argv.slice(at, at + 6), [
      '--log-driver',
      'json-file',
      '--log-opt',
      'max-file=3',
      '--log-opt',
      'max-size=10m',
    ]);
    assert.ok(!(stepOf(deployPlan(bareConfig(), 1), 'run')?.argv ?? []).includes('--log-driver'));
  });

  it('splits a quoted command into argv tokens after the image', () => {
    const config = bareConfig({ command: 'node -e "console.log(1 + 1)"' });
    const argv = stepOf(deployPlan(config, 1), 'run')?.argv ?? [];
    const image = imageOf(config, 1);
    assert.deepEqual(argv.slice(argv.indexOf(image)), [image, 'node', '-e', 'console.log(1 + 1)']);
  });
});

describe('planRelease: the cache proxy', () => {
  it('switches the proxy to the cache proxy, whose VCL names the new container', () => {
    const config = cacheProxyConfig();
    const plan = deployPlan(config, 1);
    const argv = stepOf(plan, 'switch')?.argv ?? [];
    assert.equal(argv[argv.indexOf('--target') + 1], 'jamal-cache-proxy:6081');
    const vcl = stepOf(plan, 'cache-proxy:write-vcl');
    assert.equal(vcl?.argv, undefined);
    assert.equal(vcl?.file?.path, '.jamal/cache-proxy/default.vcl');
    assert.equal(vcl?.file?.mode, 0o644);
    assert.match(vcl?.file?.contents ?? '', new RegExp(`\\.host = "${webContainer(config, 1)}";`));
  });

  it('boots the cache proxy with the configured image and size', () => {
    const boot = stepOf(deployPlan(cacheProxyConfig(), 1), 'cache-proxy:boot')?.argv ?? [];
    assert.ok(boot.includes(CUSTOM_VARNISH));
    assert.ok(boot.includes('VARNISH_SIZE=512m'));
    assert.match(boot[4] ?? '', /docker exec "\$n" varnishreload/);
    assert.deepEqual(boot.slice(5, 8), ['sh', 'jamal-cache-proxy', CUSTOM_VARNISH]);
  });

  it('defaults the cache-proxy image to a pinned Varnish, and refuses an unpinned one', () => {
    const config = bareConfig({ cacheProxy: {} });
    assert.equal(config.cacheProxy?.enabled, false);
    assert.equal(config.cacheProxy?.image, CACHE_PROXY_IMAGE_DEFAULT);
    assert.match(CACHE_PROXY_IMAGE_DEFAULT, /^varnish@sha256:[0-9a-f]{64}$/);
    assert.equal(config.cacheProxy?.size, '256m');
    assert.match(
      capture(() => bareConfig({ cacheProxy: { image: 'custom:v1' } })).message,
      /must be pinned by digest/,
    );
    assert.match(
      capture(() => bareConfig({ cacheProxy: { image: 'has space' } })).message,
      /must not contain whitespace/,
    );
    assert.equal(
      bareConfig({ cacheProxy: { image: CUSTOM_VARNISH } }).cacheProxy?.image,
      CUSTOM_VARNISH,
    );
  });

  it('normalizes a cookie allowlist and refuses an entry with whitespace', () => {
    assert.deepEqual(
      bareConfig({ cacheProxy: { enabled: true, cookieAllowlist: ['session_id', 'theme'] } })
        .cacheProxy?.cookieAllowlist,
      ['session_id', 'theme'],
    );
    assert.match(
      capture(() => bareConfig({ cacheProxy: { cookieAllowlist: ['has space'] } })).message,
      /cacheProxy\.cookieAllowlist/,
    );
  });
});

describe('formatProductionPlan', () => {
  it('renders the release, what the host was reconciled to, each step with its command, and warnings', () => {
    const config = fullConfig();
    const observed = observation(config, {
      releases: [1],
      state: stateOf(1),
      containers: [1],
      serving: 1,
    });
    const plan = deployPlan(config, 3, { observed });
    const text = formatProductionPlan(plan);
    const lines = text.split('\n');
    assert.deepEqual(lines.slice(0, 6), [
      `release: ${release(3)}`,
      `image: ${imageOf(config, 3)}`,
      `container: ${webContainer(config, 3)}`,
      `live now: ${release(1)}`,
      'previous now: none',
      '',
    ]);
    for (const step of plan.steps) {
      assert.ok(lines.includes(`${step.kind}: ${step.description}`), `missing ${step.kind}`);
      if (step.argv !== undefined) {
        const quoted = step.argv.map((token) => shellQuote(token)).join(' ');
        assert.ok(text.includes(`\n  $ ${quoted}`), `missing argv for ${step.kind}`);
      }
    }
    // A file step shows its write command, with the precondition it carries.
    const state = stepOf(plan, 'state');
    const shown = text.slice(
      text.indexOf(`state: ${state?.description}`),
      text.indexOf('\nretire: '),
    );
    assert.ok(shown.endsWith(` ${state?.file?.expect}`), shown);
    assert.deepEqual(
      lines.filter((line) => line.startsWith('warning: ')),
      plan.warnings.map((warning) => `warning: ${warning}`),
    );
    assert.ok(!text.includes('secret('));
    assert.ok(!text.includes('DB_PASSWORD'));
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

describe(
  'planRelease: remote scripts through a real shell',
  { skip: process.platform === 'win32' && 'the remote scripts need a POSIX shell' },
  () => {
    it('never force-removes a running container whose name the run conflicts with', () => {
      const config = fullConfig();
      const container = webContainer(config, 1);
      const calls = runWithFakeDocker(
        stepOf(deployPlan(config, 1), 'run'),
        '"rm "*) exit 1 ;;\n"run "*) exit 125 ;;',
      );
      assert.deepEqual(
        calls.map((call) => call.split(' ').slice(0, 2).join(' ')),
        [`rm ${container}`, 'run -d', `rm ${container}`],
      );
      assert.ok(!calls.some((call) => call.includes('-f')));
    });

    it('reloads a running cache proxy in place instead of replacing it', () => {
      const calls = runWithFakeDocker(
        stepOf(deployPlan(cacheProxyConfig(), 1), 'cache-proxy:boot'),
        `"inspect "*) echo "true ${CUSTOM_VARNISH}" ;;`,
      );
      assert.deepEqual(calls.slice(1), ['exec jamal-cache-proxy varnishreload']);
    });

    it('boots the cache proxy when it is missing', () => {
      const calls = runWithFakeDocker(
        stepOf(deployPlan(cacheProxyConfig(), 1), 'cache-proxy:boot'),
        '"inspect "*) exit 1 ;;',
      );
      assert.equal(calls[1], 'rm -f jamal-cache-proxy');
      assert.ok((calls[2] ?? '').startsWith('run -d '));
      assert.ok((calls[2] ?? '').endsWith(CUSTOM_VARNISH));
    });
  },
);
