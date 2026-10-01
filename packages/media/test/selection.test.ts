/**
 * Editor media-selection helper tests.
 *
 * Pure, synchronous helpers (`selectMedia`, `toMediaRef`) with no I/O. Covered:
 *
 * - search across filename/alt/caption (case-insensitive substring);
 * - the MIME filter (exact and wildcard);
 * - deterministic ordering by filename then id, independent of the input order;
 * - the minimal, frozen `MediaRef` projection.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectMedia, toMediaRef, type MediaAsset } from '../src/index.js';

/** Build an asset with the given id overriding the provided fields. */
function asset(id: string, over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    disk: 'uploads',
    path: `media/${id}/f.png`,
    filename: 'hero.png',
    mimeType: 'image/png',
    size: 4,
    alt: '',
    caption: '',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('selectMedia', () => {
  const assets: readonly MediaAsset[] = [
    asset('a', { filename: 'zebra.jpg', mimeType: 'image/jpeg', alt: 'A zebra' }),
    asset('b', { filename: 'apple.png', caption: 'Red apple still life' }),
    asset('c', { filename: 'notes.pdf', mimeType: 'application/pdf', alt: 'Meeting notes' }),
  ];

  it('returns all assets in deterministic order with no query', () => {
    assert.deepEqual(
      selectMedia(assets).map((a) => a.filename),
      ['apple.png', 'notes.pdf', 'zebra.jpg'],
    );
  });

  it('searches filename, alt, and caption case-insensitively', () => {
    assert.deepEqual(
      selectMedia(assets, { q: 'APPLE' }).map((a) => a.id),
      ['b'],
    );
    assert.deepEqual(
      selectMedia(assets, { q: 'zebra' }).map((a) => a.id),
      ['a'],
    );
    assert.deepEqual(
      selectMedia(assets, { q: 'meeting' }).map((a) => a.id),
      ['c'],
    );
  });

  it('filters by exact and wildcard mime type', () => {
    assert.deepEqual(
      selectMedia(assets, { mime: 'image/png' }).map((a) => a.id),
      ['b'],
    );
    // Wildcard keeps both images, still ordered by filename (apple before zebra).
    assert.deepEqual(
      selectMedia(assets, { mime: 'image/*' }).map((a) => a.id),
      ['b', 'a'],
    );
  });

  it('is order-independent (deterministic by filename then id)', () => {
    const reversed = [...assets].reverse();
    assert.deepEqual(selectMedia(reversed), selectMedia(assets));
  });

  it('breaks filename ties by id', () => {
    const ties: readonly MediaAsset[] = [
      asset('z', { filename: 'same.png' }),
      asset('a', { filename: 'same.png' }),
    ];
    assert.deepEqual(
      selectMedia(ties).map((a) => a.id),
      ['a', 'z'],
    );
  });

  it('does not mutate the input array', () => {
    const copy = [...assets];
    selectMedia(assets, { q: 'apple' });
    assert.deepEqual(assets, copy);
  });
});

describe('toMediaRef', () => {
  it('projects a minimal frozen media reference without the disk key', () => {
    const ref = toMediaRef(asset('a', { filename: 'hero.png', width: 1200, height: 630 }));
    assert.deepEqual(ref, {
      id: 'a',
      filename: 'hero.png',
      mimeType: 'image/png',
      width: 1200,
      height: 630,
    });
    assert.ok(Object.isFrozen(ref));
    assert.ok(!('path' in ref));
  });

  it('omits dimensions when absent', () => {
    const ref = toMediaRef(asset('a'));
    assert.ok(!('width' in ref));
    assert.ok(!('height' in ref));
  });
});
