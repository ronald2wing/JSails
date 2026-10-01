/**
 * Media library tests.
 *
 * Everything runs against an in-memory {@link MemoryDisk}, so no filesystem or
 * network is ever touched. Covered:
 *
 * - upload/list/get/update/remove round trip, including frozen descriptors and
 *   disk bytes written under the id-prefixed key;
 * - size and MIME allowlist rejection (`too_large` / `unsupported_type`);
 * - traversal / absolute / control-character filename rejection (`path_rejected`);
 * - a `not_found` error for removing a missing asset and `undefined` results
 *   for `get`/`update` on a missing id.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryDisk } from '@jsails/filesystem';
import { MediaError, createMediaLibrary, type MediaLibrary } from '../src/index.js';

const IMAGE = new TextEncoder().encode('fake png bytes');

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
    assert.equal(uploaded.width, 1200);
    assert.equal(uploaded.height, 630);
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
      (error: unknown) => error instanceof MediaError && error.code === 'not_found',
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
      (error: unknown) => error instanceof MediaError && error.code === 'not_found',
    );
  });

  it('content() raises invalid_input for an empty id', async () => {
    const { library } = makeLibrary();
    await assert.rejects(
      library.content(''),
      (error: unknown) => error instanceof MediaError && error.code === 'invalid_input',
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
      (error: unknown) => error instanceof MediaError && error.code === 'too_large',
    );
    assert.equal((await library.list()).length, 0, 'no bytes or record written on failure');
  });

  it('rejects a disallowed mime type with unsupported_type', async () => {
    const { library } = makeLibrary();
    await assert.rejects(
      library.upload({ bytes: IMAGE, filename: 'script.svg', mimeType: 'image/svg+xml' }),
      (error: unknown) => error instanceof MediaError && error.code === 'unsupported_type',
    );
  });

  it('honors a wildcard allowlist entry', async () => {
    const { library } = makeLibrary({ allowedTypes: ['image/*'] });
    const asset = await library.upload({
      bytes: IMAGE,
      filename: 'pic.jpg',
      mimeType: 'image/jpeg',
    });
    assert.equal(asset.mimeType, 'image/jpeg');
  });

  it('rejects an empty payload with invalid_input', async () => {
    const { library } = makeLibrary();
    await assert.rejects(
      library.upload({ bytes: new Uint8Array(), filename: 'x.png', mimeType: 'image/png' }),
      (error: unknown) => error instanceof MediaError && error.code === 'invalid_input',
    );
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
        (error: unknown) => error instanceof MediaError && error.code === 'path_rejected',
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
      (error: unknown) => error instanceof MediaError && error.code === 'path_rejected',
    );
  });
});
