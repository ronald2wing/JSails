/**
 * The editor's own styles: the headless mount adopts the CSS ProseMirror
 * requires (spaces are kept on screen as in the document), the editor with
 * its UI adds the layout sheet at zero specificity, each document adopts
 * each sheet once, and a document that cannot adopt sheets is left alone.
 */

import { attachedElement, closeEditorDom, editorWindow } from './editor-dom.js';

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import type { RichTextDocument } from 'jsails/rich-text';

import { mountRichTextEditor } from '../../src/index.js';
import {
  EDITOR_UI_CSS,
  PROSEMIRROR_CSS,
  adoptEditorStyles,
} from '../../src/prosemirror/editor-styles.js';
import { mountHeadlessRichTextEditor } from '../../src/prosemirror/mount.js';

after(closeEditorDom);

const SPACED: RichTextDocument = {
  version: 2,
  blocks: [{ type: 'paragraph', content: [{ text: 'a  b' }] }],
};

function adoptedTexts(): string[] {
  return Array.from(editorWindow.document.adoptedStyleSheets, (sheet) =>
    Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n'),
  );
}

describe('editor styles', () => {
  it('keep runs of spaces on screen under the headless mount, adopted once per document', () => {
    const first = mountHeadlessRichTextEditor({ element: attachedElement(), document: SPACED });
    const second = mountHeadlessRichTextEditor({ element: attachedElement(), document: SPACED });
    assert.equal(editorWindow.getComputedStyle(first.view.dom as never).whiteSpace, 'break-spaces');
    const sheets = adoptedTexts();
    assert.equal(sheets.length, 1, 'one sheet for two editors');
    assert.match(sheets[0] ?? '', /\.ProseMirror-selectednode/);
    first.destroy();
    second.destroy();
  });

  it('add the UI layout at zero specificity, after the ProseMirror rules', () => {
    const element = attachedElement();
    const editor = mountRichTextEditor({ element, document: SPACED });
    const sheets = editorWindow.document.adoptedStyleSheets;
    assert.equal(sheets.length, 2);
    const selectors = Array.from(sheets[1]?.cssRules ?? [], (rule) => {
      assert.ok('selectorText' in rule, 'a style rule');
      return String(rule.selectorText);
    });
    assert.equal(selectors.length, EDITOR_UI_CSS.match(/\{/g)?.length);
    for (const selector of selectors) {
      for (const complex of selector.split(/,(?![^(]*\))/)) {
        assert.match(complex.trim(), /^(:where\([^)]*\)\s*)+$/, `zero specificity: ${complex}`);
      }
    }
    const toolbar = element.querySelector('.rich-text-editor-toolbar') as Element;
    assert.equal(editorWindow.getComputedStyle(toolbar as never).display, 'flex');
    editor.destroy();
  });

  it('leave a document that cannot adopt sheets as it is', () => {
    const windowless = { defaultView: null } as unknown as Document;
    adoptEditorStyles(windowless, PROSEMIRROR_CSS);
    const legacy = { defaultView: {} } as unknown as Document;
    adoptEditorStyles(legacy, PROSEMIRROR_CSS);
    assert.deepEqual(Object.keys(windowless), ['defaultView']);
    assert.deepEqual(Object.keys(legacy), ['defaultView']);
  });
});
