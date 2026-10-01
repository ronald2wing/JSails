import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { markdownToRichText } from '@jsails/blog';
import { richTextSchema, type RichTextDocument } from 'jsails/rich-text';

function convert(source: string): RichTextDocument {
  const doc = markdownToRichText(source);
  // Every result must survive schema validation (the importer already enforced
  // it; this re-check pins the invariant at the test surface too).
  assert.equal(richTextSchema.safeParse(doc).success, true);
  return doc;
}

describe('markdownToRichText', () => {
  describe('supported constructs', () => {
    it('converts paragraphs to paragraph blocks', () => {
      const doc = convert('First paragraph.\n\nSecond paragraph.');
      assert.deepEqual(doc.blocks, [
        { id: 'block-0', type: 'paragraph', text: 'First paragraph.' },
        { id: 'block-1', type: 'paragraph', text: 'Second paragraph.' },
      ]);
    });

    it('converts h2-h6 headings at their level', () => {
      const doc = convert('## Two\n\n### Three\n\n###### Six');
      assert.deepEqual(doc.blocks, [
        { id: 'block-0', type: 'heading', level: 2, text: 'Two' },
        { id: 'block-1', type: 'heading', level: 3, text: 'Three' },
        { id: 'block-2', type: 'heading', level: 6, text: 'Six' },
      ]);
    });

    it('converts unordered and ordered lists', () => {
      const doc = convert('* a\n* b\n\n1. one\n2. two');
      assert.deepEqual(doc.blocks, [
        { id: 'block-0', type: 'list', style: 'unordered', items: ['a', 'b'] },
        { id: 'block-1', type: 'list', style: 'ordered', items: ['one', 'two'] },
      ]);
    });

    it('converts blockquotes to quote blocks', () => {
      const doc = convert('> quoted text');
      assert.deepEqual(doc.blocks, [{ id: 'block-0', type: 'quote', text: 'quoted text' }]);
    });

    it('converts fenced code, preserving the body literally and the language', () => {
      const doc = convert('```ts\nconst x = 1 < 2;\n```');
      assert.deepEqual(doc.blocks, [
        { id: 'block-0', type: 'code', code: 'const x = 1 < 2;\n', language: 'ts' },
      ]);
    });

    it('converts indented code with no language', () => {
      const doc = convert('    indented\n    code');
      assert.deepEqual(doc.blocks, [{ id: 'block-0', type: 'code', code: 'indented\ncode\n' }]);
    });

    it('converts horizontal rules to dividers', () => {
      const doc = convert('before\n\n---\n\nafter');
      assert.deepEqual(doc.blocks, [
        { id: 'block-0', type: 'paragraph', text: 'before' },
        { id: 'block-1', type: 'divider' },
        { id: 'block-2', type: 'paragraph', text: 'after' },
      ]);
    });

    it('flattens nested inline formatting to plain text', () => {
      const doc = convert('**bold** and *em* and ~~strike~~ and `code` and [link](https://x)');
      assert.deepEqual(doc.blocks, [
        { id: 'block-0', type: 'paragraph', text: 'bold and em and strike and code and link' },
      ]);
    });
  });

  describe('h1 policy', () => {
    it('rejects an h1 heading', () => {
      assert.throws(
        () => markdownToRichText('# Title\n\nbody'),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          return 'code' in error && error.code === 'unsupported_construct';
        },
      );
    });
  });

  describe('images', () => {
    it('imports a media reference image with alt text', () => {
      const doc = convert('![A cat](media:cat-1)');
      assert.deepEqual(doc.blocks, [
        { id: 'block-0', type: 'image', mediaId: 'cat-1', alt: 'A cat' },
      ]);
    });

    it('imports a media reference image without alt text', () => {
      const doc = convert('![](media:cat-2)');
      assert.deepEqual(doc.blocks, [{ id: 'block-0', type: 'image', mediaId: 'cat-2' }]);
    });

    it('rejects a normal URL image instead of inventing a media id', () => {
      assert.throws(
        () => markdownToRichText('![alt](https://example.com/cat.png)'),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          return 'code' in error && error.code === 'unsupported_construct';
        },
      );
    });
  });

  describe('rejected constructs', () => {
    it('rejects a table', () => {
      assert.throws(
        () => markdownToRichText('| a | b |\n|---|---|\n| 1 | 2 |'),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          return 'code' in error && error.code === 'unsupported_construct';
        },
      );
    });

    it('rejects a raw HTML block', () => {
      assert.throws(
        () => markdownToRichText('<div>\nraw\n</div>'),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          return 'code' in error && error.code === 'unsupported_construct';
        },
      );
    });

    it('rejects inline raw HTML', () => {
      assert.throws(
        () => markdownToRichText('text <b>bold</b>'),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          return 'code' in error && error.code === 'unsupported_construct';
        },
      );
    });
  });

  describe('schema validity and ids', () => {
    it('assigns stable positional block ids across a mixed document', () => {
      const doc = convert(
        '## head\n\npara\n\n- a\n- b\n\n```ts\nx();\n```\n\n> q\n\n---\n\n![alt](media:1)',
      );
      assert.deepEqual(
        doc.blocks.map((block) => block.id),
        ['block-0', 'block-1', 'block-2', 'block-3', 'block-4', 'block-5', 'block-6'],
      );
    });

    it('produces a document at the current version', () => {
      assert.equal(convert('body').version, 1);
    });
  });
});
