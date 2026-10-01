/**
 * The headless mount in a DOM: it mounts synchronously, `getDocument` decodes
 * the live state, `setDocument` replaces it (and the undo history), a refused
 * document or a non-element is refused with a value-free code, `destroy` is
 * idempotent, and edits made through the view (typing, input rules, the
 * keymap, pasting) reach `getDocument`.
 */

import { assertNode, attachedElement, closeEditorDom, editorWindow } from './editor-dom.js';

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closeHistory } from 'prosemirror-history';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { isJsailsError } from 'jsails/errors';
import { MAX_BLOCK_CHARS, type RichTextDocument } from 'jsails/rich-text';

import { RichTextEditorErrors } from '../../src/prosemirror/editor-errors.js';
import { mountHeadlessRichTextEditor } from '../../src/prosemirror/mount.js';

after(closeEditorDom);

const DOCUMENT: RichTextDocument = {
  version: 2,
  blocks: [
    { type: 'heading', level: 2, content: [{ text: 'Title' }] },
    {
      type: 'paragraph',
      content: [{ text: 'Hello ' }, { text: 'world', marks: ['bold'], href: '/w' as never }],
    },
  ],
};

/** Type `text` at the selection the way the view handles a keystroke. */
function type(view: EditorView, text: string): void {
  const { from, to } = view.state.selection;
  const handled = view.someProp('handleTextInput', (handler) =>
    handler(view, from, to, text, () => view.state.tr.insertText(text, from, to)),
  );
  if (handled !== true) {
    view.dispatch(view.state.tr.insertText(text, from, to));
  }
}

interface Keys {
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
}

/** Press `key` on the editor's DOM; true when the editor handled it. */
function press(view: EditorView, key: string, modifiers: Keys = {}): boolean {
  const event = new editorWindow.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  view.dom.dispatchEvent(event as unknown as Event);
  return event.defaultPrevented;
}

function cursorAtEnd(view: EditorView): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
}

describe('mountHeadlessRichTextEditor', () => {
  it('mounts synchronously and returns the document it was given', () => {
    const element = attachedElement();
    const editor = mountHeadlessRichTextEditor({ element, document: DOCUMENT });
    assert.deepEqual(editor.getDocument(), DOCUMENT);
    const dom = element.querySelector('.ProseMirror');
    assert.ok(dom !== null);
    assert.equal(dom.getAttribute('contenteditable'), 'true');
    assert.equal(dom.getAttribute('role'), 'textbox');
    assert.equal(dom.getAttribute('aria-multiline'), 'true');
    assert.equal(dom.querySelector('h2')?.textContent, 'Title');
    assert.equal(dom.querySelector('a')?.getAttribute('href'), '/w');
    editor.destroy();
  });

  it('refuses a document parseRichText refuses, with its issues and without echoing it', () => {
    const element = attachedElement();
    const document = {
      version: 2,
      blocks: [{ type: 'paragraph', content: [{ text: 'x', href: 'javascript:alert(1)' }] }],
    } as unknown as RichTextDocument;
    assert.throws(
      () => mountHeadlessRichTextEditor({ element, document }),
      (error: unknown) => {
        assert.ok(RichTextEditorErrors.is(error, 'invalid_document'));
        assert.equal(error.payload.issues[0]?.code, 'invalid_link');
        assert.ok(!JSON.stringify(error.payload).includes('javascript'));
        assert.ok(!error.message.includes('javascript'));
        return true;
      },
    );
    assert.equal(element.childNodes.length, 0, 'nothing was mounted');
  });

  it('refuses a non-canonical document instead of repairing it', () => {
    const document = {
      version: 2,
      blocks: [{ type: 'paragraph', content: [{ text: 'a' }, { text: 'b' }] }],
    } as RichTextDocument;
    assert.throws(
      () => mountHeadlessRichTextEditor({ element: attachedElement(), document }),
      (error: unknown) =>
        RichTextEditorErrors.is(error, 'invalid_document') &&
        error.payload.issues[0]?.code === 'not_canonical',
    );
  });

  it('refuses a mount target that is not an element', () => {
    for (const element of [null, {}, { nodeType: 1 }, 'div']) {
      assert.throws(
        () =>
          mountHeadlessRichTextEditor({
            element: element as unknown as HTMLElement,
            document: DOCUMENT,
          }),
        (error: unknown) => RichTextEditorErrors.is(error, 'invalid_element'),
      );
    }
  });

  it('decodes edits made through the view', () => {
    const element = attachedElement();
    const editor = mountHeadlessRichTextEditor({ element, document: DOCUMENT });
    const view = editor.view;
    cursorAtEnd(view);
    type(view, '!');
    assert.deepEqual(editor.getDocument().blocks[1], {
      type: 'paragraph',
      content: [
        { text: 'Hello ' },
        { text: 'world', marks: ['bold'], href: '/w' },
        // The link mark is not inclusive, so typed text after a link is not linked.
        { text: '!', marks: ['bold'] },
      ],
    });
    editor.destroy();
  });

  it('runs the input rules and the keymap', () => {
    const element = attachedElement();
    const editor = mountHeadlessRichTextEditor({
      element,
      document: { version: 2, blocks: [{ type: 'paragraph', content: [] }] },
    });
    const view = editor.view;
    for (const character of '- ') {
      type(view, character);
    }
    type(view, 'one');
    assert.ok(press(view, 'Enter'));
    type(view, 'two');
    // Close the undo group, so undo takes back the nesting alone.
    view.dispatch(closeHistory(view.state.tr));
    assert.ok(press(view, ']', { ctrlKey: true }));
    assert.deepEqual(editor.getDocument().blocks, [
      {
        type: 'list',
        style: 'unordered',
        items: [{ content: [{ text: 'one' }], children: [{ content: [{ text: 'two' }] }] }],
      },
    ]);
    assert.ok(press(view, 'z', { ctrlKey: true }));
    assert.deepEqual(editor.getDocument().blocks, [
      {
        type: 'list',
        style: 'unordered',
        items: [{ content: [{ text: 'one' }] }, { content: [{ text: 'two' }] }],
      },
    ]);
    editor.destroy();
  });

  it('keeps the words apart when a heading input rule or a paste meets a line break', () => {
    const element = attachedElement();
    const editor = mountHeadlessRichTextEditor({
      element,
      document: {
        version: 2,
        blocks: [{ type: 'paragraph', content: [{ text: 'Line one\nLine two' }] }],
      },
    });
    const view = editor.view;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    for (const character of '## ') {
      type(view, character);
    }
    assert.deepEqual(editor.getDocument().blocks, [
      { type: 'heading', level: 2, content: [{ text: 'Line one Line two' }] },
    ]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)));
    assert.ok(view.pasteHTML('<span>a<br><b>b</b></span>'));
    assert.deepEqual(editor.getDocument().blocks, [
      {
        type: 'heading',
        level: 2,
        content: [{ text: 'Linea ' }, { text: 'b', marks: ['bold'] }, { text: ' one Line two' }],
      },
    ]);
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    assert.ok(view.pasteHTML('<p>c<br>d</p><p>e<br>f</p>'));
    assert.deepEqual(editor.getDocument().blocks, [
      {
        type: 'heading',
        level: 2,
        content: [{ text: 'Linea ' }, { text: 'b', marks: ['bold'] }, { text: ' one Line twoc d' }],
      },
      // The text that lands outside the heading keeps its break.
      { type: 'paragraph', content: [{ text: 'e\nf' }] },
    ]);
    editor.destroy();
  });

  it('inserts a line break with Shift-Enter and toggles marks', () => {
    const element = attachedElement();
    const editor = mountHeadlessRichTextEditor({
      element,
      document: { version: 2, blocks: [{ type: 'paragraph', content: [{ text: 'ab' }] }] },
    });
    const view = editor.view;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    assert.ok(press(view, 'Enter', { shiftKey: true }));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 2)));
    assert.ok(press(view, 'b', { ctrlKey: true }));
    assert.deepEqual(editor.getDocument().blocks, [
      { type: 'paragraph', content: [{ text: 'a', marks: ['bold'] }, { text: '\nb' }] },
    ]);
    editor.destroy();
  });

  it('replaces the document and the undo history with setDocument', () => {
    const element = attachedElement();
    const editor = mountHeadlessRichTextEditor({ element, document: DOCUMENT });
    const view = editor.view;
    cursorAtEnd(view);
    type(view, 'x');
    const next: RichTextDocument = { version: 2, blocks: [{ type: 'divider' }] };
    editor.setDocument(next);
    assert.deepEqual(editor.getDocument(), next);
    assert.equal(press(view, 'z', { ctrlKey: true }), false, 'nothing to undo');
    assert.deepEqual(editor.getDocument(), next);
    assert.throws(
      () => editor.setDocument({ version: 1, blocks: [] } as unknown as RichTextDocument),
      (error: unknown) => RichTextEditorErrors.is(error, 'invalid_document'),
    );
    editor.destroy();
  });

  it('refuses an edit that would pass the budget and reports it', () => {
    const element = attachedElement();
    const refused: number[] = [];
    const editor = mountHeadlessRichTextEditor({
      element,
      document: { version: 2, blocks: [{ type: 'paragraph', content: [] }] },
      onBudgetExceeded: (measure) => refused.push(measure.maxBlockChars),
    });
    const view = editor.view;
    type(view, 'a'.repeat(MAX_BLOCK_CHARS));
    type(view, 'b');
    assert.equal(editor.getDocument().blocks[0]?.type, 'paragraph');
    assert.deepEqual(editor.getDocument().blocks, [
      { type: 'paragraph', content: [{ text: 'a'.repeat(MAX_BLOCK_CHARS) }] },
    ]);
    assert.deepEqual(refused, [MAX_BLOCK_CHARS + 1]);
    editor.destroy();
  });

  it('destroys idempotently and refuses setDocument afterwards', () => {
    const element = attachedElement();
    const editor = mountHeadlessRichTextEditor({ element, document: DOCUMENT });
    editor.destroy();
    editor.destroy();
    assertNode(element.querySelector('.ProseMirror'), null);
    assert.deepEqual(editor.getDocument(), DOCUMENT);
    assert.throws(
      () => editor.setDocument(DOCUMENT),
      (error: unknown) =>
        isJsailsError(error) && RichTextEditorErrors.is(error, 'editor_destroyed'),
    );
  });
});
