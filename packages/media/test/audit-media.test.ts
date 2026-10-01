/**
 * Audit regressions for the media library (CNT-01): each test states the
 * correct behaviour for one audited defect. Those that fail today are listed,
 * with the failure they show, in `scripts/expected-failures/content.json`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryDisk } from '@jsails/filesystem';
import { auditCase } from 'jsails/testing';

import { createMediaLibrary, createMemoryMediaIndex, type MediaIndex } from '../src/index.js';
import { PNG_BYTES } from './fixtures.js';

test(
  ...auditCase(
    'media/orphan-on-index-failure',
    'an upload whose index write fails leaves no bytes on the disk',
  ),
  async () => {
    const disk = new MemoryDisk();
    const failingIndex: MediaIndex = {
      ...createMemoryMediaIndex(),
      put: async () => {
        throw new Error('index unavailable');
      },
    };
    const library = createMediaLibrary({ disk, metadata: failingIndex });
    await assert.rejects(
      library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' }),
    );
    assert.deepEqual(
      await disk.list('media'),
      [],
      'the bytes stay on the disk with no index row to find or remove them',
    );
  },
);

test(
  ...auditCase(
    'media/custom-type-keeps-foreign-extension',
    'a stored filename never keeps an extension that implies another type',
  ),
  async () => {
    const library = createMediaLibrary({
      disk: new MemoryDisk(),
      allowedTypes: ['application/x-audit-notes'],
    });
    const asset = await library.upload({
      bytes: Buffer.from('plain notes'),
      filename: 'notes.html',
      mimeType: 'application/x-audit-notes',
    });
    assert.ok(
      !asset.filename.endsWith('.html'),
      `stored as ${asset.filename}, which a download serves under an HTML name`,
    );
  },
);
