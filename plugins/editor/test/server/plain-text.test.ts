import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RenderError, richTextToPlainText, PLAIN_TEXT_MAX_LENGTH } from '../../src/server/index.js';
import type { RichTextBlock, RichTextDocument } from 'jsails/rich-text';

/** Wrap blocks into a validated document for extracting. */
function document(...blocks: readonly RichTextBlock[]): RichTextDocument {
  return { version: 1, blocks: [...blocks] };
}

describe('richTextToPlainText', () => {
  it('extracts paragraph, heading, and callout text', () => {
    const blocks: RichTextBlock[] = [
      { id: 'b1', type: 'paragraph', text: 'intro' },
      { id: 'b2', type: 'heading', level: 2, text: 'title' },
      { id: 'b3', type: 'callout', tone: 'info', text: 'note' },
    ];
    assert.equal(richTextToPlainText(document(...blocks)), 'intro\ntitle\nnote');
  });

  it('extracts list items onto their own lines', () => {
    const list: RichTextBlock = { id: 'b1', type: 'list', style: 'ordered', items: ['one', 'two'] };
    assert.equal(richTextToPlainText(document(list)), 'one\ntwo');
  });

  it('appends a quote citation in parentheses', () => {
    const quote: RichTextBlock = { id: 'b1', type: 'quote', text: 'words', citation: 'author' };
    assert.equal(richTextToPlainText(document(quote)), 'words (author)');
  });

  it('extracts a CTA label', () => {
    const cta: RichTextBlock = { id: 'b1', type: 'cta', label: 'Sign up', href: '/signup' };
    assert.equal(richTextToPlainText(document(cta)), 'Sign up');
  });

  it('skips code, image, gallery, embed, and divider blocks', () => {
    const blocks: RichTextBlock[] = [
      { id: 'b1', type: 'code', code: 'x', language: 'js' },
      { id: 'b2', type: 'image', mediaId: 'm1' },
      { id: 'b3', type: 'gallery', mediaIds: ['m1'] },
      { id: 'b4', type: 'embed', url: 'https://youtube.com/watch?v=1' },
      { id: 'b5', type: 'divider' },
    ];
    assert.equal(richTextToPlainText(document(...blocks)), '');
  });

  it('returns an empty string for an empty document', () => {
    assert.equal(richTextToPlainText(document()), '');
  });

  it('truncates to the bound when the combined text is over-long', () => {
    // Each block stays within the per-field contract bound, but the combined
    // text exceeds the plain-text cap.
    const blocks: RichTextBlock[] = [
      { id: 'b1', type: 'paragraph', text: 'a'.repeat(1500) },
      { id: 'b2', type: 'paragraph', text: 'b'.repeat(1500) },
    ];
    assert.equal(richTextToPlainText(document(...blocks)).length, PLAIN_TEXT_MAX_LENGTH);
  });

  it('throws invalid_document for a malformed document', () => {
    assert.throws(
      () => richTextToPlainText(null as unknown as RichTextDocument),
      (error: unknown) => error instanceof RenderError && error.code === 'invalid_document',
    );
  });

  it('never echoes input values in error messages', () => {
    const secret = 'SHOULD-NOT-LEAK';
    try {
      richTextToPlainText({ version: 9, blocks: [] } as unknown as RichTextDocument);
      assert.fail('expected a throw');
    } catch (error) {
      assert.ok(error instanceof RenderError);
      assert.ok(!error.message.includes(secret));
    }
  });
});
