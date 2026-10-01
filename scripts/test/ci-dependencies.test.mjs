/**
 * Tests for `scripts/ci-dependencies.mjs`, the key, paths and check of the CI
 * dependency cache: the key changes with every input of `npm ci` (lockfile,
 * each manifest the lockfile names, each workspace the root's globs match,
 * `.npmrc`, lifecycle scripts, Node version) and with nothing else, the paths
 * are every `node_modules` the lockfile places, and a restored tree passes
 * only when each workspace or `file:` entry is a link to its target.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  cacheInputs,
  globbedWorkspaceKeys,
  installDigest,
  main,
  manifestKeys,
  treeProblems,
  treeRoots,
} from '../ci-dependencies.mjs';

const lock = {
  name: 'fixture',
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', workspaces: ['packages/*'] },
    'node_modules/@fixture/a': { resolved: 'packages/a', link: true },
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/left-pad/node_modules/inner': { version: '1.0.0' },
    'packages/a': { name: '@fixture/a', version: '1.0.0' },
    'packages/a/node_modules/nested': { version: '2.0.0' },
  },
};

/** Writes a project with the fixture lockfile and its manifests; returns its directory. */
function project(root, name) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","workspaces":["packages/*"]}');
  writeFileSync(join(dir, 'packages', 'a', 'package.json'), '{"name":"@fixture/a"}');
  return dir;
}

/** Lays out the tree `npm ci` would leave for the fixture lockfile. */
function installTree(dir) {
  mkdirSync(join(dir, 'node_modules', '@fixture'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'left-pad'));
  mkdirSync(join(dir, 'packages', 'a', 'node_modules', 'nested'), { recursive: true });
  // A junction where Windows would make one; the type is ignored elsewhere.
  symlinkSync(join(dir, 'packages', 'a'), join(dir, 'node_modules', '@fixture', 'a'), 'junction');
}

describe('ci-dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsails-ci-dependencies-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  it('reads the manifests of the root, the workspaces and the link targets', () => {
    assert.deepEqual(manifestKeys(lock), ['', 'packages/a']);
    assert.deepEqual(
      manifestKeys({ packages: { '': {}, '..': {}, '../core': {}, 'node_modules/x': {} } }),
      ['', '..', '../core'],
    );
  });

  it('caches every node_modules directory the lockfile places', () => {
    assert.deepEqual(treeRoots(lock), ['node_modules', 'packages/a/node_modules']);
  });

  it('changes the key with each install input and with nothing else', () => {
    const dir = project(root, 'digest');
    const options = { lifecycleScripts: false, nodeVersion: 'v26.13.1' };
    const base = installDigest(dir, options);
    assert.equal(installDigest(dir, options), base);
    writeFileSync(join(dir, 'README.md'), 'not an input');
    assert.equal(installDigest(dir, options), base);
    assert.notEqual(installDigest(dir, { ...options, lifecycleScripts: true }), base);
    assert.notEqual(installDigest(dir, { ...options, nodeVersion: 'v26.14.0' }), base);
    const changes = [
      ['packages/a/package.json', '{"name":"@fixture/a","dependencies":{"x":"1"}}'],
      ['package.json', '{"name":"fixture","workspaces":["packages/*"],"engines":{}}'],
      ['.npmrc', 'engine-strict=true\n'],
      ['package-lock.json', JSON.stringify({ ...lock, name: 'renamed' })],
    ];
    let previous = base;
    for (const [file, content] of changes) {
      writeFileSync(join(dir, file), content);
      const next = installDigest(dir, options);
      assert.notEqual(next, previous, file);
      previous = next;
    }
  });

  it('changes the key for a workspace the globs match but the lockfile does not list', () => {
    const dir = project(root, 'unlocked');
    const options = { lifecycleScripts: false, nodeVersion: 'v26.13.1' };
    const base = installDigest(dir, options);
    // A removed package's ignored build output is no workspace, to npm or the key.
    mkdirSync(join(dir, 'packages', 'removed', 'dist'), { recursive: true });
    assert.equal(installDigest(dir, options), base);
    assert.deepEqual(globbedWorkspaceKeys(dir), ['packages/a']);
    // Added without a relock: `npm ci` refuses it as missing from the lockfile.
    mkdirSync(join(dir, 'packages', 'b'));
    writeFileSync(join(dir, 'packages', 'b', 'package.json'), '{"name":"@fixture/b"}');
    assert.deepEqual(globbedWorkspaceKeys(dir), ['packages/a', 'packages/b']);
    assert.notEqual(installDigest(dir, options), base);
  });

  it('reads no workspaces for a manifest that declares none', () => {
    const dir = join(root, 'plain');
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), '{"name":"plain"}');
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}');
    assert.deepEqual(globbedWorkspaceKeys(dir), []);
    assert.match(installDigest(dir, { lifecycleScripts: false }), /^[0-9a-f]{64}$/);
  });

  it('names the key after the directory and Node version, with paths from the workspace', () => {
    project(root, 'site');
    const inputs = cacheInputs('site', {
      lifecycleScripts: true,
      cwd: root,
      nodeVersion: 'v26.13.1',
    });
    assert.match(inputs.key, /^site-node26\.13\.1-[0-9a-f]{64}$/);
    assert.deepEqual(inputs.paths, ['site/node_modules', 'site/packages/a/node_modules']);
    const rooted = cacheInputs('.', {
      lifecycleScripts: false,
      cwd: join(root, 'site'),
      nodeVersion: 'v26.13.1',
    });
    assert.match(rooted.key, /^root-node26\.13\.1-/);
    assert.deepEqual(rooted.paths, ['node_modules', 'packages/a/node_modules']);
  });

  it('accepts a restored tree whose links resolve to their targets', () => {
    const dir = project(root, 'restored');
    installTree(dir);
    assert.deepEqual(treeProblems(dir), []);
    assert.equal(main(['verify', dir]), 0);
  });

  it('refuses a tree with a missing root, a copied link, or a link elsewhere', () => {
    const missing = project(root, 'missing');
    assert.deepEqual(treeProblems(missing), [
      'node_modules: missing',
      'packages/a/node_modules: missing',
      'node_modules/@fixture/a: missing',
    ]);

    const copied = project(root, 'copied');
    installTree(copied);
    rmSync(join(copied, 'node_modules', '@fixture', 'a'));
    mkdirSync(join(copied, 'node_modules', '@fixture', 'a'));
    assert.deepEqual(treeProblems(copied), ['node_modules/@fixture/a: not a link']);

    const elsewhere = project(root, 'elsewhere');
    installTree(elsewhere);
    rmSync(join(elsewhere, 'node_modules', '@fixture', 'a'));
    symlinkSync(
      join(root, 'copied', 'packages', 'a'),
      join(elsewhere, 'node_modules', '@fixture', 'a'),
      'junction',
    );
    assert.deepEqual(treeProblems(elsewhere), [
      'node_modules/@fixture/a: does not resolve to packages/a',
    ]);
    assert.equal(main(['verify', elsewhere]), 1);
  });

  it('writes the key and a multi-line paths output to $GITHUB_OUTPUT', () => {
    const dir = project(root, 'output');
    const output = join(root, 'github-output');
    writeFileSync(output, '');
    assert.equal(main(['inputs', dir, 'false'], { env: { GITHUB_OUTPUT: output } }), 0);
    const text = readFileSync(output, 'utf8');
    assert.match(text, /^key=[\w.-]+-node[\d.]+-[0-9a-f]{64}\n/);
    assert.match(text, /\npaths<<(EOF_[\w-]+)\n.*node_modules\n.*packages\/a\/node_modules\n\1\n$/);
  });

  it('refuses an unknown command or a lifecycle value other than true or false', () => {
    for (const args of [[], ['inputs', '.'], ['inputs', '.', 'yes'], ['verify'], ['nope', '.']]) {
      assert.equal(main(args), 2, args.join(' '));
    }
  });
});
