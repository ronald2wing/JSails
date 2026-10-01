import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RichTextDocument } from 'jsails/rich-text';

import {
  editorJsToRichText,
  richTextToEditorJs,
  type EditorJsOutputData,
} from '../../src/index.js';

/** A document wrapping the given blocks at the current version. */
function document(blocks: RichTextDocument['blocks']): RichTextDocument {
  return { version: 1, blocks };
}

/** The output returned by a successful reverse conversion, narrowed. */
function okOutput(result: ReturnType<typeof richTextToEditorJs>): EditorJsOutputData {
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error('unreachable');
  }
  return result.output;
}

describe('richTextToEditorJs reverse round-trip', () => {
  it('converts a document to Editor.js and back without loss', () => {
    const doc = document([
      { id: 'b1', type: 'paragraph', text: 'hello' },
      { id: 'b2', type: 'heading', level: 3, text: 'Title' },
      { id: 'b3', type: 'list', style: 'ordered', items: ['a', 'b'] },
      { id: 'b4', type: 'quote', text: 'said', citation: 'Tzu' },
      { id: 'b5', type: 'code', code: 'const x = 1;', language: 'ts' },
      { id: 'b6', type: 'divider' },
      { id: 'b7', type: 'image', mediaId: 'm1', alt: 'Alt', caption: 'Cap' },
      { id: 'b8', type: 'gallery', mediaIds: ['m1', 'm2'], alt: 'Gal' },
      { id: 'b9', type: 'embed', url: 'https://example.com/v' },
      { id: 'b10', type: 'callout', tone: 'warning', text: 'careful' },
      { id: 'b11', type: 'cta', label: 'Go', href: '/go' },
    ]);

    const reverse = okOutput(richTextToEditorJs(doc));
    assert.deepEqual(
      reverse.blocks.map((block) => block.type),
      [
        'paragraph',
        'header',
        'list',
        'quote',
        'code',
        'delimiter',
        'image',
        'gallery',
        'embed',
        'callout',
        'cta',
      ],
    );

    const forward = editorJsToRichText(reverse);
    assert.equal(forward.ok, true);
    if (!forward.ok) return;
    assert.deepEqual(forward.document, doc);
  });

  it('preserves block ids on the reverse path', () => {
    const doc = document([
      { id: 'stable-a', type: 'paragraph', text: 'one' },
      { id: 'stable-b', type: 'paragraph', text: 'two' },
    ]);
    const reverse = okOutput(richTextToEditorJs(doc));
    assert.deepEqual(
      reverse.blocks.map((block) => block.id),
      ['stable-a', 'stable-b'],
    );
  });
});

describe('richTextToEditorJs text escaping', () => {
  it('escapes < and & so they survive a round-trip', () => {
    const doc = document([{ id: 'b1', type: 'paragraph', text: 'Fish & chips < 2' }]);
    const reverse = okOutput(richTextToEditorJs(doc));
    const data = reverse.blocks[0]?.data;
    assert.equal(typeof (data as { text?: unknown }).text, 'string');
    assert.equal((data as { text: string }).text, 'Fish &amp; chips &lt; 2');

    const forward = editorJsToRichText(reverse);
    assert.equal(forward.ok, true);
    if (!forward.ok) return;
    assert.equal(
      forward.document.blocks[0]?.type === 'paragraph'
        ? forward.document.blocks[0].text
        : undefined,
      'Fish & chips < 2',
    );
  });

  it('escapes list items and quote text but not URLs or media ids', () => {
    const doc = document([
      { id: 'b1', type: 'list', style: 'unordered', items: ['a < b', 'c & d'] },
      { id: 'b2', type: 'cta', label: 'A & B < C', href: '/go?a=1&b=2' },
      { id: 'b3', type: 'image', mediaId: 'img<1>', alt: 'alt & <' },
    ]);
    const reverse = okOutput(richTextToEditorJs(doc));

    const list = reverse.blocks[0]?.data as { items?: unknown };
    assert.deepEqual(list.items, ['a &lt; b', 'c &amp; d']);

    const cta = reverse.blocks[1]?.data as { label?: unknown; href?: unknown };
    assert.equal(cta.label, 'A & B < C');
    assert.equal(cta.href, '/go?a=1&b=2');

    const image = reverse.blocks[2]?.data as { mediaId?: unknown; alt?: unknown };
    assert.equal(image.mediaId, 'img<1>');
    assert.equal(image.alt, 'alt & <');
  });

  it('preserves code bodies literally, including tags and entities', () => {
    const doc = document([{ id: 'b1', type: 'code', code: '<div>&amp;</div>', language: 'html' }]);
    const reverse = okOutput(richTextToEditorJs(doc));
    const code = reverse.blocks[0]?.data as { code?: unknown };
    assert.equal(code.code, '<div>&amp;</div>');

    const forward = editorJsToRichText(reverse);
    assert.equal(forward.ok, true);
    if (!forward.ok) return;
    assert.equal(
      forward.document.blocks[0]?.type === 'code' ? forward.document.blocks[0].code : undefined,
      '<div>&amp;</div>',
    );
  });
});

describe('richTextToEditorJs failures', () => {
  it('rejects an invalid document with invalid_document', () => {
    const result = richTextToEditorJs({ version: 2, blocks: [] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'invalid_document');
  });

  it('rejects a non-document input', () => {
    const result = richTextToEditorJs(null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'invalid_document');
  });
});
