/**
 * Checked state stays with task lists: an item of a list that stops being a
 * task list loses its state (undo brings it back with the style), items that
 * join a list of another style take that list's rule, and neither pasted HTML
 * nor an attribute step can plant a checked state in a bulleted list.
 */

import { attachedElement, closeEditorDom } from './editor-dom.js';

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { joinBackward } from 'prosemirror-commands';
import { undo } from 'prosemirror-history';
import { TextSelection, type EditorState } from 'prosemirror-state';

import type { ListStyle, RichTextDocument } from 'jsails/rich-text';

import { decode } from '../../src/prosemirror/codec.js';
import {
  createRichTextEditorState,
  mountHeadlessRichTextEditor,
} from '../../src/prosemirror/mount.js';

after(closeEditorDom);

const TASKS: RichTextDocument = {
  version: 2,
  blocks: [
    {
      type: 'list',
      style: 'task',
      items: [
        {
          content: [{ text: 'a' }],
          checked: true,
          children: [{ content: [{ text: 'b' }], checked: true }],
        },
        { content: [{ text: 'c' }], checked: false },
      ],
    },
  ],
};

/** Every `checked` attribute in the state, in document order. */
function checkedStates(state: EditorState): boolean[] {
  const out: boolean[] = [];
  state.doc.descendants((node) => {
    if (typeof node.attrs.checked === 'boolean') {
      out.push(node.attrs.checked);
    }
  });
  return out;
}

function restyle(state: EditorState, style: ListStyle): EditorState {
  return state.apply(state.tr.setNodeMarkup(0, undefined, { style }));
}

describe('richTextTaskItems', () => {
  it('clears the state of items whose list stops being a task list', () => {
    let state = restyle(createRichTextEditorState(TASKS), 'unordered');
    assert.deepEqual(checkedStates(state), [false, false, false]);
    assert.deepEqual(decode(state.doc).blocks, [
      {
        type: 'list',
        style: 'unordered',
        items: [
          { content: [{ text: 'a' }], children: [{ content: [{ text: 'b' }] }] },
          { content: [{ text: 'c' }] },
        ],
      },
    ]);
    assert.deepEqual(
      decode(restyle(state, 'task').doc).blocks,
      [
        {
          type: 'list',
          style: 'task',
          items: [
            {
              content: [{ text: 'a' }],
              checked: false,
              children: [{ content: [{ text: 'b' }], checked: false }],
            },
            { content: [{ text: 'c' }], checked: false },
          ],
        },
      ],
      'a state the saved document never held does not come back',
    );
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    assert.deepEqual(decode(state.doc), TASKS, 'undo restores the style and the state together');
  });

  it('clears the state of task items joined into a list of another style', () => {
    const state = createRichTextEditorState({
      version: 2,
      blocks: [
        { type: 'list', style: 'ordered', items: [{ content: [{ text: 'o' }] }] },
        { type: 'list', style: 'task', items: [{ content: [{ text: 't' }], checked: true }] },
      ],
    });
    // The start of the task item's paragraph: Backspace there joins the two lists.
    const pos = state.doc.child(0).nodeSize + 3;
    let joined = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    assert.ok(
      joinBackward(joined, (tr) => {
        joined = joined.apply(tr);
      }),
    );
    assert.equal(joined.doc.childCount, 1);
    assert.deepEqual(checkedStates(joined), [false, false]);
  });

  it('keeps pasted HTML from planting a checked state in a bulleted list', () => {
    const element = attachedElement();
    const editor = mountHeadlessRichTextEditor({
      element,
      document: { version: 2, blocks: [{ type: 'paragraph', content: [] }] },
    });
    const view = editor.view;
    assert.ok(
      view.pasteHTML('<ul><li data-checked="true">x</li><li data-checked="true">y</li></ul>'),
    );
    assert.deepEqual(checkedStates(view.state), [false, false]);
    const list = view.state.doc.firstChild;
    assert.equal(list?.type.name, 'list');
    view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { style: 'task' }));
    assert.deepEqual(editor.getDocument().blocks, [
      {
        type: 'list',
        style: 'task',
        items: [
          { content: [{ text: 'x' }], checked: false },
          { content: [{ text: 'y' }], checked: false },
        ],
      },
    ]);
    editor.destroy();
  });

  it('applies the same rule to attribute steps, whose step map is empty', () => {
    const tasks = createRichTextEditorState(TASKS);
    const bulleted = tasks.apply(tasks.tr.setNodeAttribute(0, 'style', 'unordered'));
    assert.deepEqual(checkedStates(bulleted), [false, false, false]);
    const back = bulleted.apply(bulleted.tr.setNodeAttribute(0, 'style', 'task'));
    assert.deepEqual(checkedStates(back), [false, false, false], 'no state comes back');

    // Position 1 is the first item of the list at position 0.
    const planted = bulleted.apply(bulleted.tr.setNodeAttribute(1, 'checked', true));
    assert.deepEqual(checkedStates(planted), [false, false, false]);
  });

  it('leaves the state of task lists alone', () => {
    const state = createRichTextEditorState(TASKS);
    const edited = state.apply(state.tr.insertText('z', 3));
    assert.deepEqual(checkedStates(edited), [true, true, false]);
  });
});
