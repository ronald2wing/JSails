/**
 * Audit regressions for the Editor.js conversion (CNT-01): each test states
 * the correct behaviour for one audited defect. Those that fail today are
 * listed, with the failure they show, in `scripts/expected-failures/content.json`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RichTextDocument } from 'jsails/rich-text';
import { auditCase } from 'jsails/testing';

import { editorJsToRichText, richTextToEditorJs } from '../../src/index.js';

function roundTrip(document: RichTextDocument): RichTextDocument {
  const forward = richTextToEditorJs(document);
  assert.equal(forward.ok, true, 'the document converts to Editor.js data');
  if (!forward.ok) {
    throw new Error('unreachable');
  }
  const back = editorJsToRichText(forward.output);
  assert.equal(back.ok, true, 'the Editor.js data converts back');
  if (!back.ok) {
    throw new Error('unreachable');
  }
  return back.document;
}

test(
  ...auditCase(
    'editor/plain-text-fields-stripped',
    'plain-text tool fields survive a round trip with their angle brackets',
  ),
  () => {
    const document: RichTextDocument = {
      version: 1,
      blocks: [
        { id: 'c1', type: 'callout', tone: 'info', text: 'if a < b then c > d' },
        { id: 'i1', type: 'image', mediaId: 'm1', alt: 'Use <Enter> to submit' },
        { id: 't1', type: 'cta', label: 'Save <draft>', href: '/save' },
      ],
    };
    assert.deepEqual(roundTrip(document), document, 'plain text was run through tag stripping');
  },
);

test(
  ...auditCase(
    'editor/entity-without-semicolon',
    'a numeric character reference without its semicolon decodes to its character',
  ),
  () => {
    const result = editorJsToRichText({
      blocks: [{ type: 'paragraph', data: { text: 'A=&#65 and B=&#x42' } }],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    assert.deepEqual(
      result.document.blocks[0],
      { id: result.document.blocks[0]?.id, type: 'paragraph', text: 'A=A and B=B' },
      'the reference decoded to a control character',
    );
  },
);

test(
  ...auditCase(
    'editor/inline-marks-lost',
    'bold, italic and links made with the inline toolbar survive saving',
  ),
  () => {
    const saved = editorJsToRichText({
      blocks: [
        {
          type: 'paragraph',
          data: { text: '<b>bold</b> <i>italic</i> <a href="https://example.com">link</a>' },
        },
      ],
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) {
      throw new Error('unreachable');
    }
    const reopened = richTextToEditorJs(saved.document);
    assert.equal(reopened.ok, true);
    if (!reopened.ok) {
      throw new Error('unreachable');
    }
    const text = String(reopened.output.blocks[0]?.data['text'] ?? '');
    assert.match(text, /<(b|strong)>bold<\/\1>/, 'bold was dropped on save');
    assert.match(text, /<(i|em)>italic<\/\1>/, 'italic was dropped on save');
    assert.match(text, /<a href="https:\/\/example\.com"[^>]*>link<\/a>/, 'the link was dropped');
  },
);
