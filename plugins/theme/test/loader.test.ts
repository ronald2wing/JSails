/**
 * Tests for the server-only theme package filesystem loader. Verifies safe
 * template/preview loading, traversal rejection, symlink/absolute rejection,
 * malformed-template handling, missing-file handling, preview MIME mapping, and
 * that undeclared paths are never read. Symlink/containment cases run against
 * real temp directories; happy-path and parsing cases use an injected `io`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { parseThemePackageManifest } from '../src/packages/index.js';
import type { ThemePackageManifest } from '../src/packages/index.js';
import {
  loadThemePreview,
  loadThemeTemplates,
  ThemeLoaderError,
  type ThemeLoaderIo,
} from '../src/server/index.js';
import { ThemeTemplateError } from '../src/index.js';

/** A minimal valid manifest fixture with the given declared templates/partials/preview. */
function manifest(overrides: Record<string, unknown> = {}): ThemePackageManifest {
  return parseThemePackageManifest({
    name: 'fixture',
    version: '1.0.0',
    ...overrides,
  });
}

/**
 * Build a manifest-shaped object directly, bypassing `parseThemePackageManifest`.
 * This lets loader tests supply an unsafe declared path (which the parser would
 * already reject) to exercise the loader's own defense-in-depth containment.
 */
function rawManifest(overrides: Partial<ThemePackageManifest> = {}): ThemePackageManifest {
  return {
    name: 'fixture',
    version: '1.0.0',
    tokens: {},
    templates: [],
    partials: [],
    contentTypes: [],
    layouts: {},
    css: '',
    ...overrides,
  };
}

/** A minimal valid template document for `templates/post.html`. */
const postTemplateJson = JSON.stringify({
  version: 1,
  name: 'post',
  contentType: 'article',
  root: { type: 'element', tag: 'article', children: [{ type: 'slot', name: 'title' }] },
});

/** A minimal valid partial document for `partials/header.html`. */
const headerTemplateJson = JSON.stringify({
  version: 1,
  name: 'header',
  root: { type: 'element', tag: 'header', children: [{ type: 'slot', name: 'nav' }] },
});

/** Build an in-memory `io` over a `Record<path, string>` (UTF-8 text). */
function memoryIo(files: Record<string, string>): ThemeLoaderIo {
  return {
    async readFile(path) {
      const contents = files[path];
      if (contents === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return new TextEncoder().encode(contents);
    },
    async realpath(path) {
      // The root packageDir must resolve to itself for containment checks.
      const root = '/pkg';
      if (path === root) return root;
      if (path.startsWith(root)) return path;
      // Simulated escape: a path that does not live under the root.
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    async lstat(path) {
      if (files[path] === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return { isFile: () => true, isDirectory: () => false };
    },
  };
}

/** Create a fresh temp directory and register cleanup on the test. */
function tempRoot(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-theme-loader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PKG = '/pkg';

describe('loadThemeTemplates', () => {
  it('loads declared templates and partials keyed by template name', async () => {
    const io = memoryIo({
      '/pkg/templates/post.html': postTemplateJson,
      '/pkg/partials/header.html': headerTemplateJson,
    });
    const result = await loadThemeTemplates(
      PKG,
      manifest({ templates: ['templates/post.html'], partials: ['partials/header.html'] }),
      { io },
    );
    assert.equal(result.size, 2);
    assert.equal(result.get('post')?.name, 'post');
    assert.equal(result.get('header')?.name, 'header');
  });

  it('returns an empty frozen map for a manifest with no paths', async () => {
    const result = await loadThemeTemplates(PKG, manifest(), { io: memoryIo({}) });
    assert.equal(result.size, 0);
    assert.ok(Object.isFrozen(result));
  });

  it('rejects a lexically unsafe template path (traversal)', async () => {
    await assert.rejects(
      loadThemeTemplates(PKG, rawManifest({ templates: ['../escape.json'] }), {
        io: memoryIo({}),
      }),
      (error: unknown) => error instanceof ThemeLoaderError && error.code === 'invalid_path',
    );
  });

  it('rejects an absolute template path', async () => {
    await assert.rejects(
      loadThemeTemplates(PKG, rawManifest({ templates: ['/etc/passwd'] }), {
        io: memoryIo({}),
      }),
      (error: unknown) => error instanceof ThemeLoaderError && error.code === 'invalid_path',
    );
  });

  it('rejects a malformed template document as ThemeTemplateError', async () => {
    const io = memoryIo({ '/pkg/templates/post.html': '{ not valid json' });
    await assert.rejects(
      loadThemeTemplates(PKG, manifest({ templates: ['templates/post.html'] }), { io }),
      (error: unknown) => error instanceof ThemeTemplateError,
    );
  });

  it('rejects an unsafe template tree as ThemeTemplateError', async () => {
    const io = memoryIo({
      '/pkg/templates/post.html': JSON.stringify({
        version: 1,
        name: 'post',
        root: {
          type: 'element',
          tag: 'div',
          attributes: { style: 'background:url(x)' },
          children: [],
        },
      }),
    });
    await assert.rejects(
      loadThemeTemplates(PKG, manifest({ templates: ['templates/post.html'] }), { io }),
      (error: unknown) => error instanceof ThemeTemplateError && error.code === 'unsafe_template',
    );
  });

  it('rejects a missing template file', async () => {
    await assert.rejects(
      loadThemeTemplates(PKG, manifest({ templates: ['templates/missing.html'] }), {
        io: memoryIo({}),
      }),
      (error: unknown) => error instanceof ThemeLoaderError && error.code === 'not_found',
    );
  });

  it('rejects a symlink that escapes the package directory', async (t) => {
    const root = tempRoot(t);
    const outside = tempRoot(t);
    const secret = join(outside, 'secret.json');
    writeFileSync(secret, postTemplateJson);
    const link = join(root, 'templates');
    symlinkSync(outside, link);

    await assert.rejects(
      loadThemeTemplates(root, manifest({ templates: ['templates/secret.json'] })),
      (error: unknown) => error instanceof ThemeLoaderError && error.code === 'invalid_path',
    );
  });

  it('never reads a path that is not declared in the manifest', async () => {
    const read: string[] = [];
    const io: ThemeLoaderIo = {
      readFile: async (path) => {
        read.push(path);
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      realpath: async (path) => path,
      lstat: async () => ({ isFile: () => true, isDirectory: () => false }),
    };
    await assert.rejects(
      loadThemeTemplates(PKG, manifest({ templates: ['templates/post.html'] }), { io }),
      (error: unknown) => error instanceof ThemeLoaderError && error.code === 'not_found',
    );
    assert.equal(read.length, 1);
    assert.ok(read[0]!.endsWith('templates/post.html'));
  });
});

describe('loadThemePreview', () => {
  it('returns bytes and a PNG MIME type for a declared preview', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const io: ThemeLoaderIo = {
      readFile: async () => bytes,
      realpath: async (path) => path,
      lstat: async () => ({ isFile: () => true, isDirectory: () => false }),
    };
    const result = await loadThemePreview(PKG, manifest({ preview: 'assets/preview.png' }), { io });
    assert.deepEqual(result, { bytes, contentType: 'image/png' });
  });

  it('maps jpeg and webp extensions to the right MIME type', async () => {
    for (const [path, expected] of [
      ['assets/preview.jpg', 'image/jpeg'],
      ['assets/preview.jpeg', 'image/jpeg'],
      ['assets/preview.webp', 'image/webp'],
    ] as const) {
      const io: ThemeLoaderIo = {
        readFile: async () => new Uint8Array(),
        realpath: async (p) => p,
        lstat: async () => ({ isFile: () => true, isDirectory: () => false }),
      };
      const result = await loadThemePreview(PKG, manifest({ preview: path }), { io });
      assert.equal(result?.contentType, expected, path);
    }
  });

  it('rejects a preview with an unsupported extension (SVG excluded)', async () => {
    const io: ThemeLoaderIo = {
      readFile: async () => new Uint8Array(),
      realpath: async (p) => p,
      lstat: async () => ({ isFile: () => true, isDirectory: () => false }),
    };
    await assert.rejects(
      loadThemePreview(PKG, manifest({ preview: 'assets/preview.svg' }), { io }),
      (error: unknown) => error instanceof ThemeLoaderError && error.code === 'invalid_path',
    );
  });

  it('returns undefined when the manifest declares no preview', async () => {
    const result = await loadThemePreview(PKG, manifest(), { io: memoryIo({}) });
    assert.equal(result, undefined);
  });

  it('rejects a missing preview file', async () => {
    await assert.rejects(
      loadThemePreview(PKG, manifest({ preview: 'assets/missing.png' }), { io: memoryIo({}) }),
      (error: unknown) => error instanceof ThemeLoaderError && error.code === 'not_found',
    );
  });

  it('rejects a traversal preview path', async () => {
    await assert.rejects(
      loadThemePreview(PKG, rawManifest({ preview: '../secret.png' }), { io: memoryIo({}) }),
      (error: unknown) => error instanceof ThemeLoaderError && error.code === 'invalid_path',
    );
  });

  it('rejects an absolute preview path', async () => {
    await assert.rejects(
      loadThemePreview(PKG, rawManifest({ preview: '/abs.png' }), { io: memoryIo({}) }),
      (error: unknown) => error instanceof ThemeLoaderError && error.code === 'invalid_path',
    );
  });
});
