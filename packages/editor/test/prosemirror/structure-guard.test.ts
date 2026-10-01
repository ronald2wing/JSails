/**
 * The structure guard refuses a transaction that leaves a touched node
 * invalid. The case below is a real ProseMirror fitting result for this
 * schema: pasting the tail of a list (an empty item with a nested child)
 * before a callout builds a list item that holds only its nested list.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EditorState } from 'prosemirror-state';

import type { RichTextDocument } from 'jsails/rich-text';

import { encode } from '../../src/prosemirror/codec.js';
import { createRichTextEditorState } from '../../src/prosemirror/mount.js';
import { richTextEditorSchema as schema } from '../../src/prosemirror/schema.js';
import { richTextStructureGuard } from '../../src/prosemirror/structure-guard.js';

const DOCUMENT: RichTextDocument = {
  version: 2,
  blocks: [
    { type: 'callout', tone: 'info', content: [{ text: 'abc' }] },
    {
      type: 'list',
      style: 'unordered',
      items: [
        { content: [], children: [{ content: [{ text: 'xy' }] }] },
        { content: [{ text: 'z' }] },
      ],
    },
  ],
};

describe('richTextStructureGuard', () => {
  it('refuses a fitted paste that builds an item without its paragraph', () => {
    const bare = EditorState.create({ doc: schema.nodeFromJSON(encode(DOCUMENT)) });
    const unguarded = bare.apply(bare.tr.replace(0, 0, bare.doc.slice(7, 18)));
    assert.throws(() => unguarded.doc.check(), /Invalid content for node list_item/);

    const guarded = EditorState.create({
      doc: bare.doc,
      plugins: [richTextStructureGuard()],
    });
    const after = guarded.apply(guarded.tr.replace(0, 0, guarded.doc.slice(7, 18)));
    assert.equal(after.doc, guarded.doc);
  });

  it('is part of the editor state and lets valid edits through', () => {
    const state = createRichTextEditorState(DOCUMENT);
    assert.equal(state.apply(state.tr.replace(0, 0, state.doc.slice(7, 18))).doc, state.doc);
    const typed = state.apply(state.tr.insertText('!', 4));
    typed.doc.check();
    assert.notEqual(typed.doc, state.doc);
    const deleted = typed.apply(typed.tr.delete(0, typed.doc.child(0).nodeSize));
    deleted.doc.check();
    assert.equal(deleted.doc.childCount, 1);
  });
});
