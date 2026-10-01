/**
 * Tests for `parseRichText` and `measureRichText`: the budget, value-free
 * issues, and the refusal of every planted defect from the seeded generator.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_BLOCK_CHARS,
  MAX_BLOCKS,
  MAX_DOCUMENT_BYTES,
  MAX_LIST_ITEMS,
  measureRichText,
  parseRichText,
  type RichTextBlock,
  type RichTextDocument,
} from '../../src/rich-text/index.js';
import { forEachSeed, generateRejectedRichText } from '../../src/testing/index.js';

function doc(blocks: readonly unknown[]): RichTextDocument {
  return { version: 2, blocks: blocks as RichTextBlock[] };
}

function codes(input: unknown): readonly string[] {
  const result = parseRichText(input);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

const divider = { type: 'divider' };

describe('measureRichText', () => {
  it('measures bytes, blocks, the largest block and the largest list', () => {
    const document = doc([
      { type: 'paragraph', content: [{ text: 'héllo' }, { text: '😀', marks: ['bold'] }] },
      { type: 'quote', content: [{ text: 'abc' }], citation: 'de' },
      {
        type: 'list',
        style: 'ordered',
        items: [{ content: [{ text: 'a' }], children: [{ content: [{ text: 'b' }] }] }],
      },
      { type: 'image', mediaId: 'm', alt: 'xy', caption: 'z' },
    ]);
    const measure = measureRichText(document);
    assert.equal(measure.bytes, Buffer.byteLength(JSON.stringify(document)));
    assert.equal(measure.blocks, 4);
    assert.equal(measure.maxBlockChars, 7);
    assert.equal(measure.maxListItems, 2);
    assert.equal(measure.withinBudget, true);
  });
});

describe('the budget', () => {
  it('refuses more than MAX_BLOCKS blocks', () => {
    assert.deepEqual(codes(doc(Array.from({ length: MAX_BLOCKS }, () => divider))), []);
    assert.deepEqual(codes(doc(Array.from({ length: MAX_BLOCKS + 1 }, () => divider))), [
      'too_many_blocks',
    ]);
  });

  it('refuses a block over MAX_BLOCK_CHARS, counting every run', () => {
    const half = 'a'.repeat(MAX_BLOCK_CHARS / 2);
    const fits = { type: 'paragraph', content: [{ text: half }, { text: half, marks: ['bold'] }] };
    const over = {
      type: 'paragraph',
      content: [{ text: half }, { text: `${half}b`, marks: ['bold'] }],
    };
    assert.deepEqual(codes(doc([fits])), []);
    assert.deepEqual(codes(doc([over])), ['block_too_long']);
    assert.deepEqual(codes(doc([{ type: 'code', code: 'x'.repeat(MAX_BLOCK_CHARS + 1) }])), [
      'block_too_long',
    ]);
  });

  it('refuses a list over MAX_LIST_ITEMS, nested items included', () => {
    const item = { content: [], children: [{ content: [] }] };
    const list = (count: number) => ({
      type: 'list',
      style: 'unordered',
      items: Array.from({ length: count }, () => item),
    });
    assert.deepEqual(codes(doc([list(MAX_LIST_ITEMS / 2)])), []);
    assert.deepEqual(codes(doc([list(MAX_LIST_ITEMS / 2 + 1)])), ['too_many_list_items']);
  });

  it('refuses a document over MAX_DOCUMENT_BYTES before walking the schema', () => {
    const block = { type: 'paragraph', content: [{ text: 'é'.repeat(10_000) }] };
    const count = Math.ceil(MAX_DOCUMENT_BYTES / 20_000) + 1;
    assert.deepEqual(codes(doc(Array.from({ length: count }, () => block))), ['too_large']);
    // Unknown fields are not reported: the size check comes first.
    assert.deepEqual(codes({ version: 2, blocks: [], junk: 'x'.repeat(MAX_DOCUMENT_BYTES) }), [
      'too_large',
    ]);
  });
});

describe('issues are value-free', () => {
  it('never echoes the refused text or URL', () => {
    const secret = 'javascript:alert("token-1234")';
    const result = parseRichText(
      doc([
        { type: 'cta', label: 'Go', href: secret },
        { type: 'paragraph', content: [{ text: 'token-1234\u0000' }], extra: 'token-1234' },
      ]),
    );
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /token-1234|javascript/);
  });
});

describe('seeded rejections', () => {
  it('refuses every planted defect with its issue code', async (t) => {
    await forEachSeed(t, (random) => {
      for (let index = 0; index < 1000; index += 1) {
        const { input, code } = generateRejectedRichText(random);
        const result = parseRichText(input);
        assert.equal(result.ok, false, `a document with a planted ${code} was read`);
        if (!result.ok) {
          assert.ok(
            result.issues.some((issue) => issue.code === code),
            `expected ${code}, got ${result.issues.map((issue) => issue.code).join(', ')}`,
          );
        }
      }
    });
  });
});
