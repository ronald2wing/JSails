/**
 * Tests for `createFilesExclusive`: every file created with its directories,
 * an existing file refused with nothing created, and a failure at any step
 * undone (the files written and the directories made removed) without
 * touching what another writer created in the meantime.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, describe, it } from 'node:test';

import { createFilesExclusive, type ExclusiveFilesFs } from '../../src/cli/exclusive-files.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'jsails-exclusive-files-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let sequence = 0;

function freshRoot(): string {
  const root = join(tmpRoot, `case-${sequence++}`);
  mkdirSync(root);
  return root;
}

/** Every path under `root`, directories with a trailing `/`, sorted. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        out.push(`${path}/`);
        walk(join(directory, entry.name), `${path}/`);
      } else {
        out.push(path);
      }
    }
  };
  walk(root, '');
  return out.sort();
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** The real file system, with `before` run ahead of each `writeFile`. */
function fsWith(before: (path: string) => void): ExclusiveFilesFs {
  return {
    mkdir,
    rm,
    rmdir,
    async writeFile(path, text, options) {
      before(path);
      await writeFile(path, text, options);
    },
  };
}

describe('createFilesExclusive', () => {
  it('creates every file and the directories it needs', async () => {
    const root = freshRoot();
    const result = await createFilesExclusive([
      { path: join(root, 'pages', 'about', 'about.jsails'), text: 'a' },
      { path: join(root, 'pages', 'about', 'about.ts'), text: 'b' },
      { path: join(root, 'test', 'about.test.ts'), text: 'c' },
    ]);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(tree(root), [
      'pages/',
      'pages/about/',
      'pages/about/about.jsails',
      'pages/about/about.ts',
      'test/',
      'test/about.test.ts',
    ]);
  });

  it('refuses an existing file, removing what it wrote before and the directories it made', async () => {
    const root = freshRoot();
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test', 'about.test.ts'), 'keep');
    const existing = join(root, 'test', 'about.test.ts');
    const result = await createFilesExclusive([
      { path: join(root, 'pages', 'about', 'about.jsails'), text: 'a' },
      { path: existing, text: 'c' },
    ]);
    assert.deepEqual(result, { ok: false, existing });
    assert.deepEqual(tree(root), ['test/', 'test/about.test.ts']);
    assert.equal(readFileSync(existing, 'utf8'), 'keep');
  });

  it('undoes everything it created when a write fails, and rethrows', async () => {
    const root = freshRoot();
    mkdirSync(join(root, 'pages'));
    const fs = fsWith((path) => {
      if (path.endsWith('about.ts')) throw errno('ENOSPC');
    });
    await assert.rejects(
      createFilesExclusive(
        [
          { path: join(root, 'pages', 'about', 'about.jsails'), text: 'a' },
          { path: join(root, 'pages', 'about', 'about.ts'), text: 'b' },
        ],
        fs,
      ),
      { code: 'ENOSPC' },
    );
    assert.deepEqual(tree(root), ['pages/']);
  });

  it('removes only the directories it made when mkdir spells the first one differently', async () => {
    const root = freshRoot();
    const made = join(root, 'pages', 'about');
    const removed: string[] = [];
    const fs: ExclusiveFilesFs = {
      // A real mkdir that reports the first directory under another spelling of
      // the same depth, as Windows can (an 8.3 short name, a drive-letter case).
      async mkdir(path, options) {
        const first = await mkdir(path, options);
        return first === undefined ? undefined : join(first, '..', '..', 'OTHER', 'SPELLING');
      },
      rm,
      async rmdir(path) {
        removed.push(path);
        await rmdir(path);
      },
      async writeFile() {
        throw errno('ENOSPC');
      },
    };
    await assert.rejects(
      createFilesExclusive([{ path: join(made, 'about.jsails'), text: 'a' }], fs),
      { code: 'ENOSPC' },
    );
    assert.deepEqual(removed, [made, join(root, 'pages')]);
    assert.deepEqual(tree(root), []);
  });

  it(
    'counts a backslash as part of a name on POSIX, so it never removes a directory above',
    { skip: process.platform === 'win32' ? 'a backslash separates names on Windows' : false },
    async () => {
      const root = freshRoot();
      const fs = fsWith((path) => {
        if (path.endsWith('about.jsails')) throw errno('ENOSPC');
      });
      await assert.rejects(
        createFilesExclusive([{ path: join(root, 'a', 'b\\c', 'about.jsails'), text: 'a' }], fs),
        { code: 'ENOSPC' },
      );
      assert.ok(existsSync(root), 'the directory above what it made is kept');
      assert.deepEqual(tree(root), []);
    },
  );

  it('keeps what another writer created in a directory it made, and that directory', async () => {
    const root = freshRoot();
    const other = join(root, 'pages', 'about', 'about.ts');
    const fs = fsWith((path) => {
      if (path === other) writeFileSync(other, 'theirs');
    });
    const result = await createFilesExclusive(
      [
        { path: join(root, 'pages', 'about', 'about.jsails'), text: 'a' },
        { path: other, text: 'b' },
      ],
      fs,
    );
    assert.deepEqual(result, { ok: false, existing: other });
    assert.deepEqual(tree(root), ['pages/', 'pages/about/', 'pages/about/about.ts']);
    assert.equal(readFileSync(other, 'utf8'), 'theirs');
  });

  it('rethrows a failure to make a directory, having created nothing', async () => {
    const root = freshRoot();
    writeFileSync(join(root, 'pages'), 'a file where a directory goes');
    // The code differs by platform (ENOTDIR, EEXIST); a rejection is the point.
    await assert.rejects(
      createFilesExclusive([{ path: join(root, 'pages', 'about.ts'), text: 'b' }]),
    );
    assert.deepEqual(tree(root), ['pages']);
  });
});
