/**
 * The asset index: the path rule, the snapshot filler, and `url`.
 *
 * Every fixture is a real file under a temporary directory; nothing listens.
 * The symlink fixtures are POSIX-only facts and skip on Windows, where
 * creating one needs a privilege.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { AssetErrors } from '../../src/assets/asset-errors.js';
import {
  assetIndexOf,
  createAssetIndex,
  INLINE_MAX_BYTES,
  type AssetEntry,
} from '../../src/assets/asset-index.js';
import {
  decodeAssetPath,
  directoryAliases,
  encodeAssetPath,
  validateAssetPath,
} from '../../src/assets/asset-path.js';
import { readFailureOf } from '../../src/assets/asset-walk.js';

const workspace = mkdtempSync(join(tmpdir(), 'jsails-asset-index-'));
after(() => rmSync(workspace, { recursive: true, force: true }));

const posixOnly = process.platform === 'win32' ? 'symlinks need a privilege on Windows' : false;

/** A permission bit denies this process a read: not as root, and not on Windows. */
const permissionsHold =
  process.platform === 'win32'
    ? 'Windows ignores the POSIX read bits'
    : process.getuid?.() === 0
      ? 'root reads any file'
      : false;

/** An errno error as Node's filesystem calls throw it. */
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: failed, open '/srv/app/public/x'`), { code });
}

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

/** Collect the warnings emitted while `run` runs (process warnings are async). */
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

describe('validateAssetPath', () => {
  it('accepts absolute POSIX paths and a leading .well-known', () => {
    for (const path of ['/a.css', '/assets/app.js', '/a b/c%d.txt', '/.well-known/security.txt']) {
      assert.equal(validateAssetPath(path), true, path);
    }
  });

  it('refuses dot segments, hidden names, empty segments, backslashes and controls', () => {
    for (const path of [
      '',
      '/',
      'a.css',
      '//a.css',
      '/a//b',
      '/a/',
      '/.env',
      '/a/.hidden',
      '/./a',
      '/../a',
      '/a/..',
      '/a/.well-known/x',
      '/.well-known/../x',
      '/a\\b',
      '/a\u0000b',
      '/a\nb',
    ]) {
      assert.equal(validateAssetPath(path), false, JSON.stringify(path));
    }
  });
});

describe('asset path encoding', () => {
  it('decodes a request path once, segment by segment', () => {
    assert.equal(decodeAssetPath('/a%20b/100%25.txt'), '/a b/100%.txt');
    assert.equal(decodeAssetPath('/plain.css'), '/plain.css');
    // An encoded slash never becomes a separator; a malformed escape is a miss.
    assert.equal(decodeAssetPath('/a%2fb'), undefined);
    assert.equal(decodeAssetPath('/a%zz'), undefined);
    assert.equal(decodeAssetPath('/%e0%80%af'), undefined);
    // Decoding is single: a double-encoded dot stays a literal percent.
    assert.equal(decodeAssetPath('/%252e%252e'), '/%2e%2e');
  });

  it('round-trips every indexed path through encode and decode', () => {
    for (const path of ['/café.js', '/a b.txt', '/100%.txt', '/a?b#c.txt', '/x+y@z.css']) {
      assert.equal(decodeAssetPath(encodeAssetPath(path)), path);
    }
  });

  it('names the directory aliases of an index document', () => {
    assert.deepEqual(directoryAliases('/index.html'), ['/']);
    assert.deepEqual(directoryAliases('/docs/index.html'), ['/docs/', '/docs']);
    assert.deepEqual(directoryAliases('/docs/page.html'), []);
  });
});

describe('createAssetIndex (snapshot)', () => {
  it('indexes every regular file with its hash, size, type and inline bytes', async () => {
    const pub = caseDir();
    write(pub, 'assets/app.js', 'const app = 1;\n');
    write(pub, 'robots.txt', 'User-agent: *\n');
    const index = await createAssetIndex({ roots: [{ dir: pub }] });

    assert.equal(index.source, 'snapshot');
    assert.deepEqual([...index.paths()], ['/assets/app.js', '/robots.txt']);
    const entry = index.get('/assets/app.js');
    assert.ok(entry !== undefined);
    assert.equal(entry.hash, hashOf('const app = 1;\n'));
    assert.match(entry.hash, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(entry.size, 15);
    assert.equal(entry.immutable, false);
    assert.equal(entry.owner, 'app');
    assert.equal(entry.file, join(pub, 'assets', 'app.js'));
    assert.deepEqual(entry.encodings, {});
    assert.equal(new TextDecoder().decode(entry.inline), 'const app = 1;\n');
  });

  it('streams files above the inline limit instead of holding them', async () => {
    const pub = caseDir();
    const big = new Uint8Array(INLINE_MAX_BYTES + 1).fill(7);
    write(pub, 'big.bin', big);
    const index = await createAssetIndex({ roots: [{ dir: pub }] });
    const entry = index.get('/big.bin');
    assert.ok(entry !== undefined);
    assert.equal(entry.inline, undefined);
    assert.equal(entry.size, big.byteLength);
    assert.equal(entry.hash, hashOf(big));
  });

  it('serves /.well-known and skips every other hidden entry', async () => {
    const pub = caseDir();
    write(pub, '.well-known/security.txt', 'Contact: x');
    write(pub, '.env', 'SECRET=1');
    write(pub, 'assets/.hidden/key.txt', 'SECRET');
    write(pub, 'ok.txt', 'ok');
    const warnings = await warningsOf(() => createAssetIndex({ roots: [{ dir: pub }] }));
    const index = await createAssetIndex({ roots: [{ dir: pub }] });
    assert.deepEqual([...index.paths()], ['/.well-known/security.txt', '/ok.txt']);
    // Hidden files were never servable: leaving them out is not a refusal.
    assert.equal(
      warnings.filter((w) => 'code' in w && w.code === 'JSAILS_ASSETS_REFUSED').length,
      0,
    );
  });

  it('leaves symlinks out of the index, and warns with their count', async (t) => {
    if (posixOnly) return t.skip(posixOnly);
    const base = caseDir();
    const pub = join(base, 'public');
    write(pub, 'ok.txt', 'ok');
    const secret = write(base, 'secret.txt', 'OUTSIDE');
    write(base, 'outside/x.txt', 'OUTSIDE');
    symlinkSync(secret, join(pub, 'link.txt'));
    symlinkSync(join(base, 'outside'), join(pub, 'linked'));
    mkdirSync(join(pub, 'docs'));
    symlinkSync(secret, join(pub, 'docs', 'index.html'));

    let index: Awaited<ReturnType<typeof createAssetIndex>> | undefined;
    const warnings = await warningsOf(async () => {
      index = await createAssetIndex({ roots: [{ dir: pub }] });
    });
    assert.ok(index !== undefined);
    assert.deepEqual([...index.paths()], ['/ok.txt']);
    for (const path of ['/link.txt', '/linked/x.txt', '/docs/', '/docs/index.html']) {
      assert.equal(index.get(path), undefined, path);
    }
    const refused = warnings.find((w) => 'code' in w && w.code === 'JSAILS_ASSETS_REFUSED');
    assert.ok(refused !== undefined);
    assert.match(refused.message, /^jsails: 3 file\(s\) in an asset root are not served/);
    assert.ok(!refused.message.includes(base), 'the warning names no location');
  });

  it('refuses names an asset path may not carry', async (t) => {
    if (process.platform === 'win32') return t.skip('Windows refuses these names itself');
    const pub = caseDir();
    write(pub, 'a\\b.txt', 'x');
    write(pub, 'line\nbreak.txt', 'x');
    write(pub, 'ok.txt', 'ok');
    const index = await createAssetIndex({ roots: [{ dir: pub }] });
    assert.deepEqual([...index.paths()], ['/ok.txt']);
  });

  it('serves nothing from a missing root and refuses a root that is not a directory', async (t) => {
    const base = caseDir();
    const empty = await createAssetIndex({ roots: [{ dir: join(base, 'absent') }] });
    assert.deepEqual([...empty.paths()], []);
    assert.deepEqual(empty.roots, []);

    const file = write(base, 'plain.txt', 'x');
    await assert.rejects(
      () => createAssetIndex({ roots: [{ dir: file }] }),
      (error: unknown) => AssetErrors.is(error, 'invalid_root'),
    );
    await assert.rejects(
      () => createAssetIndex({ roots: [{ dir: '' }] }),
      (error: unknown) => AssetErrors.is(error, 'invalid_root'),
    );
    for (const options of [null, {}, { roots: [], mode: 'eager' }, { roots: [], watch: 1 }]) {
      await assert.rejects(
        () => createAssetIndex(options as never),
        (error: unknown) => AssetErrors.is(error, 'invalid_options'),
      );
    }
    if (posixOnly) return t.skip(posixOnly);
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    await assert.rejects(
      () => createAssetIndex({ roots: [{ dir: join(base, 'link') }] }),
      (error: unknown) => AssetErrors.is(error, 'invalid_root'),
    );
  });

  it('leaves out a file or directory it may not read, warns with their count, and starts', async (t) => {
    if (permissionsHold) return t.skip(permissionsHold);
    const pub = caseDir();
    write(pub, 'ok.txt', 'ok');
    const locked = write(pub, 'locked.txt', 'secret');
    write(pub, 'sealed/inner.txt', 'secret');
    chmodSync(locked, 0o000);
    chmodSync(join(pub, 'sealed'), 0o000);
    try {
      let index: Awaited<ReturnType<typeof createAssetIndex>> | undefined;
      const warnings = await warningsOf(async () => {
        index = await createAssetIndex({ roots: [{ dir: pub }] });
      });
      assert.ok(index !== undefined);
      assert.deepEqual([...index.paths()], ['/ok.txt']);
      const unreadable = warnings.find((w) => 'code' in w && w.code === 'JSAILS_ASSETS_UNREADABLE');
      assert.ok(unreadable !== undefined);
      assert.match(unreadable.message, /^jsails: 2 file\(s\) or directories in an asset root/);
      assert.ok(!unreadable.message.includes(pub), 'the warning names no location');
    } finally {
      chmodSync(locked, 0o644);
      chmodSync(join(pub, 'sealed'), 0o755);
    }
  });

  it('fails with a value-free read_failed for a root it may not list', async (t) => {
    if (permissionsHold) return t.skip(permissionsHold);
    const pub = caseDir();
    write(pub, 'ok.txt', 'ok');
    chmodSync(pub, 0o000);
    try {
      for (const mode of ['snapshot', 'watch'] as const) {
        await assert.rejects(
          () =>
            createAssetIndex({
              roots: [{ dir: pub }],
              mode,
              watch: () => ({ close: () => undefined }),
            }),
          (error: unknown) =>
            AssetErrors.is(error, 'read_failed') &&
            error.message === 'asset . could not be read' &&
            !error.message.includes(pub),
        );
      }
    } finally {
      chmodSync(pub, 0o755);
    }
  });

  it('takes a filesystem failure as gone, unreadable, or a failure', () => {
    for (const code of ['ENOENT', 'ENOTDIR', 'ELOOP']) {
      assert.equal(readFailureOf(errnoError(code)), 'gone', code);
    }
    for (const code of ['EACCES', 'EPERM']) {
      assert.equal(readFailureOf(errnoError(code)), 'unreadable', code);
    }
    for (const code of ['EIO', 'EMFILE', 'ENFILE']) {
      assert.equal(readFailureOf(errnoError(code)), 'failed', code);
    }
    assert.equal(readFailureOf(new Error('no code')), 'failed');
  });

  it('serves a plugin root under its prefix and refuses two roots serving one path', async () => {
    const app = caseDir();
    const plugin = caseDir();
    write(app, 'app.css', 'a');
    write(plugin, 'widget.js', 'w');
    const index = await createAssetIndex({
      roots: [{ dir: app }, { dir: plugin, prefix: '/plugins/widget', owner: 'widget' }],
    });
    assert.deepEqual([...index.paths()], ['/app.css', '/plugins/widget/widget.js']);
    assert.equal(index.get('/plugins/widget/widget.js')?.owner, 'widget');

    write(app, 'plugins/widget/widget.js', 'shadow');
    await assert.rejects(
      () =>
        createAssetIndex({
          roots: [{ dir: app }, { dir: plugin, prefix: '/plugins/widget', owner: 'widget' }],
        }),
      (error: unknown) =>
        AssetErrors.is(error, 'duplicate_asset') &&
        error.message === '1 asset path(s) are served by two roots, first plugins/widget/widget.js',
    );
    for (const prefix of ['plugins', '/plugins/', '/.hidden', '/a//b']) {
      await assert.rejects(
        () => createAssetIndex({ roots: [{ dir: plugin, prefix }] }),
        (error: unknown) => AssetErrors.is(error, 'invalid_prefix'),
        prefix,
      );
    }
  });

  it('answers a directory request with its index document', async () => {
    const pub = caseDir();
    write(pub, 'index.html', '<h1>home</h1>');
    write(pub, 'sub/index.html', '<p>sub</p>');
    write(pub, 'file.txt', 'file');
    mkdirSync(join(pub, 'empty'));
    const index = await createAssetIndex({ roots: [{ dir: pub }] });
    assert.equal(index.get('/')?.path, '/index.html');
    assert.equal(index.get('/sub/')?.path, '/sub/index.html');
    assert.equal(index.get('/sub')?.path, '/sub/index.html');
    assert.equal(index.get('/empty/'), undefined);
    assert.equal(index.get('/file.txt/'), undefined);
  });
});

describe('AssetIndex.url', () => {
  it('versions an indexed path with its content hash, the same on every call', async () => {
    const pub = caseDir();
    write(pub, 'assets/app.js', 'const app = 1;\n');
    const index = await createAssetIndex({ roots: [{ dir: pub }] });
    const url = index.url('/assets/app.js');
    assert.equal(url, `/assets/app.js?v=${hashOf('const app = 1;\n')}`);
    assert.equal(index.url('/assets/app.js'), url);
  });

  it('percent-encodes the path it emits', async () => {
    const pub = caseDir();
    write(pub, 'assets/café.js', 'const café = 1;\n');
    write(pub, 'a b.txt', 'spaced');
    const index = await createAssetIndex({ roots: [{ dir: pub }] });
    assert.equal(
      index.url('/assets/café.js'),
      `/assets/caf%C3%A9.js?v=${hashOf('const café = 1;\n')}`,
    );
    assert.equal(index.url('/a b.txt'), `/a%20b.txt?v=${hashOf('spaced')}`);
  });

  it('returns anything the index does not hold unchanged', async () => {
    const base = caseDir();
    const pub = join(base, 'public');
    write(pub, 'app.js', 'ok');
    write(base, 'secret.js', 'TOP SECRET');
    const index = await createAssetIndex({ roots: [{ dir: pub }] });
    for (const path of [
      '/missing.js',
      '/app.js/',
      '/../secret.js',
      '/a/../../b.js',
      '/.env',
      '/a\\b.js',
      'https://example.com/app.js',
      '//example.com/app.js',
      '/app.js?v=1',
      '/app.js#frag',
      '/a//b.js',
      'app.js',
    ]) {
      assert.equal(index.url(path), path, JSON.stringify(path));
    }
    assert.match(index.url('/app.js'), /\?v=[A-Za-z0-9_-]{16}$/);
    const absent = await createAssetIndex({ roots: [{ dir: join(base, 'absent') }] });
    assert.equal(absent.url('/app.js'), '/app.js');
  });

  it('emits an immutable entry without a version query', () => {
    const entry: AssetEntry = {
      path: '/assets/app-3f2a.js',
      file: '/unused',
      hash: 'abcdefghijklmnop',
      size: 1,
      immutable: true,
      encodings: {},
      owner: 'app',
    };
    const index = assetIndexOf([entry]);
    assert.equal(index.source, 'manifest');
    assert.equal(index.url('/assets/app-3f2a.js'), '/assets/app-3f2a.js');
  });
});
