/** Tests for the plugin installer: install, uninstall, rollback, and option validation over fake intake and state. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  createPluginInstaller,
  PluginInstallerError,
  type PluginInstallerOptions,
  type PluginInstaller,
} from '../../src/plugins/installer.js';
import {
  GuardedFetchError,
  createGuardedFetch,
  type GuardedConnector,
  type GuardedFetch,
  type GuardedResponse,
} from '../../src/support/guarded-fetch.server.js';
import { createDatabasePluginStateStore } from '../../src/plugins/database-state-store.js';
import { DatabasePluginState } from '../../src/plugins/database-state-entity.js';
import { PluginStateStore } from '../../src/plugins/state-store.js';
import { createEmptyDataSource } from '../../src/testing/index.js';
import { bundleManifestJson } from './manifest-fixture.js';

const BLOCK_SIZE = 512;
const encoder = new TextEncoder();

interface TarEntrySpec {
  name: string;
  content?: string | Uint8Array;
  typeflag?: string;
}

function field(value: string, length: number): Uint8Array {
  const out = new Uint8Array(length).fill(0);
  out.set(encoder.encode(value).subarray(0, length), 0);
  return out;
}

function octalField(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length).fill(0x30);
  const digits = value.toString(8);
  const start = length - 1 - digits.length;
  for (let i = 0; i < digits.length; i += 1) {
    out[start + i] = digits.charCodeAt(i);
  }
  out[length - 1] = 0;
  return out;
}

function tarHeader(spec: TarEntrySpec): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  const content =
    typeof spec.content === 'string'
      ? encoder.encode(spec.content)
      : (spec.content ?? new Uint8Array(0));
  block.set(field(spec.name, 100), 0);
  block.set(octalField(0o100644, 8), 100);
  block.set(octalField(0, 8), 108);
  block.set(octalField(0, 8), 116);
  block.set(octalField(content.length, 12), 124);
  block.set(octalField(0, 12), 136);
  block.set(field('        ', 8), 148);
  block[156] = (spec.typeflag ?? '0').charCodeAt(0);
  block.set(field('ustar', 6), 257);
  block.set(field('00', 2), 263);
  block.set(field('', 155), 345);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.set(field(`${sum.toString(8).padStart(6, '0')}\0 `, 8), 148);
  return block;
}

function tarEntry(spec: TarEntrySpec): Uint8Array {
  const content =
    typeof spec.content === 'string'
      ? encoder.encode(spec.content)
      : (spec.content ?? new Uint8Array(0));
  const padded = Math.ceil(content.length / BLOCK_SIZE) * BLOCK_SIZE;
  const out = new Uint8Array(BLOCK_SIZE + padded);
  out.set(tarHeader(spec), 0);
  out.set(content, BLOCK_SIZE);
  return out;
}

function tar(...specs: TarEntrySpec[]): Uint8Array {
  const parts = specs.map(tarEntry);
  const end = new Uint8Array(BLOCK_SIZE * 2);
  const total = parts.reduce((n, part) => n + part.length, end.length);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  out.set(end, offset);
  return out;
}

function tgz(...specs: TarEntrySpec[]): Uint8Array {
  return gzipSync(tar(...specs));
}

function manifest(id = 'acme-tasks', version = '1.0.0'): Record<string, unknown> {
  return bundleManifestJson({ id, version, jsailsCompat: '^0.1.0', entry: './index.js' });
}

function bundleTgz(
  m: Record<string, unknown>,
  files: Record<string, string> = {},
  prefix = 'package',
): Uint8Array {
  const entries: TarEntrySpec[] = [
    { name: `${prefix}/`, typeflag: '5' },
    { name: `${prefix}/manifest.json`, content: JSON.stringify(m) },
    ...Object.entries(files).map(([name, content]) => ({
      name: `${prefix}/${name}`,
      content,
    })),
  ];
  return tgz(...entries);
}

function bytesResponse(bytes: Uint8Array, status = 200): GuardedResponse {
  return { status, headers: new Headers(), bytes: bytes.slice(), url: '' };
}

function fetchReturning(bytes: Uint8Array): GuardedFetch {
  return async () => bytesResponse(bytes);
}

/** A connector that records each vetted address and refuses to connect. */
function refusingConnector(): { readonly connect: GuardedConnector; readonly targets: string[] } {
  const targets: string[] = [];
  return {
    targets,
    connect: async (target) => {
      targets.push(target.address);
      throw new Error('ECONNREFUSED');
    },
  };
}

/** A connector that reaches a loopback IPv4 server on the target's port, whatever its address. */
const loopbackConnector: GuardedConnector = (target) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: target.port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });

/** Serve `bytes` over plain http on a loopback port for the length of `run`. */
async function servingOverHttp(
  bytes: Uint8Array,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer((_request, response) => response.end(bytes));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function listDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const URL_1 = 'https://registry.example/plugins/acme-tasks-1.0.0.tgz';
const URL_2 = 'https://registry.example/plugins/acme-tasks-2.0.0.tgz';

let tempRoot: string;
let pluginsDir: string;
let stateStore: PluginStateStore;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'jsails-plugin-installer-'));
  pluginsDir = join(tempRoot, 'plugins');
  stateStore = new PluginStateStore({ pluginsDir });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/**
 * An installer whose installs default to `allowUnverified`, for tests about
 * everything but integrity; the integrity tests use {@link makeStrictInstaller}.
 */
function makeInstaller(overrides: Partial<PluginInstallerOptions> = {}): PluginInstaller {
  const installer = makeStrictInstaller(overrides);
  return {
    install: (input) => installer.install({ allowUnverified: true, ...input }),
    uninstall: (id, options) => installer.uninstall(id, options),
    rollback: (id, version) => installer.rollback(id, version),
  };
}

/** Resolves every host name to a public address, so no test touches real DNS. */
const publicResolve = async (): Promise<readonly string[]> => ['93.184.215.14'];

function makeStrictInstaller(overrides: Partial<PluginInstallerOptions> = {}): PluginInstaller {
  return createPluginInstaller({ pluginsDir, stateStore, ...overrides });
}

const UNVERIFIED_WARNING =
  'plugin bundle integrity was not verified (installed with allowUnverified)';

describe('PluginInstaller.install', () => {
  it('downloads, extracts, and installs a bundle, recording state', async () => {
    const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'), {
      'index.js': 'module.exports = 1;',
    });
    const installer = makeStrictInstaller({ fetch: fetchReturning(bytes) });

    const result = await installer.install({
      id: 'acme-tasks',
      version: '1.0.0',
      url: URL_1,
      checksums: { 'acme-tasks-1.0.0.tgz': sha256(bytes) },
    });

    assert.deepEqual(result, {
      id: 'acme-tasks',
      version: '1.0.0',
      warnings: [],
    });
    assert.equal(
      readFileSync(join(pluginsDir, 'acme-tasks', '1.0.0', 'index.js'), 'utf8'),
      'module.exports = 1;',
    );
    assert.deepEqual(stateStore.load().plugins, {
      'acme-tasks': { active: '1.0.0', enabled: true },
    });
  });

  it('stores the bundle flattened, so its manifest is at the version root', async () => {
    const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'), { 'lib/index.js': 'x' });
    const installer = makeInstaller({ fetch: fetchReturning(bytes) });

    await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });
    assert.deepEqual(listDir(join(pluginsDir, 'acme-tasks', '1.0.0')), ['lib', 'manifest.json']);
  });

  it('refuses an archive with a second manifest.json at any depth', async () => {
    const cases: TarEntrySpec[][] = [
      [
        { name: 'a/manifest.json', content: JSON.stringify(manifest('acme-tasks', '1.0.0')) },
        { name: 'b/c/manifest.json', content: JSON.stringify(manifest('evil-plugin', '1.0.0')) },
      ],
      [
        { name: 'package/manifest.json', content: JSON.stringify(manifest()) },
        {
          name: 'package/node_modules/other/manifest.json',
          content: JSON.stringify(manifest('other', '9.9.9')),
        },
      ],
      [
        { name: 'manifest.json', content: JSON.stringify(manifest()) },
        { name: 'nested/MANIFEST.JSON', content: JSON.stringify(manifest('other', '9.9.9')) },
      ],
    ];
    for (const entries of cases) {
      const installer = makeInstaller({ fetch: fetchReturning(tgz(...entries)) });
      await assert.rejects(
        installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 }),
        (error: unknown) =>
          error instanceof PluginInstallerError && error.code === 'multiple_manifests',
      );
    }
    assert.deepEqual(listDir(pluginsDir), []);
  });

  it('refuses an archive whose only manifest is not at its root', async () => {
    const bytes = tgz({
      name: 'package/sub/manifest.json',
      content: JSON.stringify(manifest()),
    });
    const installer = makeInstaller({ fetch: fetchReturning(bytes) });
    await assert.rejects(
      installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 }),
      (error: unknown) =>
        error instanceof PluginInstallerError && error.code === 'manifest_missing',
    );
  });

  it('is idempotent on repeat and never overwrites an existing version', async () => {
    const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'), {
      'index.js': 'ORIGINAL',
    });
    const installer = makeInstaller({ fetch: fetchReturning(bytes) });

    await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });

    // Second install over the same version, this time with different contents.
    const changed = bundleTgz(manifest('acme-tasks', '1.0.0'), {
      'index.js': 'CHANGED',
    });
    const installer2 = makeInstaller({ fetch: fetchReturning(changed) });
    await installer2.install({
      id: 'acme-tasks',
      version: '1.0.0',
      url: URL_1,
    });

    assert.equal(
      readFileSync(join(pluginsDir, 'acme-tasks', '1.0.0', 'index.js'), 'utf8'),
      'ORIGINAL',
    );
  });

  it('verifies a correct SHA-256 checksum keyed by the URL basename', async () => {
    const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'));
    const installer = makeInstaller({ fetch: fetchReturning(bytes) });

    await installer.install({
      id: 'acme-tasks',
      version: '1.0.0',
      url: URL_1,
      checksums: { 'acme-tasks-1.0.0.tgz': `sha256-${sha256(bytes)}` },
    });
    assert.ok(existsSync(join(pluginsDir, 'acme-tasks', '1.0.0')));
  });

  it('rejects a checksum mismatch, leaving prior state/files untouched and no staging leftovers', async () => {
    const v1 = bundleTgz(manifest('acme-tasks', '1.0.0'), {
      'index.js': 'KEEP',
    });
    const installer = makeInstaller({ fetch: fetchReturning(v1) });
    await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });

    const v2 = bundleTgz(manifest('acme-tasks', '2.0.0'), {
      'index.js': 'EVIL',
    });
    const installer2 = makeInstaller({ fetch: fetchReturning(v2) });

    await assert.rejects(
      () =>
        installer2.install({
          id: 'acme-tasks',
          version: '2.0.0',
          url: URL_2,
          checksums: { 'acme-tasks-2.0.0.tgz': 'sha256-'.padEnd(71, '0') },
        }),
      (error: unknown) =>
        error instanceof PluginInstallerError && error.code === 'checksum_mismatch',
    );

    assert.equal(readFileSync(join(pluginsDir, 'acme-tasks', '1.0.0', 'index.js'), 'utf8'), 'KEEP');
    assert.equal(existsSync(join(pluginsDir, 'acme-tasks', '2.0.0')), false);
    assert.deepEqual(stateStore.load().plugins, {
      'acme-tasks': { active: '1.0.0', enabled: true },
    });
    assert.equal(
      listDir(pluginsDir).some((name) => name.startsWith('.staging-')),
      false,
    );
  });

  it('verifies the signature when a verifier is provided', async () => {
    const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'));
    const calls: Array<[Uint8Array, string]> = [];
    const installer = makeInstaller({
      fetch: fetchReturning(bytes),
      verifySignature: async (data, signature) => {
        calls.push([data, signature]);
        return true;
      },
    });

    await installer.install({
      id: 'acme-tasks',
      version: '1.0.0',
      url: URL_1,
      signature: 'detached-sig',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]![1], 'detached-sig');
    assert.equal(Buffer.from(calls[0]![0]).toString('hex'), Buffer.from(bytes).toString('hex'));
  });

  it('rejects an invalid signature', async () => {
    const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'));
    const installer = makeInstaller({
      fetch: fetchReturning(bytes),
      verifySignature: async () => false,
    });

    await assert.rejects(
      () =>
        installer.install({
          id: 'acme-tasks',
          version: '1.0.0',
          url: URL_1,
          signature: 'sig',
        }),
      (error: unknown) =>
        error instanceof PluginInstallerError && error.code === 'signature_invalid',
    );
    assert.equal(existsSync(join(pluginsDir, 'acme-tasks')), false);
  });

  it('refuses a signature it cannot verify, even with allowUnverified', async () => {
    const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'));
    const installer = makeInstaller({ fetch: fetchReturning(bytes) });

    await assert.rejects(
      () =>
        installer.install({
          id: 'acme-tasks',
          version: '1.0.0',
          url: URL_1,
          signature: 'sig',
        }),
      (error: unknown) =>
        error instanceof PluginInstallerError && error.code === 'signature_unverifiable',
    );
    assert.equal(existsSync(join(pluginsDir, 'acme-tasks')), false);
  });

  it('refuses a bundle with neither a checksum nor a signature', async () => {
    const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'));
    const installer = makeStrictInstaller({ fetch: fetchReturning(bytes) });

    await assert.rejects(
      () => installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 }),
      (error: unknown) =>
        error instanceof PluginInstallerError && error.code === 'unverified_bundle',
    );
    assert.equal(existsSync(join(pluginsDir, 'acme-tasks')), false);
    assert.deepEqual(stateStore.load().plugins, {});
  });

  it('installs an unverified bundle only when allowUnverified is set, with a warning', async () => {
    const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'));
    const installer = makeStrictInstaller({ fetch: fetchReturning(bytes) });

    const result = await installer.install({
      id: 'acme-tasks',
      version: '1.0.0',
      url: URL_1,
      allowUnverified: true,
    });
    assert.deepEqual(result.warnings, [UNVERIFIED_WARNING]);
    assert.ok(existsSync(join(pluginsDir, 'acme-tasks', '1.0.0')));
  });

  it('refuses a bundle over non-loopback http, checksummed or not, before connecting', async () => {
    const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'));
    const connector = refusingConnector();
    for (const allowPrivateHosts of [false, true]) {
      const installer = makeStrictInstaller({
        fetch: createGuardedFetch({ resolve: publicResolve, connect: connector.connect }),
        allowPrivateHosts,
      });
      for (const integrity of [
        { allowUnverified: true },
        { checksums: { 'acme-tasks-1.0.0.tgz': sha256(bytes) } },
      ]) {
        await assert.rejects(
          installer.install({
            id: 'acme-tasks',
            version: '1.0.0',
            url: 'http://registry.example/plugins/acme-tasks-1.0.0.tgz',
            ...integrity,
          }),
          (error: unknown) => error instanceof PluginInstallerError && error.code === 'invalid_url',
        );
      }
    }
    assert.deepEqual(connector.targets, []);
    assert.equal(existsSync(join(pluginsDir, 'acme-tasks')), false);
  });

  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    it(`refuses loopback ${host} unless the installer allows private hosts`, async () => {
      const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'));
      const connector = refusingConnector();
      const installer = makeStrictInstaller({
        fetch: createGuardedFetch({
          resolve: async () => ['127.0.0.1'],
          connect: connector.connect,
        }),
      });
      await assert.rejects(
        installer.install({
          id: 'acme-tasks',
          version: '1.0.0',
          url: `https://${host}:8080/acme-tasks-1.0.0.tgz`,
          checksums: { 'acme-tasks-1.0.0.tgz': sha256(bytes) },
        }),
        (error: unknown) =>
          error instanceof PluginInstallerError && error.code === 'private_address',
      );
      assert.deepEqual(connector.targets, []);
    });

    it(`allows an unverified bundle over http from loopback ${host} with allowPrivateHosts`, async () => {
      const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'));
      await servingOverHttp(bytes, async (port) => {
        const installer = makeStrictInstaller({
          fetch: createGuardedFetch({
            resolve: async () => ['127.0.0.1'],
            connect: loopbackConnector,
          }),
          allowPrivateHosts: true,
        });
        const result = await installer.install({
          id: 'acme-tasks',
          version: '1.0.0',
          url: `http://${host}:${port}/acme-tasks-1.0.0.tgz`,
          allowUnverified: true,
        });
        assert.deepEqual(result.warnings, [UNVERIFIED_WARNING]);
      });
    });
  }

  it('refuses a download url that is not https or http', async () => {
    let fetched = false;
    const installer = makeInstaller({
      fetch: async () => {
        fetched = true;
        return bytesResponse(bundleTgz(manifest()));
      },
    });
    for (const url of ['file:///etc/passwd', 'data:application/gzip;base64,AA==', 'not a url']) {
      await assert.rejects(
        () => installer.install({ id: 'acme-tasks', version: '1.0.0', url }),
        (error: unknown) => error instanceof PluginInstallerError && error.code === 'invalid_url',
      );
    }
    assert.equal(fetched, false);
  });

  it('rejects a manifest whose id does not match the request', async () => {
    const bytes = bundleTgz(manifest('other-plugin', '1.0.0'));
    const installer = makeInstaller({ fetch: fetchReturning(bytes) });

    await assert.rejects(
      () => installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 }),
      (error: unknown) =>
        error instanceof PluginInstallerError && error.code === 'manifest_mismatch',
    );
    assert.equal(existsSync(join(pluginsDir, 'acme-tasks')), false);
    assert.equal(existsSync(join(pluginsDir, 'other-plugin')), false);
  });

  it('rejects a manifest whose version does not match the request', async () => {
    const bytes = bundleTgz(manifest('acme-tasks', '9.9.9'));
    const installer = makeInstaller({ fetch: fetchReturning(bytes) });

    await assert.rejects(
      () => installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 }),
      (error: unknown) =>
        error instanceof PluginInstallerError && error.code === 'manifest_mismatch',
    );
  });

  it('bounds the download by maxBytes and installs nothing when it is exceeded', async () => {
    const limits: number[] = [];
    const installer = makeInstaller({
      fetch: async (_url, options) => {
        limits.push(options.maxBytes);
        throw new GuardedFetchError('too_large', 'the response exceeds the size limit');
      },
      maxBytes: 128,
    });

    await assert.rejects(
      () => installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 }),
      (error: unknown) =>
        error instanceof PluginInstallerError && error.code === 'oversize_download',
    );
    assert.deepEqual(limits, [128]);
    assert.equal(existsSync(join(pluginsDir, 'acme-tasks')), false);
    assert.equal(
      listDir(pluginsDir).some((name) => name.startsWith('.staging-')),
      false,
    );
  });

  it('sanitizes fetch failures without echoing credentials in the URL', async () => {
    const secret = 'super-secret-password';
    const url = `https://user:${secret}@registry.example/plugins/pkg.tgz`;
    const installer = makeInstaller({
      fetch: async (requested) => {
        throw new Error(`boom while fetching ${requested}`);
      },
    });

    await assert.rejects(
      () => installer.install({ id: 'acme-tasks', version: '1.0.0', url }),
      (error: unknown) =>
        error instanceof PluginInstallerError &&
        error.code === 'fetch_failed' &&
        !error.message.includes(secret) &&
        !error.message.includes(url),
    );
  });

  it('rejects a non-2xx download response', async () => {
    const installer = makeInstaller({
      fetch: async () => bytesResponse(encoder.encode('not found'), 404),
    });

    await assert.rejects(
      () => installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 }),
      (error: unknown) => error instanceof PluginInstallerError && error.code === 'fetch_failed',
    );
  });

  it('rejects an invalid id or version without touching the filesystem', async () => {
    const installer = makeInstaller({
      fetch: fetchReturning(bundleTgz(manifest())),
    });

    await assert.rejects(
      () => installer.install({ id: 'Bad Id!', version: '1.0.0', url: URL_1 }),
      (error: unknown) => error instanceof PluginInstallerError && error.code === 'invalid_id',
    );
    await assert.rejects(
      () =>
        installer.install({
          id: 'acme-tasks',
          version: 'not-semver',
          url: URL_1,
        }),
      (error: unknown) => error instanceof PluginInstallerError && error.code === 'invalid_version',
    );
  });

  it('serializes concurrent installs per pluginsDir', async () => {
    const v1 = bundleTgz(manifest('acme-tasks', '1.0.0'));
    const v2 = bundleTgz(manifest('acme-tasks', '2.0.0'));

    let active = 0;
    let maxActive = 0;
    const fetch: GuardedFetch = async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active -= 1;
      return bytesResponse(url === URL_1 ? v1 : v2);
    };

    const installer = makeInstaller({ fetch });

    await Promise.all([
      installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 }),
      installer.install({ id: 'acme-tasks', version: '2.0.0', url: URL_2 }),
    ]);

    assert.equal(maxActive, 1, 'downloads must be serialized, not concurrent');
    assert.ok(existsSync(join(pluginsDir, 'acme-tasks', '1.0.0')));
    assert.ok(existsSync(join(pluginsDir, 'acme-tasks', '2.0.0')));
    assert.equal(stateStore.load().plugins['acme-tasks']?.active, '2.0.0');
  });

  it('refuses a bundle whose declared plugin dependency is not installed', async () => {
    const bytes = bundleTgz({
      ...manifest('acme-tasks', '1.0.0'),
      plugins: [{ id: 'acme-core', range: '^1.0.0' }],
    });
    const installer = makeInstaller({ fetch: fetchReturning(bytes) });

    await assert.rejects(
      () => installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 }),
      (error: unknown) =>
        error instanceof PluginInstallerError &&
        error.code === 'unsatisfied_dependency' &&
        error.message.includes('acme-core'),
    );

    // The refused install leaves no files, no state, and no staging leftovers.
    assert.equal(existsSync(join(pluginsDir, 'acme-tasks')), false);
    assert.deepEqual(stateStore.load().plugins, {});
    assert.equal(
      listDir(pluginsDir).some((name) => name.startsWith('.staging-')),
      false,
    );
  });

  it('installs a bundle whose declared dependency is already installed', async () => {
    const core = bundleTgz(manifest('acme-core', '1.2.0'));
    const installer = makeInstaller({ fetch: fetchReturning(core) });
    await installer.install({
      id: 'acme-core',
      version: '1.2.0',
      url: 'https://registry.example/plugins/acme-core-1.2.0.tgz',
    });

    const tasks = bundleTgz({
      ...manifest('acme-tasks', '1.0.0'),
      plugins: [{ id: 'acme-core', range: '^1.0.0' }],
    });
    const installer2 = makeInstaller({ fetch: fetchReturning(tasks) });
    const result = await installer2.install({
      id: 'acme-tasks',
      version: '1.0.0',
      url: URL_1,
    });

    assert.equal(result.version, '1.0.0');
    assert.ok(existsSync(join(pluginsDir, 'acme-tasks', '1.0.0')));
  });

  it('refuses a bundle whose installed dependency version does not satisfy the range', async () => {
    const core = bundleTgz(manifest('acme-core', '2.0.0'));
    const installer = makeInstaller({ fetch: fetchReturning(core) });
    await installer.install({
      id: 'acme-core',
      version: '2.0.0',
      url: 'https://registry.example/plugins/acme-core-2.0.0.tgz',
    });

    const tasks = bundleTgz({
      ...manifest('acme-tasks', '1.0.0'),
      plugins: [{ id: 'acme-core', range: '^1.0.0' }],
    });
    const installer2 = makeInstaller({ fetch: fetchReturning(tasks) });
    await assert.rejects(
      () => installer2.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 }),
      (error: unknown) =>
        error instanceof PluginInstallerError && error.code === 'unsatisfied_dependency',
    );
    assert.equal(existsSync(join(pluginsDir, 'acme-tasks')), false);
  });

  it('installs a bundle with an unsatisfied dependency when force is set', async () => {
    const tasks = bundleTgz({
      ...manifest('acme-tasks', '1.0.0'),
      plugins: [{ id: 'acme-core', range: '^1.0.0' }],
    });
    const installer = makeInstaller({ fetch: fetchReturning(tasks) });

    const result = await installer.install({
      id: 'acme-tasks',
      version: '1.0.0',
      url: URL_1,
      force: true,
    });
    assert.equal(result.version, '1.0.0');
    assert.ok(existsSync(join(pluginsDir, 'acme-tasks', '1.0.0')));
  });

  it('satisfies a dependency against any installed version, not only the active one', async () => {
    const core1 = bundleTgz(manifest('acme-core', '1.0.0'));
    const core2 = bundleTgz(manifest('acme-core', '2.0.0'));
    const installer = makeInstaller({
      fetch: (url) => Promise.resolve(bytesResponse(url.includes('1.0.0') ? core1 : core2)),
    });
    await installer.install({
      id: 'acme-core',
      version: '1.0.0',
      url: 'https://registry.example/plugins/acme-core-1.0.0.tgz',
    });
    await installer.install({
      id: 'acme-core',
      version: '2.0.0',
      url: 'https://registry.example/plugins/acme-core-2.0.0.tgz',
    });
    // Roll the active version back to 1.0.0; 2.0.0 stays installed on disk.
    await installer.rollback('acme-core', '1.0.0');

    const tasks = bundleTgz({
      ...manifest('acme-tasks', '1.0.0'),
      plugins: [{ id: 'acme-core', range: '^2.0.0' }],
    });
    const installer2 = makeInstaller({ fetch: fetchReturning(tasks) });
    const result = await installer2.install({
      id: 'acme-tasks',
      version: '1.0.0',
      url: URL_1,
    });

    assert.equal(result.version, '1.0.0');
    assert.ok(existsSync(join(pluginsDir, 'acme-tasks', '1.0.0')));
  });

  it('installs normally when the manifest declares no plugins field', async () => {
    const bytes = bundleTgz(manifest('acme-tasks', '1.0.0'));
    const installer = makeInstaller({ fetch: fetchReturning(bytes) });

    const result = await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });
    assert.equal(result.version, '1.0.0');
  });

  it('hands the input allowedHosts to the guard and installs nothing when it refuses a hop', async () => {
    const hostLists: (readonly string[] | undefined)[] = [];
    const installer = makeInstaller({
      fetch: async (_url, options) => {
        hostLists.push(options.allowHosts);
        throw new GuardedFetchError('host_not_allowed', 'the url host is not allowed');
      },
    });

    await assert.rejects(
      installer.install({
        id: 'acme-tasks',
        version: '1.0.0',
        url: URL_1,
        allowedHosts: ['registry.example'],
      }),
      (error: unknown) => error instanceof PluginInstallerError && error.code === 'invalid_url',
    );
    assert.deepEqual(hostLists, [['registry.example']]);
    assert.deepEqual(listDir(pluginsDir), []);
  });

  it('rejects a malformed download policy before any request', async () => {
    let requests = 0;
    const installer = makeInstaller({
      fetch: () => {
        requests += 1;
        return Promise.resolve(bytesResponse(new Uint8Array(0), 404));
      },
    });
    for (const policy of [
      { allowedHosts: 'registry.example' as unknown as readonly string[] },
      { allowedHosts: [''] },
    ]) {
      await assert.rejects(
        installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1, ...policy }),
        (error: unknown) =>
          error instanceof PluginInstallerError && error.code === 'invalid_options',
      );
    }
    assert.equal(requests, 0);
  });
});

describe('PluginInstaller.uninstall', () => {
  it('removes only the owned plugin directory and clears its state entry', async () => {
    const v1 = bundleTgz(manifest('acme-tasks', '1.0.0'));
    const v2 = bundleTgz(manifest('other-tasks', '1.0.0'));
    const installer = makeInstaller({
      fetch: (url) => Promise.resolve(bytesResponse(url === URL_1 ? v1 : v2)),
    });

    await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });
    await installer.install({
      id: 'other-tasks',
      version: '1.0.0',
      url: 'https://x/other-tasks-1.0.0.tgz',
    });

    // An unrelated, non-plugin directory must survive an uninstall.
    mkdirSync(join(pluginsDir, 'unrelated'), { recursive: true });

    await installer.uninstall('acme-tasks');

    assert.equal(existsSync(join(pluginsDir, 'acme-tasks')), false);
    assert.ok(existsSync(join(pluginsDir, 'other-tasks')));
    assert.ok(existsSync(join(pluginsDir, 'unrelated')));
    assert.deepEqual(stateStore.load().plugins, {
      'other-tasks': { active: '1.0.0', enabled: true },
    });
  });

  it('refuses to remove a symlinked plugin directory', async () => {
    const target = join(tempRoot, 'real-target');
    mkdirSync(target, { recursive: true });
    mkdirSync(pluginsDir, { recursive: true });
    symlinkSync(target, join(pluginsDir, 'acme-tasks'));

    const installer = makeInstaller({
      fetch: fetchReturning(bundleTgz(manifest())),
    });

    await assert.rejects(
      () => installer.uninstall('acme-tasks'),
      (error: unknown) =>
        error instanceof PluginInstallerError && error.code === 'unsafe_uninstall',
    );
    assert.equal(lstatSync(join(pluginsDir, 'acme-tasks')).isSymbolicLink(), true);
  });

  it('is a no-op for an unknown plugin', async () => {
    const installer = makeInstaller({
      fetch: fetchReturning(bundleTgz(manifest())),
    });
    await installer.uninstall('missing');
    assert.deepEqual(stateStore.load().plugins, {});
  });

  it('refuses to uninstall a plugin another installed bundle depends on', async () => {
    const core = bundleTgz(manifest('acme-core', '1.0.0'));
    const tasks = bundleTgz({
      ...manifest('acme-tasks', '1.0.0'),
      plugins: [{ id: 'acme-core', range: '^1.0.0' }],
    });
    const installer = makeInstaller({
      fetch: (url) => Promise.resolve(bytesResponse(url.includes('core') ? core : tasks)),
    });
    await installer.install({
      id: 'acme-core',
      version: '1.0.0',
      url: 'https://registry.example/plugins/acme-core-1.0.0.tgz',
    });
    await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });

    await assert.rejects(
      () => installer.uninstall('acme-core'),
      (error: unknown) => error instanceof PluginInstallerError && error.code === 'required_by',
    );

    // The blocked uninstall leaves the plugin and its files intact.
    assert.ok(existsSync(join(pluginsDir, 'acme-core', '1.0.0')));
    assert.equal(stateStore.load().plugins['acme-core']?.active, '1.0.0');
  });

  it('uninstalls a still-required plugin when force is set', async () => {
    const core = bundleTgz(manifest('acme-core', '1.0.0'));
    const tasks = bundleTgz({
      ...manifest('acme-tasks', '1.0.0'),
      plugins: [{ id: 'acme-core', range: '^1.0.0' }],
    });
    const installer = makeInstaller({
      fetch: (url) => Promise.resolve(bytesResponse(url.includes('core') ? core : tasks)),
    });
    await installer.install({
      id: 'acme-core',
      version: '1.0.0',
      url: 'https://registry.example/plugins/acme-core-1.0.0.tgz',
    });
    await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });

    await installer.uninstall('acme-core', { force: true });
    assert.equal(existsSync(join(pluginsDir, 'acme-core')), false);
    assert.equal(stateStore.load().plugins['acme-core'], undefined);
  });

  it('uninstalls a plugin once no installed bundle depends on it', async () => {
    const core = bundleTgz(manifest('acme-core', '1.0.0'));
    const tasks = bundleTgz({
      ...manifest('acme-tasks', '1.0.0'),
      plugins: [{ id: 'acme-core', range: '^1.0.0' }],
    });
    const installer = makeInstaller({
      fetch: (url) => Promise.resolve(bytesResponse(url.includes('core') ? core : tasks)),
    });
    await installer.install({
      id: 'acme-core',
      version: '1.0.0',
      url: 'https://registry.example/plugins/acme-core-1.0.0.tgz',
    });
    await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });

    // Remove the dependent first, then the now-orphaned plugin uninstalls.
    await installer.uninstall('acme-tasks');
    await installer.uninstall('acme-core');
    assert.equal(existsSync(join(pluginsDir, 'acme-core')), false);
    assert.deepEqual(stateStore.load().plugins, {});
  });
});

describe('PluginInstaller.rollback', () => {
  it('flips the active version without deleting files', async () => {
    const v1 = bundleTgz(manifest('acme-tasks', '1.0.0'));
    const v2 = bundleTgz(manifest('acme-tasks', '2.0.0'));
    const installer = makeInstaller({
      fetch: (url) => Promise.resolve(bytesResponse(url === URL_1 ? v1 : v2)),
    });

    await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });
    await installer.install({ id: 'acme-tasks', version: '2.0.0', url: URL_2 });
    assert.equal(stateStore.load().plugins['acme-tasks']?.active, '2.0.0');

    await installer.rollback('acme-tasks', '1.0.0');

    assert.equal(stateStore.load().plugins['acme-tasks']?.active, '1.0.0');
    assert.equal(stateStore.load().plugins['acme-tasks']?.enabled, true);
    assert.ok(existsSync(join(pluginsDir, 'acme-tasks', '1.0.0')));
    assert.ok(existsSync(join(pluginsDir, 'acme-tasks', '2.0.0')));
  });

  it('keeps settings and a disabled flag across an upgrade and a rollback', async () => {
    const v1 = bundleTgz(manifest('acme-tasks', '1.0.0'));
    const v2 = bundleTgz(manifest('acme-tasks', '2.0.0'));
    const installer = makeInstaller({
      fetch: (url) => Promise.resolve(bytesResponse(url === URL_1 ? v1 : v2)),
    });
    await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });
    stateStore.save({
      version: 1,
      plugins: {
        'acme-tasks': { active: '1.0.0', enabled: false, settings: { apiBase: '/x' } },
      },
    });

    await installer.install({ id: 'acme-tasks', version: '2.0.0', url: URL_2 });
    assert.deepEqual(stateStore.load().plugins['acme-tasks'], {
      active: '2.0.0',
      enabled: false,
      settings: { apiBase: '/x' },
    });

    await installer.rollback('acme-tasks', '1.0.0');
    assert.deepEqual(stateStore.load().plugins['acme-tasks'], {
      active: '1.0.0',
      enabled: false,
      settings: { apiBase: '/x' },
    });
  });

  it('rejects an unknown plugin id', async () => {
    const installer = makeInstaller({
      fetch: fetchReturning(bundleTgz(manifest())),
    });
    await assert.rejects(
      () => installer.rollback('missing', '1.0.0'),
      (error: unknown) => error instanceof PluginInstallerError && error.code === 'unknown_plugin',
    );
  });

  it('rejects a version that is not installed', async () => {
    const installer = makeInstaller({
      fetch: fetchReturning(bundleTgz(manifest('acme-tasks', '1.0.0'))),
    });
    await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });

    await assert.rejects(
      () => installer.rollback('acme-tasks', '9.9.9'),
      (error: unknown) => error instanceof PluginInstallerError && error.code === 'unknown_version',
    );
  });
});

describe('PluginInstaller state writes', () => {
  it('keeps an install made between another store reading and saving its snapshot', async () => {
    // Two stores on one database stand for the app and the CLI beside it.
    const dataSource = await createEmptyDataSource([DatabasePluginState], {
      location: join(tempRoot, 'state.db'),
    });
    try {
      const appStore = createDatabasePluginStateStore({ dataSource });
      const cliStore = createDatabasePluginStateStore({ dataSource });
      await appStore.putEntry('acme-core', { active: '1.0.0', enabled: true });

      // The app reads its snapshot (an admin settings form), ...
      const snapshot = await appStore.load();
      // ... the CLI installs a plugin, ...
      const installer = makeInstaller({
        stateStore: cliStore,
        fetch: fetchReturning(bundleTgz(manifest('acme-tasks', '1.0.0'))),
      });
      await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });
      // ... and the app writes its snapshot back with the edited settings.
      await appStore.save({
        ...snapshot,
        plugins: {
          ...snapshot.plugins,
          'acme-core': { active: '1.0.0', enabled: true, settings: { retries: 3 } },
        },
      });

      assert.deepEqual((await appStore.load()).plugins, {
        'acme-core': { active: '1.0.0', enabled: true, settings: { retries: 3 } },
        'acme-tasks': { active: '1.0.0', enabled: true },
      });
    } finally {
      await dataSource.destroy();
    }
  });

  it('touches only the uninstalled id in a database store', async () => {
    const dataSource = await createEmptyDataSource([DatabasePluginState], {
      location: join(tempRoot, 'uninstall.db'),
    });
    try {
      const store = createDatabasePluginStateStore({ dataSource });
      const installer = makeInstaller({
        stateStore: store,
        fetch: fetchReturning(bundleTgz(manifest('acme-tasks', '1.0.0'))),
      });
      await installer.install({ id: 'acme-tasks', version: '1.0.0', url: URL_1 });
      await store.putEntry('acme-core', { active: '2.0.0', enabled: false });

      await installer.uninstall('acme-tasks');

      assert.deepEqual((await store.load()).plugins, {
        'acme-core': { active: '2.0.0', enabled: false },
      });
    } finally {
      await dataSource.destroy();
    }
  });
});

describe('createPluginInstaller options', () => {
  it('rejects a non-boolean allowPrivateHosts and a non-function fetch', () => {
    assert.throws(
      () => createPluginInstaller({ pluginsDir, allowPrivateHosts: 'yes' as unknown as boolean }),
      (error: unknown) => error instanceof PluginInstallerError && error.code === 'invalid_options',
    );
    assert.throws(
      () => createPluginInstaller({ pluginsDir, fetch: 1 as never }),
      (error: unknown) => error instanceof PluginInstallerError && error.code === 'invalid_options',
    );
  });

  it('rejects a non-positive maxBytes', () => {
    assert.throws(
      () => createPluginInstaller({ pluginsDir, maxBytes: 0 }),
      (error: unknown) => error instanceof PluginInstallerError && error.code === 'invalid_options',
    );
  });
});
