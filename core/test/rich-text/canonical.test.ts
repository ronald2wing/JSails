/**
 * Tests for the canonical form: each normalisation rule, and the properties
 * over seeded documents that normalisation is idempotent, that
 * `parseRichText` reads back exactly what it produces, and that it refuses
 * every document that is not already canonical.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeRichText,
  parseRichText,
  type RichTextBlock,
  type RichTextDocument,
} from '../../src/rich-text/index.js';
import { jsonEqual } from '../../src/rich-text/canonical.js';
import { FIXED_SEEDS, forEachSeed, generateRichTextDocument } from '../../src/testing/index.js';

/** Documents per seed, so the fixed seeds plus the fresh one cover 10 000. */
const PER_SEED = Math.ceil(10_000 / (FIXED_SEEDS.length + 1));

function doc(...blocks: readonly unknown[]): RichTextDocument {
  return { version: 2, blocks: blocks as RichTextBlock[] };
}

describe('normalizeRichText', () => {
  it('drops empty runs and merges adjacent runs with equal marks and href', () => {
    const input = doc({
      type: 'paragraph',
      content: [
        { text: 'a', marks: ['bold'] },
        { text: '' },
        { text: 'b', marks: ['bold', 'bold'] },
        { text: 'c', marks: ['bold'], href: '/x' },
        { text: 'd', marks: ['bold'], href: '/x' },
        { text: 'e', href: '/y' },
      ],
    });
    assert.deepEqual(normalizeRichText(input).blocks[0], {
      type: 'paragraph',
      content: [
        { text: 'ab', marks: ['bold'] },
        { text: 'cd', marks: ['bold'], href: '/x' },
        { text: 'e', href: '/y' },
      ],
    });
  });

  it('sorts marks, drops an empty marks list, and lets code exclude the others', () => {
    const input = doc({
      type: 'paragraph',
      content: [
        { text: 'a', marks: ['strike', 'bold', 'italic'] },
        { text: 'b', marks: [] },
        { text: 'c', marks: ['bold', 'code'] },
      ],
    });
    assert.deepEqual(normalizeRichText(input).blocks[0], {
      type: 'paragraph',
      content: [
        { text: 'a', marks: ['bold', 'italic', 'strike'] },
        { text: 'b' },
        { text: 'c', marks: ['code'] },
      ],
    });
  });

  it('removes empty optionals and empty children', () => {
    const input = doc(
      { type: 'quote', content: [], citation: '' },
      { type: 'code', code: 'x', language: '' },
      { type: 'image', mediaId: 'm', alt: '', caption: '' },
      { type: 'list', style: 'ordered', items: [{ content: [], children: [] }] },
    );
    assert.deepEqual(normalizeRichText(input).blocks, [
      { type: 'quote', content: [] },
      { type: 'code', code: 'x' },
      { type: 'image', mediaId: 'm' },
      { type: 'list', style: 'ordered', items: [{ content: [] }] },
    ]);
  });

  it('gives task items checked and takes it from the other styles', () => {
    const input = doc(
      { type: 'list', style: 'task', items: [{ content: [], children: [{ content: [] }] }] },
      { type: 'list', style: 'unordered', items: [{ content: [], checked: true }] },
    );
    assert.deepEqual(normalizeRichText(input).blocks, [
      {
        type: 'list',
        style: 'task',
        items: [{ content: [], checked: false, children: [{ content: [], checked: false }] }],
      },
      { type: 'list', style: 'unordered', items: [{ content: [] }] },
    ]);
  });

  it('drops lists without items and galleries without media', () => {
    const input = doc(
      { type: 'list', style: 'ordered', items: [] },
      { type: 'gallery', mediaIds: [] },
      { type: 'divider' },
    );
    assert.deepEqual(normalizeRichText(input).blocks, [{ type: 'divider' }]);
  });

  it('does not share arrays with its input', () => {
    const input = doc({ type: 'gallery', mediaIds: ['m'] });
    const output = normalizeRichText(input);
    assert.notEqual(
      (output.blocks[0] as { mediaIds: unknown }).mediaIds,
      (input.blocks[0] as { mediaIds: unknown }).mediaIds,
    );
  });
});

describe('jsonEqual', () => {
  it('ignores key order and undefined-valued keys', () => {
    assert.equal(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true);
    assert.equal(jsonEqual({ a: 1, b: undefined }, { a: 1 }), true);
    assert.equal(jsonEqual({ a: 1 }, { a: 2 }), false);
    assert.equal(jsonEqual([1], { 0: 1 }), false);
  });
});

describe('parseRichText reads only canonical documents', () => {
  it('refuses a non-canonical block and names it', () => {
    const result = parseRichText(
      doc({ type: 'divider' }, { type: 'paragraph', content: [{ text: 'a' }, { text: 'b' }] }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.issues, [
        {
          path: ['blocks', 1],
          code: 'not_canonical',
          message: 'block is not in canonical form; normalize before storing',
        },
      ]);
    }
  });

  it('accepts a canonical document whatever its key order (jsonb reorders keys)', () => {
    const stored = JSON.parse(
      '{"blocks":[{"content":[{"marks":["bold"],"text":"a","href":"/x"}],"type":"paragraph"}],"version":2}',
    ) as unknown;
    assert.equal(parseRichText(stored).ok, true);
  });
});

describe('properties over seeded documents', () => {
  it('normalize is idempotent and parseRichText(normalize(d)) equals normalize(d)', async (t) => {
    await forEachSeed(t, (random) => {
      for (let index = 0; index < PER_SEED; index += 1) {
        const document = generateRichTextDocument(random);
        const normalized = normalizeRichText(document);
        assert.deepEqual(normalizeRichText(normalized), normalized, 'normalize is not idempotent');
        const parsed = parseRichText(normalized);
        assert.ok(parsed.ok, `normalized document refused: ${JSON.stringify(parsed)}`);
        assert.deepEqual(parsed.value, normalized);
      }
    });
  });

  it('parseRichText refuses every document normalisation changes', async (t) => {
    await forEachSeed(t, (random) => {
      for (let index = 0; index < PER_SEED; index += 1) {
        const document = generateRichTextDocument(random);
        const canonical = jsonEqual(normalizeRichText(document), document);
        const parsed = parseRichText(document);
        assert.equal(parsed.ok, canonical, 'a non-canonical document was read');
        if (!parsed.ok) {
          assert.deepEqual(
            parsed.issues.map((issue) => issue.code),
            ['not_canonical'],
          );
        }
      }
    });
  });
});
