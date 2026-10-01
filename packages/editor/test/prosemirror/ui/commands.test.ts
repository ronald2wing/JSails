/**
 * The editing commands on editor states: block types, marks and their active
 * state, links (set, retarget, insert, remove, refused hrefs), lists (wrap,
 * restyle, unwrap from any depth in one undo step), task toggling, and atom
 * insertion with the paragraph that keeps the document typeable after it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { undo } from 'prosemirror-history';
import { TextSelection, type Command, type EditorState } from 'prosemirror-state';

import type { RichTextBlock } from 'jsails/rich-text';

import { decode } from '../../../src/prosemirror/codec.js';
import { createRichTextEditorState } from '../../../src/prosemirror/mount.js';
import {
  activeBlockType,
  activeLinkHref,
  activeListStyle,
  canLink,
  indentCommand,
  insertAtomCommand,
  isInlineMarkActive,
  outdentCommand,
  removeLinkCommand,
  setBlockTypeCommand,
  setLinkCommand,
  toggleListCommand,
  toggleMarkCommand,
  toggleTaskCommand,
} from '../../../src/prosemirror/ui/commands.js';

function stateOf(blocks: readonly RichTextBlock[]): EditorState {
  return createRichTextEditorState({ version: 2, blocks });
}

function at(state: EditorState, from: number, to = from): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

/** Run `command` and return the resulting state (failing when it does not apply). */
function run(state: EditorState, command: Command): EditorState {
  let next: EditorState | undefined;
  const applied = command(state, (tr) => {
    next = state.apply(tr);
  });
  assert.equal(applied, true, 'the command applies');
  assert.ok(next !== undefined, 'the command dispatched');
  return next;
}

function blocks(state: EditorState): readonly RichTextBlock[] {
  return decode(state.doc).blocks;
}

const paragraph = (text: string): RichTextBlock => ({ type: 'paragraph', content: [{ text }] });
const EMPTY: RichTextBlock = { type: 'paragraph', content: [] };

describe('block types', () => {
  it('turns a paragraph into a heading, a quote, a callout and code, and reports it', () => {
    const start = at(stateOf([paragraph('Title')]), 2);
    assert.equal(activeBlockType(start), 'paragraph');
    const heading = run(start, setBlockTypeCommand('heading-3'));
    assert.deepEqual(blocks(heading), [
      { type: 'heading', level: 3, content: [{ text: 'Title' }] },
    ]);
    assert.equal(activeBlockType(heading), 'heading-3');
    assert.equal(activeBlockType(run(start, setBlockTypeCommand('quote'))), 'quote');
    assert.deepEqual(blocks(run(start, setBlockTypeCommand('callout'))), [
      { type: 'callout', tone: 'info', content: [{ text: 'Title' }] },
    ]);
    assert.deepEqual(blocks(run(start, setBlockTypeCommand('code'))), [
      { type: 'code', code: 'Title' },
    ]);
  });

  it('does not apply inside a list item, whose content starts with a paragraph', () => {
    const state = at(
      stateOf([{ type: 'list', style: 'unordered', items: [{ content: [{ text: 'a' }] }] }]),
      3,
    );
    assert.equal(setBlockTypeCommand('heading-2')(state), false);
  });

  it('reports no type for a selection across blocks of different types', () => {
    const state = stateOf([
      paragraph('a'),
      { type: 'heading', level: 2, content: [{ text: 'b' }] },
    ]);
    assert.equal(activeBlockType(at(state, 1, 5)), undefined);
  });
});

describe('marks', () => {
  it('toggles a mark on a range and reports it active only on the whole range', () => {
    const state = run(at(stateOf([paragraph('hello world')]), 1, 6), toggleMarkCommand('bold'));
    assert.deepEqual(blocks(state), [
      { type: 'paragraph', content: [{ text: 'hello', marks: ['bold'] }, { text: ' world' }] },
    ]);
    assert.equal(isInlineMarkActive(at(state, 2, 4), 'bold'), true);
    assert.equal(isInlineMarkActive(at(state, 2, 9), 'bold'), false);
    assert.equal(isInlineMarkActive(at(state, 3), 'bold'), true);
  });

  it('does not apply in a code block', () => {
    const state = at(stateOf([{ type: 'code', code: 'x = 1' }]), 2, 3);
    assert.equal(toggleMarkCommand('bold')(state), false);
  });
});

describe('links', () => {
  it('links a range, reads its href, retargets it from inside, and removes it', () => {
    const linked = run(at(stateOf([paragraph('see docs here')]), 5, 9), setLinkCommand('/docs'));
    assert.deepEqual(blocks(linked), [
      {
        type: 'paragraph',
        content: [{ text: 'see ' }, { text: 'docs', href: '/docs' }, { text: ' here' }],
      },
    ]);
    const inside = at(linked, 7);
    assert.equal(activeLinkHref(inside), '/docs');
    const retargeted = run(inside, setLinkCommand('https://example.com/docs'));
    assert.deepEqual(blocks(retargeted)[0], {
      type: 'paragraph',
      content: [
        { text: 'see ' },
        { text: 'docs', href: 'https://example.com/docs' },
        { text: ' here' },
      ],
    });
    assert.deepEqual(blocks(run(at(retargeted, 6), removeLinkCommand)), [
      paragraph('see docs here'),
    ]);
  });

  it('inserts the href as linked text at an empty selection outside a link', () => {
    const state = run(at(stateOf([paragraph('go ')]), 4), setLinkCommand('#top'));
    assert.deepEqual(blocks(state), [
      { type: 'paragraph', content: [{ text: 'go ' }, { text: '#top', href: '#top' }] },
    ]);
  });

  it('refuses an href the model refuses and does not apply where links cannot go', () => {
    const state = at(stateOf([paragraph('click')]), 1, 6);
    for (const href of ['javascript:alert(1)', 'data:text/html,x', '//evil.example', ' /x']) {
      assert.equal(setLinkCommand(href)(state), false);
    }
    const code = at(stateOf([{ type: 'code', code: 'x' }]), 1, 2);
    assert.equal(canLink(code), false);
    assert.equal(removeLinkCommand(at(stateOf([paragraph('plain')]), 2)), false);
  });
});

describe('lists', () => {
  it('wraps a paragraph in a list of each style and reports the style', () => {
    for (const style of ['unordered', 'ordered', 'task'] as const) {
      const state = run(at(stateOf([paragraph('item')]), 2), toggleListCommand(style));
      assert.equal(activeListStyle(state), style);
      assert.deepEqual(blocks(state), [
        {
          type: 'list',
          style,
          items: [{ content: [{ text: 'item' }], ...(style === 'task' ? { checked: false } : {}) }],
        },
      ]);
    }
  });

  it('restyles the surrounding list, nested items included', () => {
    const nested: RichTextBlock = {
      type: 'list',
      style: 'unordered',
      items: [{ content: [{ text: 'a' }], children: [{ content: [{ text: 'b' }] }] }],
    };
    const state = run(at(stateOf([nested]), 8), toggleListCommand('task'));
    assert.deepEqual(blocks(state), [
      {
        type: 'list',
        style: 'task',
        items: [
          {
            content: [{ text: 'a' }],
            checked: false,
            children: [{ content: [{ text: 'b' }], checked: false }],
          },
        ],
      },
    ]);
  });

  it('turns a nested item back into a paragraph in one undoable step', () => {
    const nested: RichTextBlock = {
      type: 'list',
      style: 'unordered',
      items: [{ content: [{ text: 'a' }], children: [{ content: [{ text: 'b' }] }] }],
    };
    const start = at(stateOf([nested]), 8);
    const unwrapped = run(start, toggleListCommand('unordered'));
    assert.deepEqual(blocks(unwrapped), [
      { type: 'list', style: 'unordered', items: [{ content: [{ text: 'a' }] }] },
      paragraph('b'),
    ]);
    assert.deepEqual(blocks(run(unwrapped, undo)), [nested]);
  });

  it('indents and outdents an item', () => {
    const list: RichTextBlock = {
      type: 'list',
      style: 'ordered',
      items: [{ content: [{ text: 'a' }] }, { content: [{ text: 'b' }] }],
    };
    const indented = run(at(stateOf([list]), 8), indentCommand);
    assert.deepEqual(blocks(indented), [
      {
        type: 'list',
        style: 'ordered',
        items: [{ content: [{ text: 'a' }], children: [{ content: [{ text: 'b' }] }] }],
      },
    ]);
    assert.deepEqual(blocks(run(indented, outdentCommand)), [list]);
  });

  it('toggles the innermost task item and only in a task list', () => {
    const tasks: RichTextBlock = {
      type: 'list',
      style: 'task',
      items: [
        {
          content: [{ text: 'a' }],
          checked: false,
          children: [{ content: [{ text: 'b' }], checked: false }],
        },
      ],
    };
    const toggled = run(at(stateOf([tasks]), 8), toggleTaskCommand);
    assert.deepEqual(blocks(toggled), [
      {
        type: 'list',
        style: 'task',
        items: [
          {
            content: [{ text: 'a' }],
            checked: false,
            children: [{ content: [{ text: 'b' }], checked: true }],
          },
        ],
      },
    ]);
    const bullets = at(
      stateOf([{ type: 'list', style: 'unordered', items: [{ content: [{ text: 'a' }] }] }]),
      3,
    );
    assert.equal(toggleTaskCommand(bullets), false);
  });
});

describe('atoms', () => {
  it('inserts an atom and a paragraph after it when nothing editable follows', () => {
    const state = run(at(stateOf([paragraph('end')]), 4), insertAtomCommand('divider'));
    assert.deepEqual(blocks(state), [
      paragraph('end'),
      { type: 'divider' },
      { type: 'paragraph', content: [] },
    ]);
  });

  it('inserts after the list holding the selection, never inside it', () => {
    const list: RichTextBlock = {
      type: 'list',
      style: 'unordered',
      items: [{ content: [{ text: 'a' }] }],
    };
    const state = run(at(stateOf([list, paragraph('next')]), 3), insertAtomCommand('divider'));
    assert.deepEqual(blocks(state), [list, { type: 'divider' }, paragraph('next')]);
    assert.equal(state.selection.$from.parent.textContent, 'next');
  });

  it('inserts an atom with checked attributes and refuses a value the model refuses', () => {
    const state = run(
      at(stateOf([EMPTY]), 1),
      insertAtomCommand('embed', { url: 'https://video.example/1' }),
    );
    assert.deepEqual(blocks(state)[0], { type: 'embed', url: 'https://video.example/1' });
    assert.throws(() =>
      insertAtomCommand('embed', { url: 'http://video.example/1' })(
        at(stateOf([EMPTY]), 1),
        () => {},
      ),
    );
  });
});
