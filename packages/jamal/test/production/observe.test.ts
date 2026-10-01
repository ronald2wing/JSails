/**
 * Tests for observe: what it reads from a host, how it reads damaged or
 * foreign bytes, and how it fails, against a scripted server and against
 * the modelled host after real releases.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { normalizeJamalConfig, type JamalConfig } from '../../src/config/index.js';
import { resolveJamalEnv } from '../../src/env-resolve.js';
import { runDeployExecution } from '../../src/production/execute.js';
import { CACHE_PROXY_CONTAINER_NAME } from '../../src/production/cache-proxy.js';
import { hostManifestFile, hostStateFile } from '../../src/production/host-layout.js';
import {
  APP_CONTAINERS_FORMAT,
  observe,
  ObserveErrors,
  parseStateDump,
  proxyTargetContainer,
} from '../../src/production/observe.js';
import type { CommandResult } from '../../src/production/process-runner.js';
import { PROXY_IMAGE_DEFAULT } from '../../src/production/proxy.js';
import { decodeRemoteOp, remoteOpArgv } from '../../src/production/remote-op.js';
import type { RemoteRunner } from '../../src/production/transport.js';
import { scriptedServer } from '../scripted-server.js';
import { createWorld, serverVerbs, type World } from '../scenarios/world.js';
import { manifestOf, observation, release, stateOf, type HostSpec } from './host-observation.js';

const ROUTED = normalizeJamalConfig({
  service: 'myapp',
  image: 'ghcr.io/acme/myapp',
  production: { server: '203.0.113.7', domain: 'example.com' },
});
const UNROUTED = normalizeJamalConfig({
  service: 'myapp',
  image: 'ghcr.io/acme/myapp',
  production: { server: '203.0.113.7' },
});

describe('observe: what the host holds', () => {
  const hosts: readonly [string, JamalConfig, HostSpec][] = [
    ['an empty unrouted host', UNROUTED, {}],
    ['an empty routed host', ROUTED, { serving: null }],
    ['one live release', ROUTED, { releases: [1], state: stateOf(1), containers: [1], serving: 1 }],
    [
      'stale foreign containers beside the live one',
      ROUTED,
      {
        releases: [1, [2, 1]],
        state: stateOf(2, 1),
        containers: [1, { n: 2 }, { n: 3, state: 'exited' }],
        serving: 2,
      },
    ],
    [
      'a dead release whose secrets file is gone',
      ROUTED,
      { releases: [1, [2, 1]], state: stateOf(2, 1), secretsGone: [1], serving: null },
    ],
    ['a damaged record', UNROUTED, { releases: [1], state: 'unreadable', containers: [1] }],
    [
      'a stopped kamal-proxy',
      ROUTED,
      { releases: [1], state: stateOf(1), containers: [1], proxy: 'stopped' },
    ],
    [
      'a missing kamal-proxy',
      ROUTED,
      { releases: [1], state: stateOf(1), containers: [1], proxy: 'missing' },
    ],
  ];

  for (const [name, config, host] of hosts) {
    it(name, async () => {
      const { remote, calls } = scriptedServer({ config, host });
      assert.deepEqual(await observe(remote, '203.0.113.7', config), observation(config, host));
      assert.deepEqual(calls, [], 'observe sends only its reads');
    });
  }
});

/** A server that answers each read through `answer`, by the op or argv it receives. */
function answering(
  answer: (argv: readonly string[]) => Partial<CommandResult> & { readonly dump?: Buffer },
): RemoteRunner {
  return {
    async run(_server, remoteArgv, options) {
      const decoded = decodeRemoteOp(remoteArgv);
      const argv = decoded === undefined ? remoteArgv : remoteOpArgv(decoded);
      const { dump, ...result } = answer(argv);
      if (typeof options === 'object' && options.stdoutTo !== undefined) {
        options.stdoutTo.end(dump ?? Buffer.alloc(0));
      }
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
  };
}

/** The read an argv is, by the first words that tell them apart. */
function readOf(argv: readonly string[]): 'state' | 'containers' | 'routes' | 'image' {
  if (decodeRemoteOp(argv)?.kind === 'host.read-state') return 'state';
  if (decodeRemoteOp(argv)?.kind === 'container.image-digest') return 'image';
  if (argv.includes(APP_CONTAINERS_FORMAT)) return 'containers';
  return 'routes';
}

/** A frame of the `host.read-state` dump. */
function frame(path: string, text: string): Buffer {
  const bytes = Buffer.from(text);
  return Buffer.concat([Buffer.from(`F ${bytes.length} ${path}\n`), bytes]);
}

describe('observe: damaged and foreign bytes', () => {
  it('reports a manifest that does not parse, or names another release, as unreadable', async () => {
    const remote = answering((argv) =>
      readOf(argv) === 'state'
        ? {
            dump: Buffer.concat([
              frame(hostManifestFile('myapp', undefined, release(1)), '{"v":1}'),
              frame(
                hostManifestFile('myapp', undefined, release(2)),
                JSON.stringify(manifestOf(UNROUTED, 3)),
              ),
              // A directory that is no release id is never read as one.
              frame('.jamal/apps/myapp/releases/latest/manifest.json', '{}'),
            ]),
          }
        : { exitCode: readOf(argv) === 'image' ? 1 : 0 },
    );
    const observed = await observe(remote, 'host', UNROUTED);
    assert.deepEqual(observed.unreadableManifests, [release(1), release(2)].sort());
    assert.equal(observed.manifests.size, 0);
  });

  it('keeps only the containers of its own destination', async () => {
    const line = (destination: string, n: number): string =>
      JSON.stringify({
        name: `c${n}`,
        state: 'running',
        image: 'i',
        release: release(n),
        role: 'web',
        destination,
      });
    const remote = answering((argv) =>
      readOf(argv) === 'containers'
        ? { stdout: `${line('', 1)}\n${line('staging', 2)}\n` }
        : { exitCode: readOf(argv) === 'image' ? 1 : 0 },
    );
    const observed = await observe(remote, 'host', UNROUTED);
    assert.deepEqual(
      observed.containers.map((container) => container.release),
      [release(1)],
    );
  });

  for (const [name, stderr] of [
    ['missing', 'Error response from daemon: No such container: kamal-proxy'],
    ['stopped', 'Error response from daemon: container 0123abcd is not running'],
  ] as const) {
    it(`reads a ${name} proxy as down, not as serving nothing`, async () => {
      const remote = answering((argv) => {
        switch (readOf(argv)) {
          case 'routes':
            return { exitCode: 1, stderr };
          case 'image':
            return { stdout: `["${PROXY_IMAGE_DEFAULT}"]\n` };
          default:
            return {};
        }
      });
      const observed = await observe(remote, 'host', ROUTED);
      assert.deepEqual(observed.web, { kind: 'proxy-down' });
    });
  }

  it('reads a proxy that routes nothing of the app as serving nothing', async () => {
    const remote = answering((argv) => {
      switch (readOf(argv)) {
        case 'routes':
          return {
            stdout:
              'Service  Host  Path  Target  State  TLS\nother  o.example  /  o:3000  running  yes\n',
          };
        case 'image':
          return { stdout: `["${PROXY_IMAGE_DEFAULT}"]\n` };
        default:
          return {};
      }
    });
    const observed = await observe(remote, 'host', ROUTED);
    assert.deepEqual(observed.web, { kind: 'none' });
  });

  it('reads a locally built proxy as unpinned', async () => {
    const remote = answering((argv) => (readOf(argv) === 'image' ? { stdout: '[]\n' } : {}));
    const observed = await observe(remote, 'host', ROUTED);
    assert.deepEqual(observed.proxyImage, { kind: 'unpinned' });
  });
});

describe('observe: failures', () => {
  const cases: readonly [
    string,
    (argv: readonly string[]) => Partial<CommandResult> & { dump?: Buffer },
    string,
  ][] = [
    ['an ssh failure', () => ({ exitCode: 255 }), 'unreachable'],
    [
      'a failed state read',
      (argv) => (readOf(argv) === 'state' ? { exitCode: 2 } : {}),
      'read_failed',
    ],
    [
      'a malformed state dump',
      (argv) => (readOf(argv) === 'state' ? { dump: Buffer.from('F 99 x\nshort') } : {}),
      'unreadable_output',
    ],
    [
      'a container line jamal did not ask for',
      (argv) => (readOf(argv) === 'containers' ? { stdout: 'CONTAINER ID   NAMES\n' } : {}),
      'unreadable_output',
    ],
    [
      'a proxy that refuses the route listing',
      (argv) => (readOf(argv) === 'routes' ? { exitCode: 3, stderr: 'permission denied' } : {}),
      'read_failed',
    ],
    [
      'a proxy image read that prints no list',
      (argv) => (readOf(argv) === 'image' ? { stdout: 'kamal-proxy\n' } : {}),
      'unreadable_output',
    ],
  ];

  for (const [name, answer, code] of cases) {
    it(`fails value-free on ${name}`, async () => {
      await assert.rejects(
        () => observe(answering(answer), 'host', ROUTED),
        (error: unknown) => {
          assert.ok(ObserveErrors.is(error, code as 'unreachable'));
          assert.doesNotMatch(error.message, /permission denied|kamal-proxy\n|CONTAINER/);
          return true;
        },
      );
    });
  }
});

describe('parseStateDump and proxyTargetContainer', () => {
  it('reads framed files byte for byte, newlines inside them included, and named secrets', () => {
    const dump = Buffer.concat([
      frame('a', 'one\ntwo\n'),
      Buffer.from('E b/secrets.json\n'),
      frame('c', ''),
    ]);
    const parsed = parseStateDump(dump);
    assert.ok(parsed !== undefined);
    assert.deepEqual(
      [...parsed.files].map(([path, bytes]) => [path, bytes.toString('utf8')]),
      [
        ['a', 'one\ntwo\n'],
        ['c', ''],
      ],
    );
    assert.deepEqual([...parsed.secrets], ['b/secrets.json']);
  });

  it('refuses a truncated frame, an unknown line, or a missing newline', () => {
    for (const text of ['F 5 a\nabc', 'X a\n', 'E a', 'F -1 a\n', 'F 1\nx']) {
      assert.equal(parseStateDump(Buffer.from(text)), undefined, JSON.stringify(text));
    }
    assert.deepEqual(parseStateDump(Buffer.alloc(0)), { files: new Map(), secrets: new Set() });
  });

  it("finds the service's target container in kamal-proxy's table, and nothing for another", () => {
    const listing = [
      'Service  Host         Path  Target                  State    TLS',
      'other    other.com    /     other-web-1:3000        running  no',
      'myapp    example.com  /     myapp-web-2:3000        running  yes',
      '',
    ].join('\n');
    assert.equal(proxyTargetContainer(listing, 'myapp'), 'myapp-web-2');
    assert.equal(proxyTargetContainer(listing, 'missing'), undefined);
    assert.equal(proxyTargetContainer('Service Host\n', 'myapp'), undefined);
  });
});

describe('observe: the modelled host after real releases', serverVerbs, () => {
  let world: World | undefined;
  afterEach(() => {
    world?.close();
    world = undefined;
  });

  async function deployed(cacheProxy: boolean) {
    world = await createWorld({ cacheProxy });
    const a = world.checkout('a');
    let clock = Date.parse('2026-12-01T10:00:00.000Z');
    const { plan } = await runDeployExecution({
      config: world.config,
      commandRunner: a.docker.runner,
      remoteRunner: a.client,
      cwd: a.dir,
      env: resolveJamalEnv(world.config, { values: { ...world.secrets }, files: [] }),
      logger: { info: () => {}, warn: () => {} },
      now: () => new Date((clock += 1000)),
    });
    return { w: world, a, id: plan.releaseId, image: plan.imageRef };
  }

  it('reads back the release a deploy made, served by the proxy', async () => {
    const { w, a, id, image } = await deployed(false);
    const observed = await observe(a.client, 'host', w.config);
    assert.equal(observed.hostState.kind, 'present');
    assert.equal(observed.hostState.kind === 'present' && observed.hostState.state.live, id);
    assert.deepEqual([...observed.manifests.keys()], [id]);
    assert.equal(observed.manifests.get(id)?.image, image);
    assert.deepEqual([...observed.secrets], [id]);
    assert.deepEqual(
      observed.containers.map((container) => [container.release, container.state]),
      [[id, 'running']],
    );
    const container = observed.containers[0]?.name;
    assert.deepEqual(observed.web, { kind: 'container', container });
    assert.equal(observed.proxyImage.kind, 'pinned');
    assert.ok(w.host.fs.file(hostStateFile('myapp', undefined)) !== undefined);
  });

  it('behind the cache proxy, takes the backend its VCL names as the truth', async () => {
    const { w, a, id } = await deployed(true);
    const observed = await observe(a.client, 'host', w.config);
    const container = observed.containers.find((candidate) => candidate.release === id)?.name;
    assert.ok(container !== undefined && container !== CACHE_PROXY_CONTAINER_NAME);
    assert.deepEqual(observed.web, { kind: 'container', container });
  });
});
