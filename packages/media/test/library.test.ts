/**
 * Media library tests.
 *
 * Everything runs against an in-memory {@link MemoryDisk}, so no filesystem or
 * network is ever touched. Covered:
 *
 * - upload/list/get/update/remove round trip, including frozen descriptors and
 *   disk bytes written under the id-prefixed key;
 * - size and MIME allowlist rejection (`too_large` / `unsupported_content_type`);
 * - traversal / absolute / control-character filename rejection (`path_rejected`);
 * - a `not_found` error for removing a missing asset and `undefined` results
 *   for `get`/`update` on a missing id.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryDisk } from '@jsails/filesystem';
import type { Disk } from 'jsails/filesystem';
import { MediaLibraryError, createMediaLibrary, type MediaLibrary } from '../src/index.js';
import {
  JPEG_BYTES,
  PDF_BYTES,
  PNG_BYTES as IMAGE,
  pngOfSize,
  pngWithDimensions,
} from './fixtures.js';

/** Build a library over a fresh memory disk with a deterministic id clock. */
function makeLibrary(overrides?: {
  maxBytes?: number;
  allowedTypes?: readonly string[];
  now?: () => Date;
}): { library: MediaLibrary; disk: MemoryDisk } {
  const disk = new MemoryDisk();
  let sequence = 0;
  const library = createMediaLibrary({
    disk,
    diskName: 'uploads',
    maxBytes: overrides?.maxBytes,
    allowedTypes: overrides?.allowedTypes,
    now: overrides?.now,
    nextId: () => `asset-${(sequence += 1)}`,
  });
  return { library, disk };
}

describe('createMediaLibrary', () => {
  it('uploads, lists, gets, updates, and removes an asset', async () => {
    const { library, disk } = makeLibrary();
    const uploaded = await library.upload({
      bytes: IMAGE,
      filename: 'hero.png',
      mimeType: 'image/png',
      alt: 'A hero image',
      caption: 'The header banner',
      width: 1200,
      height: 630,
    });

    assert.equal(uploaded.id, 'asset-1');
    assert.equal(uploaded.disk, 'uploads');
    assert.equal(uploaded.path, 'media/asset-1/hero.png');
    assert.equal(uploaded.filename, 'hero.png');
    assert.equal(uploaded.mimeType, 'image/png');
    assert.equal(uploaded.size, IMAGE.byteLength);
    // Dimensions come from the bytes (a 1×1 PNG), not the caller's claim.
    assert.equal(uploaded.width, 1);
    assert.equal(uploaded.height, 1);
    assert.equal(uploaded.alt, 'A hero image');
    assert.equal(uploaded.caption, 'The header banner');
    assert.equal(uploaded.createdAt, uploaded.updatedAt);
    assert.ok(Object.isFrozen(uploaded));

    // The bytes were written under the id-prefixed key.
    assert.deepEqual(await disk.get('media/asset-1/hero.png'), IMAGE);

    const listed = await library.list();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], uploaded);

    const fetched = await library.get('asset-1');
    assert.deepEqual(fetched, uploaded);

    const updated = await library.update('asset-1', { alt: 'Alt text', caption: 'New caption' });
    assert.ok(updated !== undefined);
    assert.equal(updated?.id, 'asset-1');
    assert.equal(updated?.alt, 'Alt text');
    assert.equal(updated?.caption, 'New caption');
    assert.equal(updated?.filename, 'hero.png', 'update never touches the recorded filename');
    assert.ok((updated?.updatedAt ?? '') >= (updated?.createdAt ?? ''));

    // A partial update preserves the unmentioned field.
    const altOnly = await library.update('asset-1', { alt: 'Only alt' });
    assert.equal(altOnly?.alt, 'Only alt');
    assert.equal(altOnly?.caption, 'New caption');

    await library.remove('asset-1');
    assert.equal((await library.list()).length, 0);
    assert.equal(await disk.exists('media/asset-1/hero.png'), false);
  });

  it('reports undefined get/update for a missing id and not_found for remove', async () => {
    const { library } = makeLibrary();
    assert.equal(await library.get('missing'), undefined);
    assert.equal(await library.update('missing', { alt: 'x' }), undefined);
    await assert.rejects(
      library.remove('missing'),
      (error: unknown) => error instanceof MediaLibraryError && error.code === 'not_found',
    );
  });

  it('content() returns the bytes, recorded mime type, and filename', async () => {
    const { library } = makeLibrary();
    const asset = await library.upload({
      bytes: IMAGE,
      filename: 'hero.png',
      mimeType: 'image/png',
    });
    const content = await library.content(asset.id);
    assert.deepEqual(content.bytes, IMAGE);
    assert.equal(content.mimeType, 'image/png');
    assert.equal(content.filename, 'hero.png');
  });

  it('content() raises not_found for a missing id, value-free', async () => {
    const { library } = makeLibrary();
    await assert.rejects(
      library.content('missing'),
      (error: unknown) => error instanceof MediaLibraryError && error.code === 'not_found',
    );
  });

  it('content() raises invalid_input for an empty id', async () => {
    const { library } = makeLibrary();
    await assert.rejects(
      library.content(''),
      (error: unknown) => error instanceof MediaLibraryError && error.code === 'invalid_input',
    );
  });

  it('trims the filename and lower-cases the mime type', async () => {
    const { library } = makeLibrary();
    const asset = await library.upload({
      bytes: IMAGE,
      filename: '  Hero.png ',
      mimeType: 'IMAGE/PNG',
    });
    assert.equal(asset.filename, 'Hero.png');
    assert.equal(asset.mimeType, 'image/png');
  });

  it('rejects over-size payloads with too_large', async () => {
    const { library } = makeLibrary({ maxBytes: 4 });
    await assert.rejects(
      library.upload({ bytes: IMAGE, filename: 'big.png', mimeType: 'image/png' }),
      (error: unknown) => error instanceof MediaLibraryError && error.code === 'too_large',
    );
    assert.equal((await library.list()).length, 0, 'no bytes or record written on failure');
  });

  it('rejects a disallowed mime type with unsupported_content_type', async () => {
    const { library } = makeLibrary();
    await assert.rejects(
      library.upload({ bytes: IMAGE, filename: 'script.svg', mimeType: 'image/svg+xml' }),
      (error: unknown) =>
        error instanceof MediaLibraryError && error.code === 'unsupported_content_type',
    );
  });

  it('honors a wildcard allowlist entry', async () => {
    const { library } = makeLibrary({ allowedTypes: ['image/*'] });
    const asset = await library.upload({
      bytes: JPEG_BYTES,
      filename: 'pic.jpg',
      mimeType: 'image/jpeg',
    });
    assert.equal(asset.mimeType, 'image/jpeg');
  });

  it('rejects an empty payload with invalid_input', async () => {
    const { library } = makeLibrary();
    await assert.rejects(
      library.upload({ bytes: new Uint8Array(), filename: 'x.png', mimeType: 'image/png' }),
      (error: unknown) => error instanceof MediaLibraryError && error.code === 'invalid_input',
    );
  });
});

/** Expect an upload to fail with `code`. */
async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof MediaLibraryError && error.code === code,
  );
}

describe('upload content checks', () => {
  it('rejects bytes that do not match the declared image type', async () => {
    const { library, disk } = makeLibrary();
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    await rejectsWith(
      library.upload({ bytes: html, filename: 'x.png', mimeType: 'image/png' }),
      'unsupported_content_type',
    );
    await rejectsWith(
      library.upload({ bytes: JPEG_BYTES, filename: 'x.png', mimeType: 'image/png' }),
      'unsupported_content_type',
    );
    assert.equal((await library.list()).length, 0);
    assert.equal((await disk.list('')).length, 0);
  });

  it('rejects sniffed content outside the allowlist even when declared as allowed', async () => {
    const { library } = makeLibrary({ allowedTypes: ['image/png'] });
    await rejectsWith(
      library.upload({ bytes: PDF_BYTES, filename: 'x.png', mimeType: 'image/png' }),
      'unsupported_content_type',
    );
  });

  it('records the sniffed type when the client declares none', async () => {
    const { library } = makeLibrary();
    const asset = await library.upload({
      bytes: IMAGE,
      filename: 'upload.bin',
      mimeType: 'application/octet-stream',
    });
    assert.equal(asset.mimeType, 'image/png');
    assert.equal(asset.filename, 'upload.png');
    await rejectsWith(
      library.upload({
        bytes: new TextEncoder().encode('plain'),
        filename: 'x.bin',
        mimeType: 'application/octet-stream',
      }),
      'unsupported_content_type',
    );
  });

  it('rewrites an extension that names a different type than the content', async () => {
    const { library } = makeLibrary();
    const asset = await library.upload({
      bytes: IMAGE,
      filename: 'payload.html',
      mimeType: 'image/png',
    });
    assert.equal(asset.filename, 'payload.png');
    assert.equal(asset.path, 'media/asset-1/payload.png');
  });

  it('accepts a legacy alias of the sniffed type', async () => {
    const { library } = makeLibrary();
    const asset = await library.upload({
      bytes: JPEG_BYTES,
      filename: 'photo.jpg',
      mimeType: 'image/jpg',
    });
    assert.equal(asset.mimeType, 'image/jpeg');
    assert.equal(asset.filename, 'photo.jpg');
  });

  it('keeps caller dimensions for content that has none, validated', async () => {
    const { library } = makeLibrary();
    const asset = await library.upload({
      bytes: PDF_BYTES,
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      width: 600,
      height: 800,
    });
    assert.equal(asset.width, 600);
    assert.equal(asset.height, 800);
    await rejectsWith(
      library.upload({ bytes: IMAGE, filename: 'a.png', mimeType: 'image/png', width: -1 }),
      'invalid_input',
    );
  });

  it('refuses an image above maxPixels', async () => {
    const { library } = makeLibrary();
    await rejectsWith(
      library.upload({
        bytes: pngWithDimensions(20_000, 20_000),
        filename: 'bomb.png',
        mimeType: 'image/png',
      }),
      'too_large',
    );
  });

  it('defaults the size cap below the framework 1 MiB body cap', async () => {
    const { library } = makeLibrary();
    await rejectsWith(
      library.upload({ bytes: pngOfSize(1024 * 1024), filename: 'a.png', mimeType: 'image/png' }),
      'too_large',
    );
    const asset = await library.upload({
      bytes: pngOfSize(900 * 1024),
      filename: 'a.png',
      mimeType: 'image/png',
    });
    assert.equal(asset.size, 900 * 1024);
  });
});

describe('query', () => {
  it('filters, orders, and pages with a total', async () => {
    const { library } = makeLibrary();
    for (const name of ['c.png', 'a.png', 'b.png']) {
      await library.upload({ bytes: IMAGE, filename: name, mimeType: 'image/png' });
    }
    await library.upload({ bytes: PDF_BYTES, filename: 'doc.pdf', mimeType: 'application/pdf' });

    const page = await library.query({ mime: 'image/*', limit: 2, offset: 1 });
    assert.equal(page.total, 3);
    assert.deepEqual(
      page.assets.map((asset) => asset.filename),
      ['b.png', 'c.png'],
    );
    assert.equal((await library.query({ q: 'DOC', limit: 10 })).total, 1);
  });

  it('rejects an unbounded or malformed page', async () => {
    const { library } = makeLibrary();
    await rejectsWith(library.query({ limit: 0 }), 'invalid_input');
    await rejectsWith(library.query({ limit: 1001 }), 'invalid_input');
    await rejectsWith(library.query({ limit: 1, offset: -1 }), 'invalid_input');
  });

  it('delegates to the index query instead of listing the whole index', async () => {
    let listed = 0;
    let queried = 0;
    const library = createMediaLibrary({
      disk: new MemoryDisk(),
      diskName: 'uploads',
      metadata: {
        list: async () => {
          listed += 1;
          return [];
        },
        query: async () => {
          queried += 1;
          return { assets: [], total: 0 };
        },
        get: async () => undefined,
        put: async () => {},
        remove: async () => {},
      },
    });
    await library.query({ limit: 10 });
    assert.equal(queried, 1);
    assert.equal(listed, 0);
  });
});

describe('stream', () => {
  const bytes = pngOfSize(100);

  /** The core Disk surface only, so the library must fall back to `get`. */
  function plainDisk(inner: MemoryDisk): Disk {
    return {
      put: (key, data, options) => inner.put(key, data, options),
      get: (key) => inner.get(key),
      exists: (key) => inner.exists(key),
      delete: (key) => inner.delete(key),
      list: (prefix) => inner.list(prefix),
      size: (key) => inner.size(key),
    };
  }

  for (const [label, wrap] of [
    ['a streaming disk', (disk: MemoryDisk): Disk => disk],
    ['a plain disk', plainDisk],
  ] as const) {
    it(`streams the whole asset and a range from ${label}`, async () => {
      const library = createMediaLibrary({ disk: wrap(new MemoryDisk()), diskName: 'uploads' });
      const asset = await library.upload({ bytes, filename: 'a.png', mimeType: 'image/png' });

      const whole = await library.stream(asset);
      assert.equal(whole.size, 100);
      assert.deepEqual(new Uint8Array(await new Response(whole.stream).arrayBuffer()), bytes);

      const part = await library.stream(asset, { start: 10, end: 19 });
      assert.equal(part.start, 10);
      assert.equal(part.end, 19);
      assert.equal(part.mimeType, 'image/png');
      assert.deepEqual(
        new Uint8Array(await new Response(part.stream).arrayBuffer()),
        bytes.subarray(10, 20),
      );
      await rejectsWith(library.stream(asset, { start: 100 }), 'invalid_range');
    });
  }
});

describe('remove with variants', () => {
  it('purges the variants derived from the removed asset', async () => {
    const purged: string[] = [];
    const library = createMediaLibrary({
      disk: new MemoryDisk(),
      diskName: 'uploads',
      nextId: () => 'asset-1',
      variants: {
        purge: async (key) => {
          purged.push(key);
        },
      },
    });
    const asset = await library.upload({ bytes: IMAGE, filename: 'a.png', mimeType: 'image/png' });
    await library.remove(asset.id);
    assert.deepEqual(purged, ['media/asset-1/a.png']);
  });
});

describe('filename path safety', () => {
  const unsafe = [
    '../evil.png',
    'a/b.png',
    'a\\b.png',
    '/absolute.png',
    '.hidden.png',
    'nul\u0000l.png',
  ];

  for (const filename of unsafe) {
    it(`rejects the unsafe filename ${JSON.stringify(filename)} with path_rejected`, async () => {
      const { library } = makeLibrary();
      await assert.rejects(
        library.upload({ bytes: IMAGE, filename, mimeType: 'image/png' }),
        (error: unknown) => error instanceof MediaLibraryError && error.code === 'path_rejected',
      );
      assert.equal((await library.list()).length, 0);
    });
  }

  it('rejects an unsafe generated id with path_rejected', async () => {
    const library = createMediaLibrary({
      disk: new MemoryDisk(),
      nextId: () => '../escape',
    });
    await assert.rejects(
      library.upload({ bytes: IMAGE, filename: 'x.png', mimeType: 'image/png' }),
      (error: unknown) => error instanceof MediaLibraryError && error.code === 'path_rejected',
    );
  });
});
