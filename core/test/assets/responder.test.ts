/**
 * The asset responder, driven through `createApp`: the pipeline order
 * (guards, assets, routes), the validators and caching, ranges, precompressed
 * copies, stale files, and the precedence rule against routes.
 *
 * Every fixture is a real file under a temporary directory and every request
 * goes through `app.fetch`; nothing listens. Binary payloads are byte arrays.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';

import { AssetErrors } from '../../src/assets/asset-errors.js';
import {
  assetIndexOf,
  createAssetIndex,
  type AssetEntry,
  type AssetIndex,
  type WatchAssetRoot,
} from '../../src/assets/asset-index.js';
import { preactPageRenderer } from '../../src/pages/page.js';
import { discoverRoutes, type RouteManifest } from '../../src/routing/routes.js';
import { createApp, type AppOptions } from '../../src/server/app.js';
import type { RequestErrorInfo } from '../../src/server/request-errors.js';

const workspace = mkdtempSync(join(tmpdir(), 'jsails-asset-responder-'));
after(() => rmSync(workspace, { recursive: true, force: true }));

const EMPTY: RouteManifest = { entries: [], byRoute: new Map() };

/** A permission bit denies this process a read: not as root, and not on Windows. */
const permissionsHold =
  process.platform === 'win32'
    ? 'Windows ignores the POSIX read bits'
    : process.getuid?.() === 0
      ? 'root reads any file'
      : false;

/** A development index over `pub` whose watcher never fires on its own. */
async function devIndexOver(pub: string): Promise<AssetIndex> {
  const watch: WatchAssetRoot = () => ({ close: () => undefined });
  return await createAssetIndex({ roots: [{ dir: pub }], mode: 'watch', watch });
}

/**
 * `index`, with `rewrite` run after each of its first `times` lookups: a
 * bundler writing the file between the index's hash and the responder's open.
 */
function racedBy(index: AssetIndex, times: number, rewrite: (round: number) => void): AssetIndex {
  let round = 0;
  return {
    ...index,
    get: (path: string) => {
      const entry = index.get(path);
      if (round < times) {
        round += 1;
        rewrite(round);
      }
      return entry;
    },
  };
}
const REVALIDATE = 'public, max-age=0, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';

function caseDir(): string {
  return mkdtempSync(join(workspace, 'case-'));
}

function write(dir: string, relative: string, contents: string | Uint8Array): string {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function hashOf(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('base64url').slice(0, 16);
}

async function appOver(
  publicDir: string,
  options: Partial<AppOptions> = {},
): Promise<{ app: Awaited<ReturnType<typeof createApp>>; index: AssetIndex }> {
  const index = await createAssetIndex({ roots: [{ dir: publicDir }] });
  const app = await createApp({ manifest: EMPTY, assets: index, ...options });
  return { app, index };
}

async function request(
  app: Awaited<ReturnType<typeof createApp>>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, init));
}

/** Collect the process warnings emitted while `run` runs. */
async function warningsOf(run: () => Promise<unknown>): Promise<Error[]> {
  const warnings: Error[] = [];
  const listener = (warning: Error): void => {
    warnings.push(warning);
  };
  process.on('warning', listener);
  try {
    await run();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', listener);
  }
  return warnings;
}

function codeOf(warning: Error): unknown {
  return (warning as Error & { code?: unknown }).code;
}

describe('asset responder: serving', () => {
  it('serves text and binary files with their content type and the security headers', async () => {
    const pub = caseDir();
    write(pub, 'hello.txt', 'hello world');
    write(pub, 'index.html', '<h1>home</h1>');
    write(pub, 'data.bin', Uint8Array.from([0, 1, 2, 253, 254, 255]));
    const { app } = await appOver(pub);

    const text = await request(app, '/hello.txt');
    assert.equal(text.status, 200);
    assert.match(text.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(text.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(text.headers.get('x-request-id'));
    assert.equal(text.headers.get('accept-ranges'), 'bytes');
    assert.equal(await text.text(), 'hello world');

    const binary = await request(app, '/data.bin');
    assert.equal(binary.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual([...new Uint8Array(await binary.arrayBuffer())], [0, 1, 2, 253, 254, 255]);

    const home = await request(app, '/');
    assert.match(home.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(await home.text(), '<h1>home</h1>');
  });

  it('streams a file above the inline limit from disk', async () => {
    const pub = caseDir();
    const big = new Uint8Array(200 * 1024);
    for (let index = 0; index < big.length; index += 1) big[index] = index % 251;
    write(pub, 'big.bin', big);
    const { app, index } = await appOver(pub);
    assert.equal(index.get('/big.bin')?.inline, undefined);

    const response = await request(app, '/big.bin');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(big.length));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), big);
  });

  it('serves a literal percent in a file name, decoding the request once', async () => {
    const pub = caseDir();
    write(pub, '100%.txt', 'percent');
    write(pub, 'a b.txt', 'spaced');
    const { app } = await appOver(pub);
    assert.equal(await (await request(app, '/100%25.txt')).text(), 'percent');
    assert.equal((await request(app, '/100%25.txt?v=2')).status, 200);
    assert.equal(await (await request(app, '/a%20b.txt')).text(), 'spaced');
  });

  it('answers HEAD with the GET headers and no body', async () => {
    const pub = caseDir();
    write(pub, 'hello.txt', 'hello world');
    const { app } = await appOver(pub);
    const head = await request(app, '/hello.txt', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(head.headers.get('content-length'), '11');
    assert.equal(head.headers.get('etag'), `"${hashOf('hello world')}"`);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });

  it('serves directory index documents, with and without a trailing slash', async () => {
    const pub = caseDir();
    write(pub, 'sub/index.html', '<p>sub</p>');
    mkdirSync(join(pub, 'empty'));
    write(pub, 'file.txt', 'file');
    const { app } = await appOver(pub);
    assert.equal(await (await request(app, '/sub/')).text(), '<p>sub</p>');
    assert.equal(await (await request(app, '/sub')).text(), '<p>sub</p>');
    assert.equal((await request(app, '/empty/')).status, 404);
    assert.equal((await request(app, '/file.txt/')).status, 404);
  });

  it('passes a miss to the router, and answers another method on an asset with 405', async () => {
    const pub = caseDir();
    write(pub, 'hello.txt', 'hi');
    const { app } = await appOver(pub);
    assert.equal((await request(app, '/missing.txt')).status, 404);
    for (const method of ['POST', 'DELETE']) {
      const response = await request(app, '/hello.txt', { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
    }
  });

  it('serves /.well-known and never another hidden path', async () => {
    const base = caseDir();
    const pub = join(base, 'public');
    write(pub, '.well-known/security.txt', 'Contact: mailto:security@example.test');
    write(pub, '.env', 'SECRET=1');
    write(pub, 'ok.txt', 'ok');
    write(base, 'x', 'OUTSIDE');
    const { app } = await appOver(pub);

    const security = await request(app, '/.well-known/security.txt');
    assert.equal(security.status, 200);
    assert.match(await security.text(), /^Contact:/);
    assert.equal((await request(app, '/.env')).status, 404);
    assert.equal((await request(app, '/%2eenv')).status, 404);
    // A traversal out of /.well-known reaches nothing outside the root.
    const escape = new Request('http://localhost/');
    Object.defineProperty(escape, 'url', { value: 'http://localhost/.well-known/../x' });
    const escaped = await app.fetch(escape);
    assert.equal(escaped.status, 404);
    assert.ok(!(await escaped.text()).includes('OUTSIDE'));
  });

  it('ignores client-supplied forwarding headers', async () => {
    const pub = caseDir();
    write(pub, 'hello.txt', 'hello');
    const { app } = await appOver(pub);
    const response = await request(app, '/hello.txt', {
      headers: { 'x-forwarded-host': 'evil.test', 'x-forwarded-prefix': '/../../' },
    });
    assert.equal(await response.text(), 'hello');
  });

  it('puts the index url on every request context', async () => {
    const base = caseDir();
    write(base, 'public/app.js', 'const app = 1;\n');
    write(
      base,
      'pages/index.mjs',
      "export default (props) => 'page';\nexport const load = (context) => ({ url: context.assetUrl('/app.js') });\n",
    );
    const index = await createAssetIndex({ roots: [{ dir: join(base, 'public') }] });
    let seen: string | undefined;
    const app = await createApp({
      manifest: discoverRoutes(base),
      assets: index,
      renderer: {
        render: (entry, context) => {
          seen = context.assetUrl?.('/app.js');
          return preactPageRenderer.render(entry, context, {});
        },
      },
    });
    assert.equal((await request(app, '/', { headers: { accept: 'text/html' } })).status, 200);
    assert.equal(seen, `/app.js?v=${hashOf('const app = 1;\n')}`);
  });
});

describe('asset responder: caching and validators', () => {
  it('is immutable only when v is the current content hash', async () => {
    const pub = caseDir();
    write(pub, 'app.css', 'body{}');
    const { app } = await appOver(pub);
    const hash = hashOf('body{}');

    const plain = await request(app, '/app.css');
    assert.equal(plain.headers.get('cache-control'), REVALIDATE);
    assert.equal(plain.headers.get('etag'), `"${hash}"`);

    const versioned = await request(app, `/app.css?v=${hash}`);
    assert.equal(versioned.headers.get('cache-control'), IMMUTABLE);
    assert.equal(versioned.headers.get('etag'), `"${hash}"`);

    for (const version of ['abc123', '', hashOf('old'), hash.toUpperCase()]) {
      const response = await request(app, `/app.css?v=${version}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), REVALIDATE, `v=${version}`);
    }
  });

  it('serves an immutable entry as immutable at any URL', async () => {
    const pub = caseDir();
    const file = write(pub, 'app-3f2a.js', 'x');
    const entry: AssetEntry = {
      path: '/app-3f2a.js',
      file,
      hash: hashOf('x'),
      size: 1,
      immutable: true,
      encodings: {},
      owner: 'app',
    };
    const app = await createApp({ manifest: EMPTY, assets: assetIndexOf([entry]) });
    const response = await request(app, '/app-3f2a.js');
    assert.equal(response.headers.get('cache-control'), IMMUTABLE);
    assert.equal(await response.text(), 'x');
  });

  it('answers a matching If-None-Match (or *) with 304 and no body', async () => {
    const pub = caseDir();
    write(pub, 'app.js', 'console.log(1)');
    const { app } = await appOver(pub);
    const etag = (await request(app, '/app.js')).headers.get('etag') ?? '';
    for (const tag of [etag, '*', `"other", ${etag}`, `W/${etag}`]) {
      const response = await request(app, '/app.js', { headers: { 'if-none-match': tag } });
      assert.equal(response.status, 304, tag);
      assert.equal(response.headers.get('etag'), etag);
      assert.equal(response.headers.get('cache-control'), REVALIDATE);
      assert.equal(response.headers.get('content-length'), null);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
    const stale = await request(app, '/app.js', { headers: { 'if-none-match': 'W/"0-0"' } });
    assert.equal(stale.status, 200);
  });

  it('never opens a file for a 304, so revalidations hold no descriptor', async (t) => {
    if (process.platform !== 'linux') return t.skip('descriptor counting reads /proc/self/fd');
    const pub = caseDir();
    write(pub, 'big.bin', new Uint8Array(512 * 1024));
    const { app } = await appOver(pub);
    const etag = (await request(app, '/big.bin', { method: 'HEAD' })).headers.get('etag') ?? '';
    const before = readdirSync('/proc/self/fd').length;
    for (let index = 0; index < 50; index += 1) {
      const response = await request(app, '/big.bin', { headers: { 'if-none-match': etag } });
      assert.equal(response.status, 304);
    }
    assert.ok(readdirSync('/proc/self/fd').length - before < 5);
  });

  it('lets the finalizer compress an identity answer, weakening its validator', async () => {
    const pub = caseDir();
    const css = 'body { color: #222; }\n'.repeat(200);
    write(pub, 'app.css', css);
    const { app } = await appOver(pub);
    const response = await request(app, '/app.css', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.equal(response.headers.get('etag'), `W/"${hashOf(css)}"`);
    assert.equal(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString(), css);
    // The weak validator still revalidates.
    const revalidated = await request(app, '/app.css', {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': `W/"${hashOf(css)}"` },
    });
    assert.equal(revalidated.status, 304);
  });
});

describe('asset responder: precompressed copies', () => {
  async function encodedApp(): Promise<Awaited<ReturnType<typeof createApp>>> {
    const pub = caseDir();
    const file = write(pub, 'app.js', 'identity');
    const br = write(pub, 'copies/app.js.br', 'brotli-bytes');
    const gz = write(pub, 'copies/app.js.gz', 'gzip-bytes');
    const entry: AssetEntry = {
      path: '/app.js',
      file,
      hash: hashOf('identity'),
      size: 8,
      immutable: false,
      encodings: { br: { file: br, size: 12 }, gzip: { file: gz, size: 10 } },
      owner: 'app',
    };
    return createApp({ manifest: EMPTY, assets: assetIndexOf([entry]) });
  }

  it('picks the copy the client values most, brotli on a tie, and keeps the type', async () => {
    const app = await encodedApp();
    const hash = hashOf('identity');
    const br = await request(app, '/app.js', { headers: { 'accept-encoding': 'gzip, br' } });
    assert.equal(br.headers.get('content-encoding'), 'br');
    assert.match(br.headers.get('content-type') ?? '', /javascript/);
    assert.equal(br.headers.get('vary'), 'Accept-Encoding');
    assert.equal(br.headers.get('etag'), `"${hash}.br"`);
    assert.equal(await br.text(), 'brotli-bytes');

    const gz = await request(app, '/app.js', { headers: { 'accept-encoding': 'gzip, br;q=0.5' } });
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
    assert.equal(gz.headers.get('etag'), `"${hash}.gz"`);
    assert.equal(await gz.text(), 'gzip-bytes');

    const plain = await request(app, '/app.js', { headers: { 'accept-encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(plain.headers.get('vary'), 'Accept-Encoding');
    assert.equal(plain.headers.get('etag'), `"${hash}"`);
    assert.equal(await plain.text(), 'identity');

    // A 304 for one coding's validator.
    const revalidated = await request(app, '/app.js', {
      headers: { 'accept-encoding': 'br', 'if-none-match': `"${hash}.br"` },
    });
    assert.equal(revalidated.status, 304);
  });

  it('serves a range from the identity file only', async () => {
    const app = await encodedApp();
    const ranged = await request(app, '/app.js', {
      headers: { 'accept-encoding': 'br', range: 'bytes=0-3' },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-encoding'), null);
    assert.equal(ranged.headers.get('content-range'), 'bytes 0-3/8');
    assert.equal(await ranged.text(), 'iden');
  });
});

describe('asset responder: ranges', () => {
  for (const [label, contents] of [
    ['an inline file', 'abcdefghij'],
    ['a streamed file', 'abcdefghij'.repeat(10_000)],
  ] as const) {
    it(`serves one byte range of ${label}`, async () => {
      const pub = caseDir();
      write(pub, 'f.txt', contents);
      const { app } = await appOver(pub);
      const size = contents.length;
      const tag = `"${hashOf(contents)}"`;
      const cases: readonly (readonly [string, number, string | undefined, string | undefined])[] =
        [
          ['bytes=0-3', 206, `bytes 0-3/${size}`, contents.slice(0, 4)],
          ['bytes=-3', 206, `bytes ${size - 3}-${size - 1}/${size}`, contents.slice(-3)],
          ['bytes=5-', 206, `bytes 5-${size - 1}/${size}`, contents.slice(5)],
          [`bytes=2-${size + 50}`, 206, `bytes 2-${size - 1}/${size}`, contents.slice(2)],
          [`bytes=${size}-`, 416, `bytes */${size}`, ''],
          ['bytes=0-1, 3-4', 200, undefined, contents],
          ['items=0-1', 200, undefined, contents],
          ['bytes=4-2', 200, undefined, contents],
        ];
      for (const [range, status, contentRange, body] of cases) {
        const response = await request(app, '/f.txt', { headers: { range } });
        assert.equal(response.status, status, range);
        assert.equal(response.headers.get('content-range') ?? undefined, contentRange, range);
        assert.equal(await response.text(), body, range);
      }
      const matching = await request(app, '/f.txt', {
        headers: { range: 'bytes=0-1', 'if-range': tag },
      });
      assert.equal(matching.status, 206);
      for (const ifRange of ['"other"', `W/${tag}`, 'Wed, 21 Oct 2015 07:28:00 GMT']) {
        const response = await request(app, '/f.txt', {
          headers: { range: 'bytes=0-1', 'if-range': ifRange },
        });
        assert.equal(response.status, 200, ifRange);
        assert.equal(await response.text(), contents);
      }
    });
  }
});

describe('asset responder: stale files', () => {
  it('answers a file that no longer matches the index with 500, reported once', async () => {
    const pub = caseDir();
    const big = write(pub, 'big.txt', 'x'.repeat(100_000));
    write(pub, 'small.txt', 'small');
    const reports: { error: unknown; info: RequestErrorInfo }[] = [];
    const { app } = await appOver(pub, {
      onError: (error, info) => {
        reports.push({ error, info });
      },
    });
    writeFileSync(big, 'shorter');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(app, '/big.txt', { headers: { accept: 'application/json' } });
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.ok(!body.includes(pub), 'the answer names no location');
      assert.ok(!body.includes('shorter'));
    }
    assert.equal(reports.length, 1);
    assert.ok(AssetErrors.is(reports[0]?.error, 'stale_assets'));
    assert.equal(
      (reports[0]?.error as Error).message,
      'asset big.txt changed on disk after the asset index was built',
    );
    assert.equal(reports[0]?.info.phase, 'handler');

    unlinkSync(big);
    assert.equal((await request(app, '/big.txt')).status, 500);
    // An inline entry is served from the bytes the index read.
    writeFileSync(join(pub, 'small.txt'), 'changed');
    assert.equal(await (await request(app, '/small.txt')).text(), 'small');
  });

  it('answers a file that fails to open as a read failure, not a stale index', async (t) => {
    if (permissionsHold) return t.skip(permissionsHold);
    const pub = caseDir();
    const big = write(pub, 'big.txt', 'x'.repeat(100_000));
    const reports: unknown[] = [];
    const { app } = await appOver(pub, {
      onError: (error) => {
        reports.push(error);
      },
    });
    chmodSync(big, 0o000);
    try {
      const response = await request(app, '/big.txt', { headers: { accept: 'application/json' } });
      assert.equal(response.status, 500);
      assert.ok(!(await response.text()).includes(pub), 'the answer names no location');
    } finally {
      chmodSync(big, 0o644);
    }
    assert.equal(reports.length, 1);
    assert.ok(AssetErrors.is(reports[0], 'read_failed'));
    assert.equal((reports[0] as Error).message, 'asset big.txt could not be read');
  });

  it('answers a development request that raced a rewrite from the new bytes', async () => {
    const pub = caseDir();
    const file = write(pub, 'app.js', 'first');
    const dev = await devIndexOver(pub);
    try {
      // Rewritten to another size between the hash and the open.
      const resized = racedBy(dev, 1, () => writeFileSync(file, 'second, longer'));
      const app = await createApp({ manifest: EMPTY, assets: resized });
      const response = await request(app, '/app.js');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('etag'), `"${hashOf('second, longer')}"`);
      assert.equal(await response.text(), 'second, longer');

      // Rewritten to the same size: the moved mtime gives the file a new entry.
      utimesSync(file, 1_000_000, 1_000_000);
      assert.equal(dev.get('/app.js')?.hash, hashOf('second, longer'));
      const sameSize = racedBy(dev, 1, () => {
        writeFileSync(file, 'SECOND, LONGER');
        utimesSync(file, 2_000_000, 2_000_000);
      });
      const again = await createApp({ manifest: EMPTY, assets: sameSize });
      const replaced = await request(again, '/app.js');
      assert.equal(replaced.status, 200);
      assert.equal(replaced.headers.get('etag'), `"${hashOf('SECOND, LONGER')}"`);
      assert.equal(await replaced.text(), 'SECOND, LONGER');
    } finally {
      dev.close();
    }
  });

  it('reports a development file that keeps changing once for each version of it', async () => {
    const pub = caseDir();
    const file = write(pub, 'app.js', 'v0');
    const dev = await devIndexOver(pub);
    try {
      const reports: unknown[] = [];
      // Every lookup finds the file rewritten again, so no answer settles.
      const churning = racedBy(dev, Number.POSITIVE_INFINITY, (round) =>
        // A new size every round: 3, 4, 5... bytes after the 2-byte original.
        writeFileSync(file, `v${'.'.repeat(round + 1)}`),
      );
      const app = await createApp({
        manifest: EMPTY,
        assets: churning,
        onError: (error) => {
          reports.push(error);
        },
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await request(app, '/app.js', {
          headers: { accept: 'application/json' },
        });
        assert.equal(response.status, 500);
      }
      assert.equal(reports.length, 2);
      assert.ok(reports.every((error) => AssetErrors.is(error, 'stale_assets')));
    } finally {
      dev.close();
    }
  });

  it('passes a development request on when its file leaves the index mid-answer', async () => {
    const pub = caseDir();
    const file = write(pub, 'gone.txt', 'here');
    const dev = await devIndexOver(pub);
    try {
      const app = await createApp({
        manifest: EMPTY,
        assets: racedBy(dev, 1, () => unlinkSync(file)),
      });
      const response = await request(app, '/gone.txt', {
        headers: { accept: 'application/json' },
      });
      assert.equal(response.status, 404);
    } finally {
      dev.close();
    }
  });

  it('gives no unbuilt warning for a production index that holds no file', async () => {
    const base = caseDir();
    mkdirSync(join(base, 'empty'));
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let warnings: Error[];
    try {
      warnings = await warningsOf(async () => {
        await appOver(join(base, 'absent'));
        await appOver(join(base, 'empty'));
      });
    } finally {
      process.env.NODE_ENV = previous;
    }
    assert.deepEqual(
      warnings.filter((warning) => codeOf(warning) === 'JSAILS_ASSETS_NOT_BUILT'),
      [],
    );
  });

  it('serves an unbuilt production start with correct bytes and one warning', async () => {
    const pub = caseDir();
    write(pub, 'robots.txt', 'User-agent: *\n');
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    let warnings: Error[];
    try {
      warnings = await warningsOf(async () => {
        ({ app } = await appOver(pub));
      });
    } finally {
      process.env.NODE_ENV = previous;
    }
    const unbuilt = warnings.filter((warning) => codeOf(warning) === 'JSAILS_ASSETS_NOT_BUILT');
    assert.equal(unbuilt.length, 1);
    assert.ok(app !== undefined);
    assert.equal(await (await request(app, '/robots.txt')).text(), 'User-agent: *\n');
  });
});

describe('asset responder: pipeline order and precedence', () => {
  it('refuses an assets option that is not an asset index', async () => {
    for (const assets of [null, {}, { get: () => undefined }]) {
      await assert.rejects(
        () => createApp({ manifest: EMPTY, assets: assets as never }),
        /assets must be an asset index/,
      );
    }
  });

  it('runs after the guards', async () => {
    const pub = caseDir();
    write(pub, 'app.css', 'body{}');
    const { app } = await appOver(pub, {
      guards: [
        (incoming) =>
          incoming.headers.get('x-wall') === 'deny'
            ? new Response(null, { status: 401 })
            : undefined,
      ],
    });
    assert.equal((await request(app, '/app.css', { headers: { 'x-wall': 'deny' } })).status, 401);
    assert.equal((await request(app, '/app.css')).status, 200);
  });

  it('serves a public file a root [slug] page would also match', async () => {
    const base = caseDir();
    write(
      base,
      'pages/[slug].mjs',
      "export const load = (context) => ({ slug: context.params.slug });\nexport default ({ slug }) => 'page ' + slug;\n",
    );
    write(base, 'public/favicon.ico', 'icon');
    const index = await createAssetIndex({ roots: [{ dir: join(base, 'public') }] });
    const app = await createApp({
      manifest: discoverRoutes(base),
      assets: index,
      renderer: preactPageRenderer,
    });
    assert.equal(await (await request(app, '/favicon.ico')).text(), 'icon');
    const page = await request(app, '/hello', { headers: { accept: 'text/html' } });
    assert.match(await page.text(), /page hello/);
  });

  it('fails assembly when an asset path equals a literal route, a reserved path or /_jsails', async () => {
    const base = caseDir();
    write(base, 'pages/about/index.mjs', "export default () => 'about';\n");
    write(base, 'public/about', 'file');
    write(base, 'public/up', 'file');
    write(base, 'public/_jsails/x.js', 'file');
    const index = await createAssetIndex({ roots: [{ dir: join(base, 'public') }] });
    await assert.rejects(
      () =>
        createApp({
          manifest: discoverRoutes(base),
          assets: index,
          renderer: preactPageRenderer,
          healthPath: '/up',
        }),
      (error: unknown) =>
        AssetErrors.is(error, 'route_collision') &&
        error.message === '3 asset path(s) equal a route or a reserved path, first _jsails/x.js',
    );
  });

  it('leaves a directory alias to a literal route on it', async () => {
    const base = caseDir();
    write(base, 'pages/docs/index.mjs', "export default () => 'docs page';\n");
    write(base, 'public/docs/index.html', 'docs file');
    const index = await createAssetIndex({ roots: [{ dir: join(base, 'public') }] });
    const app = await createApp({
      manifest: discoverRoutes(base),
      assets: index,
      renderer: preactPageRenderer,
    });
    const html = { headers: { accept: 'text/html' } };
    assert.match(await (await request(app, '/docs', html)).text(), /docs page/);
    assert.equal(await (await request(app, '/docs/index.html')).text(), 'docs file');
  });

  it('warns about a collision in development, lets the route answer, and checks again', async () => {
    const base = caseDir();
    write(base, 'pages/about/index.mjs', "export default () => 'about page';\n");
    write(base, 'public/about', 'file');
    let fire: (() => void) | undefined;
    const watch: WatchAssetRoot = (_dir, onEvent) => {
      fire = onEvent;
      return { close: () => undefined };
    };
    const index = await createAssetIndex({
      roots: [{ dir: join(base, 'public') }],
      mode: 'watch',
      watch,
    });
    try {
      let app: Awaited<ReturnType<typeof createApp>> | undefined;
      const warnings = await warningsOf(async () => {
        app = await createApp({
          manifest: discoverRoutes(base),
          assets: index,
          renderer: preactPageRenderer,
        });
      });
      assert.ok(app !== undefined);
      const collision = warnings.filter((w) => codeOf(w) === 'JSAILS_ASSET_ROUTE_COLLISION');
      assert.equal(collision.length, 1);
      assert.match(collision[0]?.message ?? '', /1 asset path\(s\) equal a route .* first "about"/);
      const html = { headers: { accept: 'text/html' } };
      assert.match(await (await request(app, '/about', html)).text(), /about page/);

      // The file moves away: the next request sees it, and the route keeps answering.
      unlinkSync(join(base, 'public', 'about'));
      write(base, 'public/elsewhere.txt', 'moved');
      fire?.();
      const later = await warningsOf(() => request(app!, '/elsewhere.txt'));
      assert.equal(later.filter((w) => codeOf(w) === 'JSAILS_ASSET_ROUTE_COLLISION').length, 0);
      assert.equal(await (await request(app, '/elsewhere.txt')).text(), 'moved');
    } finally {
      index.close();
    }
  });

  it('lets the route answer the first request after a colliding file appears in development', async () => {
    const base = caseDir();
    write(base, 'pages/about/index.mjs', "export default () => 'about page';\n");
    write(base, 'public/robots.txt', 'User-agent: *\n');
    let fire: (() => void) | undefined;
    const watch: WatchAssetRoot = (_dir, onEvent) => {
      fire = onEvent;
      return { close: () => undefined };
    };
    const index = await createAssetIndex({
      roots: [{ dir: join(base, 'public') }],
      mode: 'watch',
      watch,
    });
    try {
      const app = await createApp({
        manifest: discoverRoutes(base),
        assets: index,
        renderer: preactPageRenderer,
      });
      write(base, 'public/about', 'FILE');
      fire?.();
      const html = { headers: { accept: 'text/html' } };
      let first: string | undefined;
      const warnings = await warningsOf(async () => {
        first = await (await request(app, '/about', html)).text();
      });
      assert.match(first ?? '', /about page/);
      assert.equal(warnings.filter((w) => codeOf(w) === 'JSAILS_ASSET_ROUTE_COLLISION').length, 1);
      assert.match(await (await request(app, '/about', html)).text(), /about page/);
    } finally {
      index.close();
    }
  });
});
