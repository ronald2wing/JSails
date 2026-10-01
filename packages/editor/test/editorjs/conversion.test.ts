import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RichTextDocument } from 'jsails/rich-text';

import {
  editorJsToRichText,
  richTextToEditorJs,
  type EditorJsOutputData,
} from '../../src/index.js';

/** Wrap a list of bare Editor.js blocks into an output payload. */
function output(blocks: readonly EditorJsOutputData['blocks'][number][]): EditorJsOutputData {
  return { blocks };
}

/** The document returned by a successful conversion, asserted not to be a failure. */
function okDocument(result: ReturnType<typeof editorJsToRichText>): RichTextDocument {
  assert.equal(result.ok, true);
  if (!result.ok) {
    // Unreachable after the assertion; keeps the narrowing local.
    throw new Error('unreachable');
  }
  return result.document;
}

describe('editorJsToRichText tool mapping', () => {
  it('maps every supported tool type', () => {
    const result = editorJsToRichText(
      output([
        { type: 'paragraph', data: { text: 'hello' } },
        { type: 'header', data: { level: 3, text: 'Heading' } },
        { type: 'list', data: { style: 'ordered', items: ['a', 'b'] } },
        { type: 'quote', data: { text: 'said', citation: 'Tzu' } },
        { type: 'code', data: { code: 'const x = 1;', language: 'ts' } },
        { type: 'delimiter', data: {} },
        { type: 'image', data: { mediaId: 'm1', alt: 'alt', caption: 'cap' } },
        { type: 'gallery', data: { mediaIds: ['m1', 'm2'], alt: 'gal' } },
        { type: 'embed', data: { url: 'https://example.com/v' } },
        { type: 'callout', data: { tone: 'warning', text: 'careful' } },
        { type: 'cta', data: { label: 'Go', href: '/go' } },
      ]),
    );
    const document = okDocument(result);
    assert.equal(document.blocks.length, 11);
    assert.deepEqual(
      document.blocks.map((block) => block.type),
      [
        'paragraph',
        'heading',
        'list',
        'quote',
        'code',
        'divider',
        'image',
        'gallery',
        'embed',
        'callout',
        'cta',
      ],
    );
  });

  it('maps an unordered list', () => {
    const result = editorJsToRichText(
      output([{ type: 'list', data: { style: 'unordered', items: ['x'] } }]),
    );
    const block = okDocument(result).blocks[0];
    assert.equal(block?.type, 'list');
    assert.equal(block?.type === 'list' ? block.style : undefined, 'unordered');
  });
});

describe('editorJsToRichText HTML normalization', () => {
  it('strips tags and decodes entities in paragraph text', () => {
    const result = editorJsToRichText(
      output([
        {
          type: 'paragraph',
          data: { text: '<p>Fish &amp; chips &#8212; <strong>bold</strong></p>' },
        },
      ]),
    );
    const block = okDocument(result).blocks[0];
    assert.equal(block?.type === 'paragraph' ? block.text : undefined, 'Fish & chips — bold');
  });

  it('normalized list items and quote citation', () => {
    const result = editorJsToRichText(
      output([
        {
          type: 'list',
          data: { style: 'ordered', items: ['<b>one</b>', 'two &lt; three'] },
        },
        { type: 'quote', data: { text: '<i>hi</i>', citation: 'Jane &amp; Co' } },
      ]),
    );
    const document = okDocument(result);
    const list = document.blocks[0];
    assert.deepEqual(list?.type === 'list' ? list.items : undefined, ['one', 'two < three']);
    const quote = document.blocks[1];
    assert.equal(quote?.type === 'quote' ? quote.citation : undefined, 'Jane & Co');
  });

  it('preserves literal code bodies, including tags and entities', () => {
    const result = editorJsToRichText(
      output([{ type: 'code', data: { code: '<div>&amp;</div>', language: 'html' } }]),
    );
    const block = okDocument(result).blocks[0];
    assert.equal(block?.type === 'code' ? block.code : undefined, '<div>&amp;</div>');
  });
});

describe('editorJsToRichText block ids', () => {
  it('preserves a valid non-empty block id', () => {
    const result = editorJsToRichText(
      output([{ id: 'real-id', type: 'paragraph', data: { text: 'x' } }]),
    );
    const block = okDocument(result).blocks[0];
    assert.equal(block?.id, 'real-id');
  });

  it('generates block-<index> ids for missing ids', () => {
    const result = editorJsToRichText(
      output([
        { type: 'paragraph', data: { text: 'a' } },
        { type: 'paragraph', data: { text: 'b' } },
      ]),
    );
    const document = okDocument(result);
    assert.deepEqual(
      document.blocks.map((block) => block.id),
      ['block-0', 'block-1'],
    );
  });

  it('generates ids for empty-string ids at document order', () => {
    const result = editorJsToRichText(
      output([
        { id: 'kept', type: 'paragraph', data: { text: 'a' } },
        { id: '', type: 'paragraph', data: { text: 'b' } },
      ]),
    );
    const document = okDocument(result);
    assert.deepEqual(
      document.blocks.map((block) => block.id),
      ['kept', 'block-1'],
    );
  });

  it('dedupes colliding ids by suffixing', () => {
    const result = editorJsToRichText(
      output([
        { id: 'dup', type: 'paragraph', data: { text: 'a' } },
        { id: 'dup', type: 'paragraph', data: { text: 'b' } },
      ]),
    );
    const document = okDocument(result);
    assert.deepEqual(
      document.blocks.map((block) => block.id),
      ['dup', 'dup-1'],
    );
  });

  it('avoids a generated id colliding with an explicit one', () => {
    // Block 0's explicit id equals the generated id block 1 would receive.
    const result = editorJsToRichText(
      output([
        { id: 'block-1', type: 'paragraph', data: { text: 'a' } },
        { type: 'paragraph', data: { text: 'b' } },
      ]),
    );
    const document = okDocument(result);
    assert.deepEqual(
      document.blocks.map((block) => block.id),
      ['block-1', 'block-1-1'],
    );
  });
});

describe('editorJsToRichText heading levels', () => {
  it('clamps a low level to 2', () => {
    const result = editorJsToRichText(output([{ type: 'header', data: { level: 1, text: 'h' } }]));
    const block = okDocument(result).blocks[0];
    assert.equal(block?.type === 'heading' ? block.level : undefined, 2);
  });

  it('clamps a high level to 6', () => {
    const result = editorJsToRichText(output([{ type: 'header', data: { level: 9, text: 'h' } }]));
    const block = okDocument(result).blocks[0];
    assert.equal(block?.type === 'heading' ? block.level : undefined, 6);
  });

  it('rejects a non-numeric level through the schema', () => {
    const result = editorJsToRichText(
      output([{ type: 'header', data: { level: 'three', text: 'h' } }]),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'invalid_document');
  });
});

describe('editorJsToRichText failures', () => {
  it('rejects an unknown tool type with unsupported_block and never names it', () => {
    const result = editorJsToRichText(
      output([{ type: 'video', data: { url: 'https://example.com' } }]),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'unsupported_block');
      assert.doesNotMatch(result.error.message, /video/);
    }
  });

  it('rejects a block without a string type with unsupported_block', () => {
    const result = editorJsToRichText({ blocks: [{ data: {} }] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'unsupported_block');
  });

  it('rejects a payload without a blocks array', () => {
    const result = editorJsToRichText({ time: 1 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'invalid_document');
  });

  it('rejects a non-object payload', () => {
    const result = editorJsToRichText(null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'invalid_document');
  });

  it('rejects an empty image mediaId through the schema', () => {
    const result = editorJsToRichText(output([{ type: 'image', data: { mediaId: '' } }]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'invalid_document');
  });

  it('rejects a malformed embed url through the schema', () => {
    const result = editorJsToRichText(output([{ type: 'embed', data: { url: 'not-a-url' } }]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'invalid_document');
  });

  it('rejects an empty cta label through the schema', () => {
    const result = editorJsToRichText(output([{ type: 'cta', data: { label: '', href: '/go' } }]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'invalid_document');
  });

  it('rejects an unknown list style through the schema', () => {
    const result = editorJsToRichText(
      output([{ type: 'list', data: { style: 'roman', items: ['a'] } }]),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'invalid_document');
  });

  it('rejects an unknown callout tone through the schema', () => {
    const result = editorJsToRichText(
      output([{ type: 'callout', data: { tone: 'info', text: 'keep' } }]),
    );
    assert.equal(result.ok, true);
    const invalid = editorJsToRichText(
      output([{ type: 'callout', data: { tone: 'error', text: 'x' } }]),
    );
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.code, 'invalid_document');
  });
});

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
