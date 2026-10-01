/**
 * Tests for `scripts/lint.mjs`: the groups (every workspace in exactly one,
 * `rest` ignoring exactly the group roots, core first), each group's cache
 * file and arguments, the pool's width and output, the typed-input
 * fingerprint that keys the cache (it covers every file a type-aware verdict
 * can read: another workspace's declarations, a sibling module's source in
 * the same workspace, compiler settings, the lockfile, and nothing else), and
 * a changed fingerprint clearing every group's cache.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  cacheFileOf,
  groupArgs,
  inputFingerprint,
  lintAll,
  lintGroups,
  prepareCache,
  typedLintInputs,
} from '../lint.mjs';

const dir = mkdtempSync(join(tmpdir(), 'jsails-lint-cache-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const core = join(dir, 'core');
const pkg = join(dir, 'packages', 'a');
const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
write(join(core, 'src', 'index.ts'), "export { b } from './nested/b.js';\n");
write(join(core, 'src', 'nested', 'b.ts'), 'export function b(): void {}\n');
write(join(core, 'test', 'b.test.ts'), "import { b } from '../src/nested/b.js';\nb();\n");
write(join(core, 'dist', 'src', 'index.d.ts'), 'export declare const a: number;\n');
write(join(core, 'dist', 'src', 'index.js'), 'export const a = 1;\n');
write(join(core, 'tsconfig.json'), '{}\n');
write(join(pkg, 'dist', 'src', 'index.d.ts'), 'export {};\n');
write(join(pkg, 'README.md'), 'Docs.\n');
write(join(dir, 'website', 'pages', 'index.tsx'), 'export default 1;\n');
write(join(dir, 'website', 'content', 'docs', 'a.md'), 'Docs.\n');
write(join(dir, 'tsconfig.base.json'), '{}\n');
write(join(dir, 'package-lock.json'), '{}\n');

const fingerprint = () =>
  inputFingerprint(typedLintInputs({ root: dir, workspaces: [core, pkg] }), dir);

describe('typed-input fingerprint', () => {
  it('ignores JavaScript output, docs, and other untyped files', () => {
    const first = fingerprint();
    write(join(core, 'dist', 'src', 'index.js'), 'export const a = 2;\n');
    write(join(pkg, 'README.md'), 'Other docs.\n');
    write(join(dir, 'website', 'content', 'docs', 'a.md'), 'Other docs.\n');
    assert.equal(fingerprint(), first);
  });

  it('changes when a sibling source in the same workspace changes, without a build', () => {
    // An importer (index.ts, b.test.ts) keeps its own content, so ESLint's
    // per-file cache alone would keep its verdict on the old types.
    const before = fingerprint();
    write(join(core, 'src', 'nested', 'b.ts'), 'export async function b(): Promise<void> {}\n');
    assert.notEqual(fingerprint(), before);
  });

  it('changes when a dependency declaration changes, appears, or is renamed', () => {
    const before = fingerprint();
    write(join(core, 'dist', 'src', 'index.d.ts'), 'export declare const a: string;\n');
    const changed = fingerprint();
    assert.notEqual(changed, before);
    write(join(pkg, 'dist', 'src', 'extra.d.ts'), 'export {};\n');
    const added = fingerprint();
    assert.notEqual(added, changed);
    rmSync(join(pkg, 'dist', 'src', 'extra.d.ts'));
    write(join(pkg, 'dist', 'src', 'renamed.d.ts'), 'export {};\n');
    assert.notEqual(fingerprint(), added);
  });

  it('changes with compiler settings, the lockfile, and the docs site sources', () => {
    for (const file of [
      join(dir, 'tsconfig.base.json'),
      join(core, 'tsconfig.json'),
      join(dir, 'package-lock.json'),
      join(dir, 'website', 'pages', 'index.tsx'),
    ]) {
      const before = fingerprint();
      write(file, `${JSON.stringify({ changed: file })}\n`);
      assert.notEqual(fingerprint(), before, file);
    }
  });
});

describe('prepareCache', () => {
  const cacheDir = join(dir, 'cache');
  const stampFile = join(cacheDir, 'typed-inputs-fingerprint');
  const caches = ['core', 'packages-a', 'rest'].map((name) => cacheFileOf({ name }, cacheDir));
  const fill = () => {
    mkdirSync(cacheDir, { recursive: true });
    for (const file of caches) writeFileSync(file, '{}');
  };

  it('clears every group cache when the typed inputs changed and keeps them otherwise', () => {
    fill();
    assert.equal(prepareCache({ fingerprint: 'one', cacheDir, stampFile }), false);
    assert.deepEqual(
      caches.filter((file) => existsSync(file)),
      [],
      'a first run clears',
    );

    fill();
    assert.equal(prepareCache({ fingerprint: 'one', cacheDir, stampFile }), true);
    assert.deepEqual(
      caches.filter((file) => existsSync(file)),
      caches,
    );

    assert.equal(prepareCache({ fingerprint: 'two', cacheDir, stampFile }), false);
    assert.deepEqual(
      caches.filter((file) => existsSync(file)),
      [],
      'a typed change clears all',
    );
    assert.equal(existsSync(stampFile), true, 'the stamp is not a cache');
  });
});

describe('lintGroups', () => {
  const root = join(dir, 'repo');
  const workspaces = [join(root, 'core'), join(root, 'packages', 'a'), join(root, 'packages', 'b')];
  mkdirSync(join(root, 'website'), { recursive: true });

  it('puts every workspace in exactly one group, core first and rest last', () => {
    const groups = lintGroups({ root, workspaces: [...workspaces].reverse() });
    assert.deepEqual(
      groups.map((group) => [group.name, group.targets]),
      [
        ['core', ['core']],
        ['packages-b', ['packages/b']],
        ['packages-a', ['packages/a']],
        ['website', ['website']],
        ['rest', ['.']],
      ],
    );
    for (const dir of ['core', 'packages/a', 'packages/b', 'website']) {
      assert.equal(groups.filter((group) => group.targets.includes(dir)).length, 1, dir);
    }
  });

  it('has rest ignore exactly the other groups roots', () => {
    const groups = lintGroups({ root, workspaces });
    const rest = groups.at(-1);
    assert.deepEqual(
      [...rest.ignores].sort(),
      groups
        .slice(0, -1)
        .map((group) => `${group.targets[0]}/**`)
        .sort(),
    );
    assert.ok(groups.slice(0, -1).every((group) => group.ignores.length === 0));
  });

  it('gives core a larger heap ceiling and lease default than the other groups', () => {
    const [core, other] = lintGroups({ root, workspaces });
    assert.deepEqual([core.heapMb, core.defaultMb], [6144, 4000]);
    assert.deepEqual([other.heapMb, other.defaultMb], [3072, 900]);
  });
});

describe('groupArgs', () => {
  const rest = { name: 'rest', targets: ['.'], ignores: ['core/**', 'packages/a/**'] };

  it('lints the targets with the group cache, or with none', () => {
    assert.deepEqual(groupArgs(rest, { cached: true, forwarded: ['--fix'], cacheDir: '/c' }), [
      '.',
      '--ignore-pattern',
      'core/**',
      '--ignore-pattern',
      'packages/a/**',
      '--cache',
      '--cache-strategy',
      'content',
      '--cache-location',
      join('/c', 'rest.eslintcache'),
      '--fix',
    ]);
    assert.deepEqual(
      groupArgs({ name: 'core', targets: ['core'], ignores: [] }, { cached: false }),
      ['core', '--no-cache'],
    );
  });
});

describe('lintAll', () => {
  it('runs the groups in order, a lane at a time each, and reports every failure', async () => {
    const groups = ['core', 'packages-a', 'packages-b', 'rest'].map((name) => ({ name }));
    let running = 0;
    let widest = 0;
    const started = [];
    const output = [];
    const failures = await lintAll(groups, {
      lanes: 2,
      write: (text) => output.push(text),
      runGroup: async (group) => {
        started.push(group.name);
        running += 1;
        widest = Math.max(widest, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        const failed = group.name === 'packages-a' || group.name === 'rest';
        return { code: failed ? 1 : 0, signal: null, output: `${group.name} output\n` };
      },
    });
    assert.deepEqual(started, ['core', 'packages-a', 'packages-b', 'rest']);
    assert.equal(widest, 2);
    assert.deepEqual(
      failures.map(({ name }) => name),
      ['packages-a', 'rest'],
    );
    assert.ok(output.includes('core output\n'));
    assert.ok(output.some((line) => /lint packages-a FAILED/.test(line)));
  });

  it('reports the failures in group order, whichever ended first', async () => {
    const groups = ['core', 'packages-a', 'rest'].map((name) => ({ name }));
    const ended = [];
    const failures = await lintAll(groups, {
      lanes: 3,
      write: () => {},
      runGroup: async (group) => {
        // core, the first group, ends last and fails with its own status.
        const delays = { core: 30, 'packages-a': 0, rest: 10 };
        await new Promise((resolve) => setTimeout(resolve, delays[group.name]));
        ended.push(group.name);
        return { code: group.name === 'core' ? 2 : 1, signal: null, output: '' };
      },
    });
    assert.deepEqual(ended, ['packages-a', 'rest', 'core']);
    assert.deepEqual(failures, [
      { name: 'core', status: 2 },
      { name: 'packages-a', status: 1 },
      { name: 'rest', status: 1 },
    ]);
  });
});
