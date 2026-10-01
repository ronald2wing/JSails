import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_BLOCKS,
  MAX_BLOCK_TEXT_LENGTH,
  MAX_GALLERY_ITEMS,
  createEmptyRichTextDocument,
  validateRichTextDocument,
} from 'jsails/rich-text';

/** A minimal valid paragraph block, overridable per test. */
function paragraph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'b1', type: 'paragraph', text: 'hello', ...overrides };
}

/** A document wrapping the given blocks at the current version. */
function document(blocks: readonly unknown[]): unknown {
  return { version: 1, blocks };
}

describe('createEmptyRichTextDocument', () => {
  it('returns an empty document at the current version', () => {
    assert.deepEqual(createEmptyRichTextDocument(), { version: 1, blocks: [] });
  });
});

describe('validateRichTextDocument', () => {
  it('accepts a valid document and returns the parsed value', () => {
    const result = validateRichTextDocument(document([paragraph()]));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.version, 1);
      assert.equal(result.value.blocks.length, 1);
      assert.equal(result.value.blocks[0]?.type, 'paragraph');
    }
  });

  it('accepts an empty blocks list', () => {
    const result = validateRichTextDocument(document([]));
    assert.equal(result.ok, true);
  });

  it('rejects a document with a different version', () => {
    const result = validateRichTextDocument({ version: 2, blocks: [] });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.field === 'version'));
    }
  });

  it('rejects an unknown block type', () => {
    const result = validateRichTextDocument(document([paragraph({ type: 'video' })]));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.field === 'blocks.0.type'));
    }
  });

  it('rejects an out-of-range heading level', () => {
    const result = validateRichTextDocument(
      document([{ id: 'b1', type: 'heading', level: 1, text: 'h' }]),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.field === 'blocks.0.level'));
    }
  });

  it('expands unrecognized block keys into their own field paths', () => {
    const result = validateRichTextDocument(document([paragraph({ extra: 1 })]));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const extra = result.errors.find((error) => error.field === 'blocks.0.extra');
      assert.ok(extra, 'expected an error for the unrecognized key');
      assert.equal(extra?.message, 'unrecognized field');
    }
  });

  it('rejects an over-long paragraph text', () => {
    const result = validateRichTextDocument(
      document([paragraph({ text: 'x'.repeat(MAX_BLOCK_TEXT_LENGTH + 1) })]),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.field === 'blocks.0.text'));
    }
  });

  it('rejects too many blocks', () => {
    const result = validateRichTextDocument(
      document(Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => paragraph({ id: `b${i}` }))),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.field === 'blocks'));
    }
  });

  it('rejects too many gallery items', () => {
    const result = validateRichTextDocument(
      document([
        {
          id: 'g1',
          type: 'gallery',
          mediaIds: Array.from({ length: MAX_GALLERY_ITEMS + 1 }, (_, i) => `m${i}`),
        },
      ]),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.field === 'blocks.0.mediaIds'));
    }
  });

  it('never echoes input values in error messages', () => {
    const secret = 'SHOULD-NOT-LEAK-abcdef';
    const result = validateRichTextDocument(document([paragraph({ text: secret.repeat(200) })]));
    assert.equal(result.ok, false);
    if (!result.ok) {
      for (const error of result.errors) {
        assert.ok(!error.message.includes(secret), 'error message must not echo input');
      }
    }
  });
});
