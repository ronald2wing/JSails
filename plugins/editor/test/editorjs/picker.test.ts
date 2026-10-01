import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mapMediaAssetsToPickerItems,
  pickerItemLabel,
  validateMediaPickerUrl,
  type MediaPickerItem,
} from '../../src/index.js';

describe('validateMediaPickerUrl', () => {
  it('accepts a root-relative path', () => {
    assert.equal(validateMediaPickerUrl('/admin/media?format=json'), undefined);
  });

  it('accepts an absolute http(s) URL', () => {
    assert.equal(validateMediaPickerUrl('https://example.com/admin/media?format=json'), undefined);
    assert.equal(validateMediaPickerUrl('http://example.com/media'), undefined);
  });

  it('rejects non-strings', () => {
    assert.match(validateMediaPickerUrl(undefined) ?? '', /string/);
    assert.match(validateMediaPickerUrl(null) ?? '', /string/);
    assert.match(validateMediaPickerUrl(42) ?? '', /string/);
  });

  it('rejects blank values', () => {
    assert.match(validateMediaPickerUrl('') ?? '', /non-empty/);
    assert.match(validateMediaPickerUrl('   ') ?? '', /non-empty/);
  });

  it('rejects control characters', () => {
    assert.match(validateMediaPickerUrl('/admin/media\u0000') ?? '', /control characters/);
    assert.match(validateMediaPickerUrl('/admin/media\n') ?? '', /control characters/);
  });

  it('rejects protocol-relative URLs and forbidden/misrooted shapes', () => {
    assert.match(validateMediaPickerUrl('//example.com/media') ?? '', /root-relative/);
    assert.match(validateMediaPickerUrl('javascript:alert(1)') ?? '', /root-relative/);
    assert.match(validateMediaPickerUrl('data:text/plain,hi') ?? '', /root-relative/);
    assert.match(validateMediaPickerUrl('../media') ?? '', /root-relative/);
  });
});

describe('mapMediaAssetsToPickerItems', () => {
  it('returns an empty list for non-array payloads', () => {
    assert.deepEqual(mapMediaAssetsToPickerItems(undefined), []);
    assert.deepEqual(mapMediaAssetsToPickerItems(null), []);
    assert.deepEqual(mapMediaAssetsToPickerItems({}), []);
    assert.deepEqual(mapMediaAssetsToPickerItems('[]'), []);
  });

  it('projects well-formed assets and skips malformed entries', () => {
    const payload = [
      {
        id: 'a1',
        filename: 'logo.png',
        mimeType: 'image/png',
        size: 123,
        width: 10,
        height: 20,
        alt: 'Logo',
        caption: 'A logo',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      // missing id -> skipped
      { filename: 'no-id.png', mimeType: 'image/png', size: 1 },
      // id not a string -> skipped
      { id: 7, filename: 'num.png', mimeType: 'image/png', size: 1 },
      // negative size -> skipped
      { id: 'bad-size', filename: 'x.png', mimeType: 'image/png', size: -1 },
      // minimal valid entry (alt/caption default to '')
      { id: 'a2', filename: 'photo.jpg', mimeType: 'image/jpeg', size: 2048 },
    ];
    const items = mapMediaAssetsToPickerItems(payload);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      id: 'a1',
      filename: 'logo.png',
      mimeType: 'image/png',
      size: 123,
      alt: 'Logo',
      caption: 'A logo',
    });
    assert.deepEqual(items[1], {
      id: 'a2',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 2048,
      alt: '',
      caption: '',
    });
  });
});

describe('pickerItemLabel', () => {
  it('joins the filename and MIME type', () => {
    const item: MediaPickerItem = {
      id: 'a1',
      filename: 'logo.png',
      mimeType: 'image/png',
      size: 1,
      alt: '',
      caption: '',
    };
    assert.equal(pickerItemLabel(item), 'logo.png (image/png)');
  });

  it('falls back to the MIME type for a blank filename', () => {
    const item: MediaPickerItem = {
      id: 'a1',
      filename: '',
      mimeType: 'image/png',
      size: 1,
      alt: '',
      caption: '',
    };
    assert.equal(pickerItemLabel(item), 'image/png');
  });
});
