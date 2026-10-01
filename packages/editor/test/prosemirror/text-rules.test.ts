/**
 * The text rules: each clean function brings a string within the model's
 * rule for where it sits, and the plugin rewrites typed or pasted text that
 * breaks a rule in the state itself (in an appended transaction that undo
 * takes back with the edit), so the editor shows what `decode` returns. A
 * line break that ProseMirror deletes from text becoming a heading is
 * written as a space, once, however the edit is undone and redone.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { joinBackward, setBlockType } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { TextSelection, type Command, type EditorState } from 'prosemirror-state';

import { parseRichText, type RichTextDocument } from 'jsails/rich-text';

import { decode, decodeUnchecked } from '../../src/prosemirror/codec.js';
import { createRichTextEditorState } from '../../src/prosemirror/mount.js';
import { richTextEditorSchema as schema } from '../../src/prosemirror/schema.js';
import { cleanCodeText, cleanLineText, cleanRunText } from '../../src/prosemirror/text-rules.js';

const HOSTILE =
  'a\r\nb\rc\td\u0000e\u0007f\u001bg\u007fh\u0085i\u009bj\u202ak\u202el\u2066m\u2069n\ud800o\udfffp';

describe('clean functions', () => {
  it('apply the code rule: line endings normalised, tabs and newlines kept', () => {
    assert.equal(cleanCodeText(HOSTILE), 'a\nb\nc\tdefghijklmn\ufffdo\ufffdp');
    assert.equal(cleanCodeText('😀'), '😀', 'a surrogate pair is kept');
  });

  it('apply the run rule: tabs become spaces', () => {
    assert.equal(cleanRunText(HOSTILE), 'a\nb\nc defghijklmn\ufffdo\ufffdp');
  });

  it('apply the line rule: no line breaks', () => {
    assert.equal(cleanLineText(HOSTILE), 'a b c defghijklmn\ufffdo\ufffdp');
  });

  it('leave readable text untouched', () => {
    for (const text of ['', 'plain', '\u00a0\u200d\u2028', '日本語 😀', '<b>&amp;</b>']) {
      assert.equal(cleanRunText(text), text);
      assert.equal(cleanLineText(text), text);
      assert.equal(cleanCodeText(text), text);
    }
  });
});

const DOCUMENT: RichTextDocument = {
  version: 2,
  blocks: [
    { type: 'paragraph', content: [{ text: 'p', marks: ['bold'] }] },
    { type: 'heading', level: 2, content: [{ text: 'h' }] },
    { type: 'code', code: 'c' },
  ],
};

function typeAt(state: EditorState, pos: number, text: string): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)).insertText(text));
}

describe('richTextTextRules', () => {
  it('corrects typed text in the state, by the rule of its block', () => {
    let state = createRichTextEditorState(DOCUMENT);
    state = typeAt(state, 2, '\u202e1\r\n2\t\u0000');
    const heading = state.doc.child(0).nodeSize;
    state = typeAt(state, heading + 1, 'x\ny\t\ud800');
    const code = state.doc.child(0).nodeSize + state.doc.child(1).nodeSize;
    state = typeAt(state, code + 1, '\r\n\t\u202a');
    assert.deepEqual(decode(state.doc).blocks, [
      { type: 'paragraph', content: [{ text: 'p1\n2 ', marks: ['bold'] }] },
      { type: 'heading', level: 2, content: [{ text: 'x y \ufffdh' }] },
      { type: 'code', code: '\n\tc' },
    ]);
    // The paragraph's `\n` is a hard break node, so the state matches the decoded document.
    const paragraph = state.doc.child(0);
    assert.deepEqual(
      Array.from({ length: paragraph.childCount }, (_, index) => paragraph.child(index).type.name),
      ['text', 'hard_break', 'text'],
    );
    state.doc.descendants((node) => {
      if (node.isText) {
        assert.ok(!/[\u0000-\u0008\u000b-\u001f\u202a-\u202e]/.test(node.text ?? ''));
      }
    });
    assert.ok(parseRichText(decodeUnchecked(state.doc)).ok);
  });

  it('is undone together with the edit that needed it', () => {
    let state = createRichTextEditorState(DOCUMENT);
    state = typeAt(state, 2, 'a\u0000b');
    assert.deepEqual(decode(state.doc).blocks[0], {
      type: 'paragraph',
      content: [{ text: 'pab', marks: ['bold'] }],
    });
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    assert.deepEqual(decode(state.doc), DOCUMENT);
  });

  it('removes a text node that holds nothing readable', () => {
    let state = createRichTextEditorState({
      version: 2,
      blocks: [{ type: 'paragraph', content: [] }],
    });
    state = typeAt(state, 1, '\u0000\u202e');
    assert.equal(state.doc.child(0).childCount, 0);
    assert.deepEqual(decode(state.doc).blocks, [{ type: 'paragraph', content: [] }]);
  });
});

/** `state` after `command` at text position `pos` (which must apply). */
function runAt(state: EditorState, pos: number, command: Command): EditorState {
  let next = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  assert.ok(
    command(next, (tr) => {
      next = next.apply(tr);
    }),
  );
  return next;
}

describe('richTextTextRules: line breaks in headings', () => {
  const PARAGRAPH: RichTextDocument = {
    version: 2,
    blocks: [
      {
        type: 'paragraph',
        content: [{ text: 'Line one\n' }, { text: '\nLine two', marks: ['bold'] }],
      },
    ],
  };

  it('writes a space where setBlockType deletes a break, and undo and redo keep one', () => {
    let state = runAt(
      createRichTextEditorState(PARAGRAPH),
      2,
      setBlockType(schema.nodes.heading, { level: 2 }),
    );
    const heading: RichTextDocument = {
      version: 2,
      blocks: [
        {
          type: 'heading',
          level: 2,
          content: [{ text: 'Line one ' }, { text: ' Line two', marks: ['bold'] }],
        },
      ],
    };
    assert.deepEqual(decode(state.doc), heading);
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    assert.deepEqual(decode(state.doc), PARAGRAPH, 'undo takes the spaces back with the change');
    redo(state, (tr) => {
      state = state.apply(tr);
    });
    assert.deepEqual(decode(state.doc), heading, 'redo writes each space once');
  });

  it('writes a space where joining a paragraph into a heading deletes a break', () => {
    const state = createRichTextEditorState({
      version: 2,
      blocks: [
        { type: 'heading', level: 2, content: [{ text: 'H' }] },
        { type: 'paragraph', content: [{ text: 'a\nb' }] },
      ],
    });
    assert.deepEqual(
      decode(runAt(state, state.doc.child(0).nodeSize + 1, joinBackward).doc).blocks,
      [{ type: 'heading', level: 2, content: [{ text: 'Ha b' }] }],
    );
  });

  it('adds nothing where a break is deleted from a block that holds breaks', () => {
    const state = createRichTextEditorState({
      version: 2,
      blocks: [{ type: 'paragraph', content: [{ text: 'a\nb' }] }],
    });
    const deleted = state.apply(state.tr.delete(2, 3));
    assert.deepEqual(decode(deleted.doc).blocks, [
      { type: 'paragraph', content: [{ text: 'ab' }] },
    ]);
  });
});
