/**
 * Tests for `upgradeRichTextDocument`, the explicit path from a stored
 * version 1 document to version 2.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRichText, upgradeRichTextDocument } from '../../src/rich-text/index.js';

function upgraded(blocks: readonly unknown[]): unknown {
  const result = upgradeRichTextDocument({ version: 1, blocks });
  assert.ok(result.ok, JSON.stringify(result));
  return result.value.blocks;
}

describe('upgradeRichTextDocument', () => {
  it('maps every version 1 block kind and drops block ids', () => {
    assert.deepEqual(
      upgraded([
        { id: 'p', type: 'paragraph', text: 'Hello' },
        { id: 'h', type: 'heading', level: 3, text: 'Title' },
        { id: 'l', type: 'list', style: 'ordered', items: ['one', ''] },
        { id: 'q', type: 'quote', text: 'Said.', citation: 'Ada' },
        { id: 'c', type: 'code', code: '\tx < y', language: 'js' },
        { id: 'i', type: 'image', mediaId: 'm1', alt: 'A', caption: 'C' },
        { id: 'g', type: 'gallery', mediaIds: ['m1', 'm2'], alt: 'G' },
        { id: 'e', type: 'embed', url: 'https://www.youtube.com/embed/x' },
        { id: 'o', type: 'callout', tone: 'danger', text: 'Careful' },
        { id: 't', type: 'cta', label: 'Go', href: '/go' },
        { id: 'd', type: 'divider' },
      ]),
      [
        { type: 'paragraph', content: [{ text: 'Hello' }] },
        { type: 'heading', level: 3, content: [{ text: 'Title' }] },
        {
          type: 'list',
          style: 'ordered',
          items: [{ content: [{ text: 'one' }] }, { content: [] }],
        },
        { type: 'quote', content: [{ text: 'Said.' }], citation: 'Ada' },
        { type: 'code', code: '\tx < y', language: 'js' },
        { type: 'image', mediaId: 'm1', alt: 'A', caption: 'C' },
        { type: 'gallery', mediaIds: ['m1', 'm2'], alt: 'G' },
        { type: 'embed', url: 'https://www.youtube.com/embed/x' },
        { type: 'callout', tone: 'danger', content: [{ text: 'Careful' }] },
        { type: 'cta', label: 'Go', href: '/go' },
        { type: 'divider' },
      ],
    );
  });

  it('brings text within the version 2 rules', () => {
    assert.deepEqual(
      upgraded([
        { id: 'a', type: 'paragraph', text: 'one\r\ntwo\rthree\tfour\u0000\u202e\ud800' },
        { id: 'b', type: 'heading', level: 2, text: 'a\nb' },
        { id: 'c', type: 'image', mediaId: 'm', alt: 'x\ny' },
        { id: 'd', type: 'paragraph', text: '' },
      ]),
      [
        { type: 'paragraph', content: [{ text: 'one\ntwo\nthree four\ufffd' }] },
        { type: 'heading', level: 2, content: [{ text: 'a b' }] },
        { type: 'image', mediaId: 'm', alt: 'x y' },
        { type: 'paragraph', content: [] },
      ],
    );
  });

  it('turns a refused CTA href into a paragraph of its label, keeping no URL', () => {
    assert.deepEqual(upgraded([{ id: 't', type: 'cta', label: 'Go', href: 'javascript:x' }]), [
      { type: 'paragraph', content: [{ text: 'Go' }] },
    ]);
  });

  it('keeps the text of a CTA or image whose label or media id cleans to nothing', () => {
    assert.deepEqual(
      upgraded([
        { id: 'c', type: 'cta', label: '\u0007', href: '/pricing' },
        { id: 'i', type: 'image', mediaId: '\u0001', alt: 'A cat', caption: 'on a mat' },
      ]),
      [
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [{ text: 'A cat on a mat' }] },
      ],
    );
  });

  it('turns a non-https embed into its URL as text, linked when it is a valid link', () => {
    assert.deepEqual(
      upgraded([
        { id: 'a', type: 'embed', url: 'http://example.com/v' },
        { id: 'b', type: 'embed', url: 'javascript:x' },
      ]),
      [
        {
          type: 'paragraph',
          content: [{ text: 'http://example.com/v', href: 'http://example.com/v' }],
        },
        { type: 'paragraph', content: [{ text: 'javascript:x' }] },
      ],
    );
  });

  it('drops empty lists and galleries', () => {
    assert.deepEqual(
      upgraded([
        { id: 'l', type: 'list', style: 'unordered', items: [] },
        { id: 'g', type: 'gallery', mediaIds: [] },
      ]),
      [],
    );
  });

  it('produces documents parseRichText reads, and is idempotent', () => {
    const first = upgradeRichTextDocument({
      version: 1,
      blocks: [{ id: 'p', type: 'paragraph', text: 'x' }],
    });
    assert.ok(first.ok);
    assert.deepEqual(parseRichText(first.value), first);
    assert.deepEqual(upgradeRichTextDocument(first.value), first);
  });

  it('reports a document over the version 2 budget instead of storing it', () => {
    const items = Array.from({ length: 100 }, () => 'x'.repeat(2000));
    const result = upgradeRichTextDocument({
      version: 1,
      blocks: [{ id: 'l', type: 'list', style: 'ordered', items }],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ['block_too_long'],
      );
    }
  });

  it('refuses a malformed version 1 document and other versions', () => {
    const malformed = upgradeRichTextDocument({ version: 1, blocks: [{ type: 'video' }] });
    assert.equal(malformed.ok, false);
    const unknown = upgradeRichTextDocument({ version: 7, blocks: [] });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
      assert.equal(unknown.issues[0]?.code, 'unsupported_version');
    }
  });
});
