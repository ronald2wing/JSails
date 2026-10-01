/**
 * The limits plugin makes every budget unreachable: a transaction taking the
 * document past `MAX_BLOCK_CHARS`, `MAX_BLOCKS`, `MAX_LIST_ITEMS` or
 * `MAX_DOCUMENT_BYTES` is refused and reported, an edit up to a limit is
 * not, and a state built over budget by hand still accepts the edits that
 * shrink it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Fragment } from 'prosemirror-model';
import { EditorState, type Transaction } from 'prosemirror-state';

import {
  MAX_BLOCK_CHARS,
  MAX_BLOCKS,
  MAX_DOCUMENT_BYTES,
  MAX_LIST_ITEMS,
  type RichTextDocument,
  type RichTextMeasure,
} from 'jsails/rich-text';

import { encode } from '../../src/prosemirror/codec.js';
import { measureEditorDocument, richTextLimits } from '../../src/prosemirror/limits.js';
import { richTextEditorSchema as schema } from '../../src/prosemirror/schema.js';

function stateOf(document: RichTextDocument, refused: RichTextMeasure[] = []): EditorState {
  return EditorState.create({
    doc: schema.nodeFromJSON(encode(document)),
    plugins: [richTextLimits({ onRefuse: (measure) => refused.push(measure) })],
  });
}

const EMPTY_PARAGRAPH: RichTextDocument = {
  version: 2,
  blocks: [{ type: 'paragraph', content: [] }],
};

function applied(state: EditorState, tr: Transaction): boolean {
  return state.apply(tr).doc !== state.doc;
}

function paragraphs(count: number, text: string): Fragment {
  return Fragment.from(
    Array.from({ length: count }, () => schema.nodes.paragraph.create(null, schema.text(text))),
  );
}

describe('richTextLimits', () => {
  it('refuses a block past MAX_BLOCK_CHARS and accepts one at the limit', () => {
    const refused: RichTextMeasure[] = [];
    const state = stateOf(EMPTY_PARAGRAPH, refused);
    assert.ok(applied(state, state.tr.insertText('a'.repeat(MAX_BLOCK_CHARS), 1)));
    assert.equal(applied(state, state.tr.insertText('a'.repeat(MAX_BLOCK_CHARS + 1), 1)), false);
    assert.deepEqual(
      refused.map((measure) => measure.maxBlockChars),
      [MAX_BLOCK_CHARS + 1],
    );
  });

  it('refuses a document past MAX_BLOCKS', () => {
    const state = stateOf(EMPTY_PARAGRAPH);
    assert.ok(applied(state, state.tr.insert(0, paragraphs(MAX_BLOCKS - 1, 'p'))));
    assert.equal(applied(state, state.tr.insert(0, paragraphs(MAX_BLOCKS, 'p'))), false);
  });

  it('refuses a list past MAX_LIST_ITEMS', () => {
    const items = (count: number) =>
      Array.from({ length: count }, () =>
        schema.nodes.list_item.create(null, schema.nodes.paragraph.create()),
      );
    const state = stateOf(EMPTY_PARAGRAPH);
    const list = (count: number) => schema.nodes.list.create({ style: 'ordered' }, items(count));
    assert.ok(applied(state, state.tr.insert(0, list(MAX_LIST_ITEMS))));
    assert.equal(applied(state, state.tr.insert(0, list(MAX_LIST_ITEMS + 1))), false);
  });

  it('refuses a document past MAX_DOCUMENT_BYTES', () => {
    const state = stateOf(EMPTY_PARAGRAPH);
    // 4-byte characters: each block stays far below MAX_BLOCK_CHARS.
    const block = '😀'.repeat(4_000);
    const count = Math.ceil(MAX_DOCUMENT_BYTES / (block.length * 2)) + 1;
    const tr = state.tr.insert(0, paragraphs(count, block));
    assert.ok(measureEditorDocument(tr.doc).bytes > MAX_DOCUMENT_BYTES);
    assert.ok(measureEditorDocument(tr.doc).maxBlockChars <= MAX_BLOCK_CHARS);
    assert.equal(applied(state, tr), false);
  });

  it('lets a state built over budget shrink, and refuses growth', () => {
    const big: RichTextDocument = {
      version: 2,
      blocks: [{ type: 'paragraph', content: [{ text: 'a'.repeat(MAX_BLOCK_CHARS + 10) }] }],
    };
    const state = stateOf(big);
    assert.ok(applied(state, state.tr.delete(1, 3)), 'deleting is allowed');
    assert.equal(applied(state, state.tr.insertText('b', 1)), false, 'growing is not');
  });

  it('caches the measure per document node', () => {
    const state = stateOf(EMPTY_PARAGRAPH);
    assert.equal(measureEditorDocument(state.doc), measureEditorDocument(state.doc));
  });
});
