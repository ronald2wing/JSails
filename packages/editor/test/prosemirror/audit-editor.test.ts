/**
 * Audit regressions for the editor (CNT-01), stated against the ProseMirror
 * editor: plain-text block fields keep their angle brackets, character references in pasted text decode to their characters
 * (or stay literal), and bold, italic and links made in the editor survive
 * `getDocument()`.
 */

import { attachedElement, closeEditorDom } from './editor-dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { TextSelection } from 'prosemirror-state';

import type { RichTextDocument } from 'jsails/rich-text';
import { auditCase } from 'jsails/testing';

import { mountRichTextEditor } from '../../src/index.js';
import { setLinkCommand, toggleMarkCommand } from '../../src/prosemirror/ui/commands.js';

after(closeEditorDom);

test(
  ...auditCase(
    'editor/plain-text-fields-stripped',
    'plain-text tool fields survive a round trip with their angle brackets',
  ),
  () => {
    const document: RichTextDocument = {
      version: 2,
      blocks: [
        { type: 'callout', tone: 'info', content: [{ text: 'if a < b then c > d' }] },
        { type: 'image', mediaId: 'm1', alt: 'Use <Enter> to submit' },
        { type: 'cta', label: 'Save <draft>', href: '/save' as never },
      ],
    };
    const editor = mountRichTextEditor({ element: attachedElement(), document });
    assert.deepEqual(editor.getDocument(), document, 'plain text was run through tag stripping');
    editor.destroy();
  },
);

test(
  ...auditCase(
    'editor/entity-without-semicolon',
    'a numeric character reference without its semicolon decodes to its character',
  ),
  () => {
    const editor = mountRichTextEditor({
      element: attachedElement(),
      document: { version: 2, blocks: [] },
    });
    editor.view.pasteHTML('<p>A=&#65 and B=&#x42</p>');
    assert.deepEqual(
      editor.getDocument().blocks,
      [{ type: 'paragraph', content: [{ text: 'A=A and B=B' }] }],
      'the reference decoded to a control character',
    );
    editor.destroy();
  },
);

test(
  ...auditCase(
    'editor/inline-marks-lost',
    'bold, italic and links made with the inline toolbar survive saving',
  ),
  () => {
    const editor = mountRichTextEditor({
      element: attachedElement(),
      document: {
        version: 2,
        blocks: [{ type: 'paragraph', content: [{ text: 'bold italic link' }] }],
      },
    });
    const { view } = editor;
    const select = (from: number, to: number): void => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    };
    select(1, 5);
    toggleMarkCommand('bold')(view.state, view.dispatch);
    select(6, 12);
    toggleMarkCommand('italic')(view.state, view.dispatch);
    select(13, 17);
    setLinkCommand('https://example.com')(view.state, view.dispatch);
    assert.deepEqual(editor.getDocument().blocks, [
      {
        type: 'paragraph',
        content: [
          { text: 'bold', marks: ['bold'] },
          { text: ' ' },
          { text: 'italic', marks: ['italic'] },
          { text: ' ' },
          { text: 'link', href: 'https://example.com' },
        ],
      },
    ]);
    editor.destroy();
  },
);
