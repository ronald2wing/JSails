/**
 * Table-driven traversal matrix for the asset index and its responder
 * (`createAssetIndex` served by `createApp`).
 *
 * A real temp tree holds a public root plus a secret file beside it, a hidden
 * dotfile, and symlinks pointing out of the root. Every row is a raw request
 * path (sent verbatim, never normalized by the test) that must fall through to
 * the app's 404 without ever serving the secret, while the control rows prove
 * the ordinary files are served. The symlinks make it a POSIX-only fact.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createAssetIndex } from '../../src/assets/asset-index.js';
import { createApp } from '../../src/server/app.js';

const SECRET = 'planted-secret-outside-public-root';

const workspace = mkdtempSync(join(tmpdir(), 'jsails-security-public-'));
const publicDir = join(workspace, 'public');

function write(relative: string, contents: string): void {
  const file = join(workspace, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

let app: Awaited<ReturnType<typeof createApp>>;
const posixOnly = process.platform === 'win32' ? 'symlinks need a privilege on Windows' : false;

before(async () => {
  if (posixOnly) return;
  write('public/index.html', '<h1>home</h1>');
  write('public/assets/app.js', 'console.log(1)');
  write('public/assets/a b.txt', 'spaced');
  write('public/.env', SECRET);
  write('public/assets/.hidden/key.txt', SECRET);
  write('secret.txt', SECRET);
  write('outside/index.html', SECRET);
  symlinkSync(join(workspace, 'secret.txt'), join(publicDir, 'link.txt'));
  symlinkSync(join(workspace, 'outside'), join(publicDir, 'linkdir'));
  symlinkSync(join(workspace, 'secret.txt'), join(publicDir, 'assets', 'app.js.br'));

  const assets = await createAssetIndex({ roots: [{ dir: publicDir }] });
  app = await createApp({ manifest: { entries: [], byRoute: new Map() }, assets });
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * Issue a request whose path reaches the router exactly as written: the
 * `Request` URL parser would resolve `..` and `.` segments itself, so the path
 * is spliced in after parsing.
 */
async function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  const request = new Request('http://localhost/', init);
  Object.defineProperty(request, 'url', { value: `http://localhost${path}` });
  return app.fetch(request);
}

const TRAVERSAL_ROWS: readonly string[] = [
  '/../secret.txt',
  '/assets/../../secret.txt',
  '/%2e%2e/secret.txt',
  '/%2E%2E/secret.txt',
  '/assets/%2e%2e/%2e%2e/secret.txt',
  '/..%2fsecret.txt',
  '/..%2Fsecret.txt',
  '/%2e%2e%2fsecret.txt',
  '/..%5csecret.txt',
  '/..\\secret.txt',
  '/assets\\..\\..\\secret.txt',
  '/%252e%252e/secret.txt',
  '/%252e%252e%252fsecret.txt',
  '/%c0%ae%c0%ae/secret.txt',
  '/%e0%80%ae%e0%80%ae/secret.txt',
  '/%uff0e%uff0e/secret.txt',
  '/\uff0e\uff0e/secret.txt',
  '/./secret.txt',
  '/assets/./app.js/../../../secret.txt',
  '//secret.txt',
  '/assets//../../secret.txt',
  '/.env',
  '/%2eenv',
  '/assets/.hidden/key.txt',
  '/assets/%2ehidden/key.txt',
  '/link.txt',
  '/linkdir/',
  '/linkdir/index.html',
  '/index.html%00.txt',
  '/index.html%00',
  '/assets/app.js%0a',
  '/assets/app.js%',
  '/assets/app.js%zz',
  `/${'%2e%2e/'.repeat(20)}etc/passwd`,
  '/C:/Windows/win.ini',
  '/C:%5cWindows%5cwin.ini',
];

describe('public-file deny matrix: traversal and hidden paths', { skip: posixOnly }, () => {
  it('serves the ordinary files (control rows)', async () => {
    for (const [path, body] of [
      ['/', '<h1>home</h1>'],
      ['/index.html', '<h1>home</h1>'],
      ['/assets/app.js', 'console.log(1)'],
      ['/assets/a%20b.txt', 'spaced'],
    ] as const) {
      const response = await rawRequest(path);
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), body);
    }
  });

  for (const path of TRAVERSAL_ROWS) {
    it(`never serves ${JSON.stringify(path)}`, async () => {
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await rawRequest(path, { method });
        assert.equal(response.status, 404, `${method} ${path}`);
        if (method === 'GET') {
          const body = await response.text();
          assert.ok(!body.includes(SECRET));
          assert.ok(!body.includes(workspace), 'a miss must not echo a filesystem path');
        }
      }
    });
  }

  it('never serves a precompressed sibling, symlinked or not', async () => {
    const response = await rawRequest('/assets/app.js', { headers: { 'accept-encoding': 'br' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(await response.text(), 'console.log(1)');
  });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    it(`${method} never reaches a public file`, async () => {
      const response = await rawRequest('/index.html', { method, body: 'x' });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
      assert.ok(!(await response.text()).includes('<h1>home</h1>'));
    });
  }
});
