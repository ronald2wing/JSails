/**
 * Tests for `richTextToPlainText`: the exact projection of every block kind
 * and, over seeded documents, that every run's text appears in order.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeRichText,
  richTextToPlainText,
  type InlineContent,
  type ListItem,
  type RichTextBlock,
  type RichTextDocument,
} from '../../src/rich-text/index.js';
import { forEachSeed, generateRichTextDocument } from '../../src/testing/index.js';

function doc(blocks: readonly unknown[]): RichTextDocument {
  return { version: 2, blocks: blocks as RichTextBlock[] };
}

describe('richTextToPlainText', () => {
  it('projects every block kind exactly', () => {
    const document = doc([
      { type: 'heading', level: 2, content: [{ text: 'Ti' }, { text: 'tle', marks: ['bold'] }] },
      { type: 'paragraph', content: [{ text: 'line one\nline two', href: '/x' }] },
      { type: 'quote', content: [{ text: 'Said.' }], citation: 'Ada' },
      { type: 'callout', tone: 'info', content: [{ text: 'Note <b>' }] },
      { type: 'code', code: 'a < b;\n\tc', language: 'ts' },
      {
        type: 'list',
        style: 'task',
        items: [
          {
            content: [{ text: 'one' }],
            checked: true,
            children: [{ content: [{ text: 'two' }], checked: false }],
          },
          { content: [{ text: 'three' }], checked: false },
        ],
      },
      { type: 'image', mediaId: 'm', alt: 'Alt', caption: 'Caption' },
      { type: 'gallery', mediaIds: ['m'], alt: 'Gallery alt' },
      { type: 'embed', url: 'https://example.com/frame' },
      { type: 'cta', label: 'Sign up', href: '/signup' },
      { type: 'divider' },
      { type: 'paragraph', content: [] },
    ]);
    assert.equal(
      richTextToPlainText(document),
      [
        'Title',
        'line one\nline two',
        'Said.',
        'Ada',
        'Note <b>',
        'a < b;\n\tc',
        'one',
        'two',
        'three',
        'Alt',
        'Caption',
        'Gallery alt',
        'Sign up',
      ].join('\n'),
    );
  });

  it('returns an empty string for an empty document', () => {
    assert.equal(richTextToPlainText(doc([])), '');
  });

  it('does not truncate', () => {
    const text = 'x'.repeat(19_000);
    assert.equal(richTextToPlainText(doc([{ type: 'paragraph', content: [{ text }] }])), text);
  });
});

function runTexts(document: RichTextDocument): string[] {
  const out: string[] = [];
  const inline = (content: InlineContent) => {
    for (const run of content) out.push(run.text);
  };
  const items = (list: readonly ListItem[]) => {
    for (const item of list) {
      inline(item.content);
      if (item.children !== undefined) items(item.children);
    }
  };
  for (const block of document.blocks) {
    if ('content' in block) inline(block.content);
    if (block.type === 'list') items(block.items);
  }
  return out;
}

describe('plain-text property', () => {
  it('every run text appears, in order', async (t) => {
    await forEachSeed(t, (random) => {
      for (let index = 0; index < 1000; index += 1) {
        const document = normalizeRichText(generateRichTextDocument(random));
        const plain = richTextToPlainText(document);
        let from = 0;
        for (const text of runTexts(document)) {
          const at = plain.indexOf(text, from);
          assert.notEqual(at, -1, 'a run text is missing or out of order');
          from = at + text.length;
        }
      }
    });
  });
});
