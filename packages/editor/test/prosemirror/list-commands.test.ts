/**
 * The list commands over the per-depth list nodes: split, sink and lift keep
 * the state valid, rebuild moved items at their new depth, keep the cursor in
 * the moved text, keep task checks, and refuse what the model cannot hold
 * (a first item cannot sink, nothing sinks past the third level).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TextSelection, type Command, type EditorState } from 'prosemirror-state';

import type { ListItem, ListStyle, RichTextDocument } from 'jsails/rich-text';

import { decode } from '../../src/prosemirror/codec.js';
import {
  liftRichTextListItem,
  sinkRichTextListItem,
  splitRichTextListItem,
} from '../../src/prosemirror/list-commands.js';
import { createRichTextEditorState } from '../../src/prosemirror/mount.js';

function list(style: ListStyle, items: readonly ListItem[]): RichTextDocument {
  return { version: 2, blocks: [{ type: 'list', style, items }] };
}

const item = (text: string, children?: readonly ListItem[]): ListItem => ({
  content: text === '' ? [] : [{ text }],
  ...(children === undefined ? {} : { children }),
});

const task = (text: string, checked: boolean, children?: readonly ListItem[]): ListItem => ({
  ...item(text, children),
  checked,
});

/** The state with the cursor `offset` characters into the item text that reads `text`. */
function cursorIn(document: RichTextDocument, text: string, offset = 0): EditorState {
  const state = createRichTextEditorState(document);
  let found: number | undefined;
  state.doc.descendants((node, pos) => {
    if (found === undefined && node.type.name === 'paragraph' && node.textContent === text) {
      found = pos + 1 + offset;
    }
  });
  assert.ok(found !== undefined, `no paragraph reads ${JSON.stringify(text)}`);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, found)));
}

/** Run `command`; return the new state, or `undefined` when it refused. */
function run(state: EditorState, command: Command): EditorState | undefined {
  let next: EditorState | undefined;
  const handled = command(state, (tr) => {
    next = state.apply(tr);
  });
  assert.equal(handled, next !== undefined);
  next?.doc.check();
  return next;
}

/** The text of the paragraph holding the cursor and the cursor's offset in it. */
function cursor(state: EditorState): [string, number] {
  const { $from } = state.selection;
  return [$from.parent.textContent, $from.parentOffset];
}

describe('list commands', () => {
  it('split an item at the cursor, the new item unchecked', () => {
    const state = cursorIn(list('task', [task('abcd', true)]), 'abcd', 2);
    const next = run(state, splitRichTextListItem);
    assert.ok(next !== undefined);
    assert.deepEqual(decode(next.doc), list('task', [task('ab', true), task('cd', true)]));
    const atEnd = run(
      cursorIn(list('task', [task('abcd', true)]), 'abcd', 4),
      splitRichTextListItem,
    );
    assert.ok(atEnd !== undefined);
    assert.deepEqual(decode(atEnd.doc), list('task', [task('abcd', true), task('', false)]));
    assert.deepEqual(cursor(atEnd), ['', 0]);
  });

  it('move an empty nested item out a level on split', () => {
    const state = cursorIn(list('unordered', [item('a', [item('b'), item('')])]), '');
    const next = run(state, splitRichTextListItem);
    assert.ok(next !== undefined);
    assert.deepEqual(decode(next.doc), list('unordered', [item('a', [item('b')]), item('')]));
  });

  it('sink an item under its previous sibling, with its children, keeping the cursor', () => {
    const document = list('task', [
      task('a', false, [task('a1', true)]),
      task('b', true, [task('b1', false)]),
      task('c', false),
    ]);
    const next = run(cursorIn(document, 'b', 1), sinkRichTextListItem);
    assert.ok(next !== undefined);
    assert.deepEqual(
      decode(next.doc),
      list('task', [
        task('a', false, [task('a1', true), task('b', true, [task('b1', false)])]),
        task('c', false),
      ]),
    );
    assert.deepEqual(cursor(next), ['b', 1]);
  });

  it('refuse to sink a first item or past the third level', () => {
    assert.equal(
      run(cursorIn(list('ordered', [item('a'), item('b')]), 'a'), sinkRichTextListItem),
      undefined,
    );
    const deep = list('ordered', [item('a'), item('b', [item('c', [item('d')])])]);
    assert.equal(run(cursorIn(deep, 'b'), sinkRichTextListItem), undefined);
    const third = list('ordered', [item('a', [item('b', [item('c'), item('d')])])]);
    assert.equal(run(cursorIn(third, 'd'), sinkRichTextListItem), undefined);
    const fits = list('ordered', [item('a', [item('b'), item('c')])]);
    const next = run(cursorIn(fits, 'c'), sinkRichTextListItem);
    assert.ok(next !== undefined);
    assert.deepEqual(decode(next.doc), list('ordered', [item('a', [item('b', [item('c')])])]));
  });

  it('lift a nested item after its parent, taking the following siblings as children', () => {
    const document = list('unordered', [
      item('a', [item('b'), item('c', [item('c1')]), item('d')]),
      item('e'),
    ]);
    const next = run(cursorIn(document, 'c', 1), liftRichTextListItem);
    assert.ok(next !== undefined);
    assert.deepEqual(
      decode(next.doc),
      list('unordered', [item('a', [item('b')]), item('c', [item('c1'), item('d')]), item('e')]),
    );
    assert.deepEqual(cursor(next), ['c', 1]);
    const first = run(cursorIn(document, 'b'), liftRichTextListItem);
    assert.ok(first !== undefined);
    assert.deepEqual(
      decode(first.doc),
      list('unordered', [item('a'), item('b', [item('c', [item('c1')]), item('d')]), item('e')]),
    );
  });

  it('lift a third-level item to the second level', () => {
    const document = list('ordered', [item('a', [item('b', [item('c'), item('d')])])]);
    const next = run(cursorIn(document, 'c'), liftRichTextListItem);
    assert.ok(next !== undefined);
    assert.deepEqual(
      decode(next.doc),
      list('ordered', [item('a', [item('b'), item('c', [item('d')])])]),
    );
  });

  it('lift a root item out of its list into a paragraph between the halves', () => {
    const document = list('task', [
      task('a', true),
      task('b', true, [task('b1', true)]),
      task('c', false),
    ]);
    const next = run(cursorIn(document, 'b', 1), liftRichTextListItem);
    assert.ok(next !== undefined);
    assert.deepEqual(decode(next.doc), {
      version: 2,
      blocks: [
        { type: 'list', style: 'task', items: [task('a', true)] },
        { type: 'paragraph', content: [{ text: 'b' }] },
        { type: 'list', style: 'task', items: [task('b1', true), task('c', false)] },
      ],
    });
    assert.deepEqual(cursor(next), ['b', 1]);
    const only = run(cursorIn(list('ordered', [item('x')]), 'x'), liftRichTextListItem);
    assert.ok(only !== undefined);
    assert.deepEqual(decode(only.doc).blocks, [{ type: 'paragraph', content: [{ text: 'x' }] }]);
  });

  it('do nothing outside a list item', () => {
    const state = createRichTextEditorState({
      version: 2,
      blocks: [{ type: 'paragraph', content: [{ text: 'p' }] }],
    });
    for (const command of [sinkRichTextListItem, liftRichTextListItem, splitRichTextListItem]) {
      assert.equal(run(state, command), undefined);
    }
  });
});
