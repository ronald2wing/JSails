/**
 * Tests for the path module (`support/project-paths.server.ts`): POSIX ids from
 * either separator form, file URLs that escape every URL-special character a
 * path may hold, `importFile` and `importModule` on every platform, and route
 * modules served from a directory whose path holds `#`, `?`, `%`, and a space.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { preactPageRenderer } from '../../src/pages/page.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { createApp } from '../../src/server/app.js';
import {
  importFile,
  importModule,
  toFileUrl,
  toPosixId,
} from '../../src/support/project-paths.server.js';
import { TEST_ORIGIN, writeFixture } from '../fixtures/app.js';

/**
 * A directory name holding every character a path may contain but a URL reads
 * specially. Windows forbids `?` in a file name, so it is left out there; the
 * other characters are tested on every platform.
 */
const SPECIAL = process.platform === 'win32' ? 'jsails #1 100%25 % ' : 'jsails #1 ?q=1 100%25 % ';

const root = mkdtempSync(join(tmpdir(), SPECIAL));
after(() => rmSync(root, { recursive: true, force: true }));

describe('toPosixId', () => {
  it('turns a Windows relative path into a / id', () => {
    assert.equal(toPosixId('app\\models\\post.ts', win32), 'app/models/post.ts');
    assert.equal(toPosixId(win32.relative('C:\\app', 'C:\\app\\a\\b.js'), win32), 'a/b.js');
  });

  it('leaves a POSIX path unchanged, backslashes included', () => {
    assert.equal(toPosixId('app/models/post.ts', posix), 'app/models/post.ts');
    // A backslash is an ordinary file-name character on POSIX, not a separator.
    assert.equal(toPosixId('odd\\name.ts', posix), 'odd\\name.ts');
  });

  it('uses this platform by default', () => {
    assert.equal(toPosixId(join('a', 'b', 'c.js')), 'a/b/c.js');
  });
});

describe('toFileUrl', () => {
  it('escapes #, ?, %, and spaces so the URL names the same file', () => {
    const file = join(root, 'mod.mjs');
    const url = toFileUrl(file);
    assert.equal(url.protocol, 'file:');
    assert.equal(url.hash, '');
    assert.equal(url.search, '');
    assert.equal(fileURLToPath(url), file);
  });

  it('resolves a relative path against the working directory', () => {
    assert.equal(fileURLToPath(toFileUrl('x.mjs')), join(process.cwd(), 'x.mjs'));
  });
});

describe('importFile', () => {
  it('imports a module whose path holds URL-special characters', async () => {
    const file = join(root, 'value.mjs');
    writeFileSync(file, 'export const value = 42;\n');
    const module = await importFile<{ value: number }>(file);
    assert.equal(module.value, 42);
  });

  it('evaluates the file again under a new version and shares it otherwise', async () => {
    const file = join(root, 'counter.mjs');
    writeFileSync(
      file,
      'globalThis.__projectPathsCount = (globalThis.__projectPathsCount ?? 0) + 1;\nexport const n = globalThis.__projectPathsCount;\n',
    );
    const first = await importFile<{ n: number }>(file);
    const same = await importFile<{ n: number }>(file);
    const fresh = await importFile<{ n: number }>(file, { version: 2 });
    assert.equal(same.n, first.n);
    assert.equal(fresh.n, first.n + 1);
  });
});

describe('importModule', () => {
  it('imports a bare specifier', async () => {
    const module = await importModule<{ sep: string }>('node:path');
    assert.equal(typeof module.sep, 'string');
  });

  it('imports an absolute filesystem path as a file URL', async () => {
    const file = join(root, 'absolute.mjs');
    writeFileSync(file, 'export default "absolute";\n');
    const module = await importModule<{ default: string }>(file);
    assert.equal(module.default, 'absolute');
  });

  it('refuses a relative specifier, which has no base', async () => {
    await assert.rejects(importModule('./absolute.mjs'), TypeError);
    await assert.rejects(importModule('../absolute.mjs'), TypeError);
  });
});

describe('route modules under a URL-special path', () => {
  const app = join(root, 'app');
  writeFixture(app, 'api/ping.mjs', 'export const GET = () => Response.json({ pong: true });\n');
  writeFixture(
    app,
    'pages/hello.mjs',
    "export async function* stream() {\n  yield '<!doctype html><p>hello</p>';\n}\n",
  );

  it('serves the API and page routes', async () => {
    for (const character of ['#', '%', ' ']) assert.ok(app.includes(character));
    if (process.platform !== 'win32') assert.ok(app.includes('?'));
    const server = await createApp({
      manifest: discoverRoutes(app),
      renderer: preactPageRenderer,
      authorize: () => true,
    });

    const api = await server.fetch(new Request(`${TEST_ORIGIN}/api/ping`));
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { pong: true });

    const page = await server.fetch(new Request(`${TEST_ORIGIN}/hello`));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /hello/);
  });
});
