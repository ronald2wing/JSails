/**
 * Tests for the footprint gate (`scripts/footprint.mjs`, gate `footprint`):
 * Node-style resolution over lockfile keys, the production closure (peers,
 * optional and platform-restricted packages, workspace links), on-disk bytes
 * without nested packages, and the budget comparison and ratchet.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  checkWorkspaces,
  compare,
  directoryBytes,
  installsOn,
  lowerBudgets,
  platformKey,
  productionClosure,
  resolveKey,
} from '../footprint.mjs';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'jsails-footprint-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const linux = { platform: 'linux', arch: 'x64', libc: 'glibc' };

const lock = {
  packages: {
    '': { name: 'root', workspaces: ['core', 'packages/*'] },
    core: {
      name: 'jsails',
      dependencies: { a: '1', b: '1' },
      optionalDependencies: { 'native-linux': '1', 'native-darwin': '1', absent: '1' },
      peerDependencies: { peer: '1', 'optional-peer': '1' },
      peerDependenciesMeta: { 'optional-peer': { optional: true } },
    },
    'packages/plugin': { name: '@x/plugin', dependencies: { jsails: '1', c: '1' } },
    'node_modules/jsails': { resolved: 'core', link: true },
    'node_modules/@x/plugin': { resolved: 'packages/plugin', link: true },
    'node_modules/a': { dependencies: { b: '2' } },
    'node_modules/a/node_modules/b': {},
    'node_modules/b': {},
    'node_modules/c': {},
    'node_modules/peer': {},
    'node_modules/optional-peer': {},
    'node_modules/native-linux': { os: ['linux'], cpu: ['x64'], optional: true },
    'node_modules/native-darwin': { os: ['darwin'], optional: true },
  },
};

describe('resolution', () => {
  it('walks from the requiring package up to the root, as Node does', () => {
    const packages = lock.packages;
    assert.equal(resolveKey(packages, 'node_modules/a', 'b'), 'node_modules/a/node_modules/b');
    assert.equal(resolveKey(packages, 'core', 'b'), 'node_modules/b');
    assert.equal(resolveKey(packages, 'packages/plugin', 'jsails'), 'node_modules/jsails');
    assert.equal(resolveKey(packages, 'node_modules/a/node_modules/b', 'c'), 'node_modules/c');
    assert.equal(resolveKey(packages, '', 'missing'), undefined);
  });

  it('honours os, cpu and libc restrictions, including negations', () => {
    assert.ok(installsOn({}, linux));
    assert.ok(installsOn({ os: ['linux'], libc: ['glibc'] }, linux));
    assert.ok(!installsOn({ os: ['darwin'] }, linux));
    assert.ok(!installsOn({ os: ['!linux'] }, linux));
    assert.ok(!installsOn({ libc: ['musl'] }, linux));
    assert.equal(platformKey(linux), 'linux-x64-glibc');
    assert.equal(platformKey({ platform: 'darwin', arch: 'arm64' }), 'darwin-arm64');
  });
});

describe('the production closure', () => {
  function installed() {
    return fixture({
      'node_modules/a/index.js': '12345',
      'node_modules/a/node_modules/b/index.js': '1',
      'node_modules/b/index.js': '12',
      'node_modules/b/lib/deep.js': '123',
      'node_modules/c/index.js': '1234567',
      'node_modules/peer/index.js': '1',
      'node_modules/optional-peer/index.js': '1111111111',
      'node_modules/native-linux/bin.node': '123456',
      'node_modules/native-darwin/bin.node': '1234',
    });
  }

  it('counts dependencies, nested versions, peers and this platform only', () => {
    const root = installed();
    assert.deepEqual(productionClosure(lock, 'core', { root, target: linux }), {
      // a, a/node_modules/b, b, peer, native-linux
      packages: 5,
      bytes: 5 + 1 + 5 + 1 + 6,
      workspaces: [],
      missing: [],
    });
  });

  it('follows a workspace link without counting the workspace itself', () => {
    const root = installed();
    const closure = productionClosure(lock, 'packages/plugin', { root, target: linux });
    assert.deepEqual(closure.workspaces, ['jsails']);
    assert.equal(closure.packages, 6);
    assert.equal(closure.bytes, 18 + 7);
  });

  it('reports a required package the lockfile does not resolve', () => {
    const broken = { packages: { core: { name: 'jsails', dependencies: { ghost: '1' } } } };
    assert.deepEqual(
      productionClosure(broken, 'core', { root: installed(), target: linux }).missing,
      ['ghost'],
    );
  });

  it('measures bytes without nested node_modules or symlinks', () => {
    const root = installed();
    assert.equal(directoryBytes(join(root, 'node_modules', 'a')), 5);
    assert.equal(directoryBytes(join(root, 'nope')), 0);
  });
});

describe('budgets', () => {
  const closure = (packages, bytes) => ({ packages, bytes, workspaces: [], missing: [] });

  it('fail growth, note shrinkage, and report a workspace without a budget', () => {
    const { failures, notes } = compare(
      { jsails: closure(10, 1000), '@x/new': closure(1, 1), '@x/small': closure(2, 50) },
      { jsails: { packages: 9, bytes: 1000 }, '@x/small': { packages: 3, bytes: 50 } },
      { section: 'workspace' },
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^jsails: production closure has 10 packages, above its budget of 9/);
    assert.equal(notes.length, 2);
    assert.match(notes[0], /^@x\/new: no workspace budget yet/);
    assert.match(notes[1], /^@x\/small: 2 packages, below its budget of 3/);
  });

  it('fail a closure with unresolved packages, and a missing preset budget when asked to', () => {
    const { failures } = compare(
      { app: { ...closure(1, 1), missing: ['ghost'] } },
      {},
      { section: 'preset', missingIsFailure: true },
    );
    assert.equal(failures.length, 2);
    assert.match(failures[0], /does not resolve ghost/);
    assert.match(failures[1], /no preset budget yet/);
  });

  it('record new budgets and only lower existing ones', () => {
    assert.deepEqual(
      lowerBudgets(
        { jsails: { packages: 9, bytes: 900 }, gone: { packages: 1, bytes: 1 } },
        { jsails: closure(10, 800), fresh: closure(2, 20) },
      ),
      { jsails: { packages: 9, bytes: 800 }, fresh: { packages: 2, bytes: 20 } },
    );
  });

  it('compare nothing on another platform', () => {
    const verdict = checkWorkspaces({
      root: '/nowhere',
      budget: {
        platform: 'plan9-mips',
        workspaces: { jsails: { packages: 0, bytes: 0 } },
        presets: {},
      },
      target: linux,
    });
    assert.deepEqual(verdict.failures, []);
    assert.match(verdict.notes[0], /recorded on plan9-mips; this is linux-x64-glibc/);
  });

  it('fail growth and a stale budget on the recorded platform', () => {
    const root = fixture({
      'package-lock.json': JSON.stringify({
        packages: { core: { name: 'jsails', dependencies: { a: '1' } }, 'node_modules/a': {} },
      }),
      'node_modules/a/index.js': '123',
    });
    const verdict = checkWorkspaces({
      root,
      budget: {
        platform: 'linux-x64-glibc',
        workspaces: { jsails: { packages: 1, bytes: 2 }, gone: { packages: 1, bytes: 1 } },
        presets: {},
      },
      target: linux,
    });
    assert.equal(verdict.failures.length, 2);
    assert.match(
      verdict.failures[0],
      /^jsails: production closure has 3 bytes, above its budget of 2/,
    );
    assert.match(verdict.failures[1], /^gone has a budget but is no workspace/);
  });
});
