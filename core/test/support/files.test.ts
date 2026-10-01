/**
 * Tests for the server-only `Files` namespace over a temporary directory.
 *
 * The directory is made synchronously when the module loads, not in a
 * `before` hook: under a name filter that selects none of the file's tests,
 * node:test does not wait for an async top-level `before` hook before it runs
 * `after`, so a directory assigned there after an `await` would still be
 * undefined in `after` and the cleanup would fail the file.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  Files,
  FilesErrors,
  copy,
  ensureDir,
  exists,
  glob,
  move,
  readJsonFile,
  remove,
  toBase64,
  writeJson,
} from '../../src/support/files.server.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-files-'));

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Files', () => {
  it('round-trips JSON', async () => {
    const path = join(root, 'data.json');
    await writeJson(path, { a: 1, b: ['x'] });
    assert.deepEqual(await readJsonFile(path), { a: 1, b: ['x'] });
  });

  it('creates parent directories for writeJson', async () => {
    const path = join(root, 'nested', 'deep', 'data.json');
    await writeJson(path, { ok: true });
    assert.equal(await exists(path), true);
  });

  it('ensureDir creates a directory tree', async () => {
    const dir = join(root, 'made', 'by', 'ensure');
    await ensureDir(dir);
    assert.equal(await exists(dir), true);
  });

  it('exists reports false for a missing path', async () => {
    assert.equal(await exists(join(root, 'nope.txt')), false);
  });

  it('readJsonFile throws not_found for a missing file', async () => {
    await assert.rejects(
      () => readJsonFile(join(root, 'missing.json')),
      (error: unknown) => {
        assert.ok(FilesErrors.is(error));
        assert.equal(error.code, 'files.not_found');
        // Value-free: the path is not echoed.
        assert.equal(error.message.includes('missing.json'), false);
        return true;
      },
    );
  });

  it('readJsonFile throws files.invalid_json for malformed JSON', async () => {
    const path = join(root, 'bad.json');
    await writeFile(path, '{ not json ');
    await assert.rejects(
      () => readJsonFile(path),
      (error: unknown) => {
        assert.ok(FilesErrors.is(error));
        assert.equal(error.code, 'files.invalid_json');
        return true;
      },
    );
  });

  it('copy duplicates a file', async () => {
    const src = join(root, 'src.txt');
    const dest = join(root, 'dest.txt');
    await writeFile(src, 'hello');
    await copy(src, dest);
    assert.equal(await exists(dest), true);
  });

  it('move relocates a file', async () => {
    const src = join(root, 'move-src.txt');
    const dest = join(root, 'move-dest.txt');
    await writeFile(src, 'x');
    await move(src, dest);
    assert.equal(await exists(src), false);
    assert.equal(await exists(dest), true);
  });

  it('move with a missing source leaves the destination intact', async () => {
    const dest = join(root, 'move-keep');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'keep.txt'), 'precious');
    await assert.rejects(move(join(root, 'move-typo'), dest), (error: unknown) => {
      assert.ok(FilesErrors.is(error));
      assert.equal(error.code, 'files.not_found');
      return true;
    });
    assert.equal(await readFile(join(dest, 'keep.txt'), 'utf8'), 'precious');
  });

  it('move replaces an existing directory tree and leaves no staging siblings', async () => {
    const parent = join(root, 'move-tree');
    const src = join(parent, 'src');
    const dest = join(parent, 'dest');
    await mkdir(src, { recursive: true });
    await mkdir(dest, { recursive: true });
    await writeFile(join(src, 'new.txt'), 'new');
    await writeFile(join(dest, 'old.txt'), 'old');
    await move(src, dest);
    assert.deepEqual(await readdir(dest), ['new.txt']);
    assert.deepEqual(await readdir(parent), ['dest']);
  });

  it('writeJson replaces a document without leaving a staged file', async () => {
    const dir = join(root, 'json-atomic');
    const path = join(dir, 'doc.json');
    await writeJson(path, { v: 1 });
    await writeJson(path, { v: 2 });
    assert.deepEqual(await readJsonFile(path), { v: 2 });
    assert.deepEqual(await readdir(dir), ['doc.json']);
  });

  it('remove deletes a file and tolerates a missing target', async () => {
    const path = join(root, 'to-remove.txt');
    await writeFile(path, 'x');
    await remove(path);
    assert.equal(await exists(path), false);
    await remove(path); // no error
  });

  it('glob matches files by pattern', async () => {
    const dir = join(root, 'globdir');
    await ensureDir(dir);
    await writeFile(join(dir, 'a.js'), '');
    await writeFile(join(dir, 'b.js'), '');
    await writeFile(join(dir, 'c.txt'), '');
    const matches = await glob('*.js', { cwd: dir });
    assert.equal(matches.length, 2);
  });

  it('glob accepts an array of patterns', async () => {
    const dir = join(root, 'globarr');
    await ensureDir(dir);
    await writeFile(join(dir, 'a.js'), '');
    await writeFile(join(dir, 'b.txt'), '');
    const matches = await glob(['*.js', '*.txt'], { cwd: dir });
    assert.equal(matches.length, 2);
  });

  it('remove deletes a directory tree', async () => {
    const dir = join(root, 'remove-tree');
    await ensureDir(join(dir, 'inner'));
    await writeFile(join(dir, 'inner', 'f.txt'), 'x');
    await remove(dir);
    assert.equal(await exists(dir), false);
  });

  it('toBase64 encodes file bytes', async () => {
    const path = join(root, 'b64.txt');
    await writeFile(path, 'hello');
    assert.equal(await toBase64(path), Buffer.from('hello').toString('base64'));
  });

  it('exposes a frozen namespace with the same functions', () => {
    assert.equal(Files.readJsonFile, readJsonFile);
    assert.equal(Files.glob, glob);
    assert.ok(Object.isFrozen(Files));
  });

  it('passes as a file when a name filter selects none of its tests', () => {
    // A fresh node --test run of this file, outside the current run's context
    // and preload, so it is judged on its own.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.JSAILS_TEST_RECORD_DIR;
    delete env.JSAILS_TEST_FILE_PID;
    const child = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        '--test-name-pattern=^no test has this name$',
        fileURLToPath(import.meta.url),
      ],
      { encoding: 'utf8', env },
    );
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /^# fail 0$/m);
  });
});
