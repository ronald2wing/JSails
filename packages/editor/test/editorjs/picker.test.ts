import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isMediaPickerUrl,
  mapMediaAssetsToPickerItems,
  pickerItemLabel,
  type MediaPickerItem,
} from '../../src/editorjs/picker.js';

describe('isMediaPickerUrl', () => {
  it('accepts a root-relative path', () => {
    assert.equal(isMediaPickerUrl('/admin/media?format=json'), true);
  });

  it('accepts an absolute http(s) URL', () => {
    assert.equal(isMediaPickerUrl('https://example.com/admin/media?format=json'), true);
    assert.equal(isMediaPickerUrl('http://example.com/media'), true);
  });

  it('rejects blank values', () => {
    assert.equal(isMediaPickerUrl(''), false);
    assert.equal(isMediaPickerUrl('   '), false);
  });

  it('rejects control characters', () => {
    assert.equal(isMediaPickerUrl('/admin/media\u0000'), false);
    assert.equal(isMediaPickerUrl('/admin/media\n'), false);
  });

  it('rejects protocol-relative URLs and forbidden or misrooted shapes', () => {
    assert.equal(isMediaPickerUrl('//example.com/media'), false);
    assert.equal(isMediaPickerUrl('javascript:alert(1)'), false);
    assert.equal(isMediaPickerUrl('data:text/plain,hi'), false);
    assert.equal(isMediaPickerUrl('../media'), false);
    assert.equal(isMediaPickerUrl('/admin/../media'), false);
    assert.equal(isMediaPickerUrl('/admin\\media'), false);
  });
});

describe('mapMediaAssetsToPickerItems', () => {
  it('returns an empty list for anything but the paged envelope', () => {
    assert.deepEqual(mapMediaAssetsToPickerItems(undefined), []);
    assert.deepEqual(mapMediaAssetsToPickerItems(null), []);
    assert.deepEqual(mapMediaAssetsToPickerItems({}), []);
    assert.deepEqual(mapMediaAssetsToPickerItems('[]'), []);
    assert.deepEqual(mapMediaAssetsToPickerItems([]), []);
    assert.deepEqual(mapMediaAssetsToPickerItems({ assets: 'nope' }), []);
  });

  it('accepts the paged { assets, total } envelope', () => {
    const payload = {
      assets: [{ id: 'a1', filename: 'logo.png', mimeType: 'image/png', size: 10 }],
      total: 42,
    };
    const items = mapMediaAssetsToPickerItems(payload);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, 'a1');
  });

  it('projects well-formed assets and skips malformed entries', () => {
    const assets = [
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
    const items = mapMediaAssetsToPickerItems({ assets, total: assets.length });
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
