import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RichTextDocument } from 'jsails/rich-text';

import {
  mountRichTextEditor,
  type EditorElement,
  type EditorJsInstance,
  type EditorJsOutputData,
} from '../../src/index.js';

/** A minimal structural element the mount accepts (no jsdom). */
function editorElement(): EditorElement {
  const attributes = new Map<string, string>();
  return {
    nodeType: 1,
    tagName: 'DIV',
    classList: { add() {} },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    focus() {},
  };
}

/**
 * A DOM-free Editor.js double. `save` reports the current blocks through
 * `onSave` (mirroring Editor.js's change-then-save flow) and returns them, so a
 * change both surfaces through `onChange` and is readable via `getDocument`.
 */
function fakeEditor(
  blocks: EditorJsOutputData['blocks'],
): (
  _element: EditorElement,
  data: EditorJsOutputData,
  onSave: (payload: unknown) => void,
) => EditorJsInstance {
  let current = { blocks };
  return (_element, data, onSave) => {
    current = data;
    return {
      isReady: Promise.resolve(),
      save: async () => {
        onSave({ blocks: current.blocks });
        return { blocks: current.blocks };
      },
      render: async (next) => {
        current = next;
      },
      focus: () => true,
      destroy() {},
    };
  };
}

/** A paragraph block. */
function paragraph(text: string, id: string) {
  return { id, type: 'paragraph', text } as const;
}

function document(blocks: RichTextDocument['blocks']): RichTextDocument {
  return { version: 1, blocks };
}

describe('mountRichTextEditor (Editor.js)', () => {
  it('rejects a missing element with no_dom', () => {
    assert.throws(
      () => mountRichTextEditor({ element: undefined as never, document: document([]) }),
      (error: unknown) => (error as { code?: string }).code === 'no_dom',
    );
  });

  it('rejects an invalid document with invalid_document', () => {
    assert.throws(
      () => mountRichTextEditor({ element: editorElement(), document: { version: 2, blocks: [] } }),
      (error: unknown) => (error as { code?: string }).code === 'invalid_document',
    );
  });

  it('ready constructs the editor exactly once', async () => {
    let created = 0;
    const element = editorElement();
    const handle = mountRichTextEditor({
      element,
      document: document([paragraph('hello', 'b1')]),
      _createEditor: (host, data) => {
        created += 1;
        return fakeEditor([{ id: 'b1', type: 'paragraph', data: { text: 'hello' } }])(
          host,
          data,
          () => {},
        );
      },
    });

    await handle.ready();
    await handle.ready();
    assert.equal(created, 1);
    handle.destroy();
  });

  it('round-trips getDocument/setDocument through the adapter', async () => {
    const element = editorElement();
    const handle = mountRichTextEditor({
      element,
      document: document([paragraph('hello', 'b1')]),
      _createEditor: fakeEditor([{ id: 'b1', type: 'paragraph', data: { text: 'hello' } }]),
    });

    const initial = await handle.getDocument();
    assert.equal(initial.blocks[0]?.type === 'paragraph' ? initial.blocks[0].text : '', 'hello');

    await handle.setDocument(document([paragraph('updated', 'b2')]));
    const updated = await handle.getDocument();
    assert.equal(updated.blocks[0]?.type === 'paragraph' ? updated.blocks[0].text : '', 'updated');

    handle.destroy();
    await assert.rejects(handle.getDocument(), (error: unknown) => {
      return (error as { code?: string }).code === 'destroyed';
    });
  });

  it('fires onChange with the converted document after a save', async () => {
    const element = editorElement();
    let seen: RichTextDocument | undefined;
    const handle = mountRichTextEditor({
      element,
      document: document([paragraph('hello', 'b1')]),
      _createEditor: fakeEditor([{ id: 'b1', type: 'paragraph', data: { text: 'hello' } }]),
      onChange: (next) => (seen = next),
    });

    // `getDocument` drives the double's save, which reports through onChange.
    await handle.getDocument();
    assert.equal(seen?.blocks[0]?.type === 'paragraph' ? seen.blocks[0].text : '', 'hello');

    handle.destroy();
  });

  it('rejects a duplicate setDocument after destroy', async () => {
    const element = editorElement();
    const handle = mountRichTextEditor({
      element,
      document: document([paragraph('hello', 'b1')]),
      _createEditor: fakeEditor([{ id: 'b1', type: 'paragraph', data: { text: 'hello' } }]),
    });
    handle.destroy();
    await assert.rejects(handle.setDocument(document([paragraph('x', 'b2')])), (error: unknown) => {
      return (error as { code?: string }).code === 'destroyed';
    });
  });

  it('destroy is idempotent', async () => {
    const element = editorElement();
    const handle = mountRichTextEditor({
      element,
      document: document([paragraph('hello', 'b1')]),
      _createEditor: fakeEditor([{ id: 'b1', type: 'paragraph', data: { text: 'hello' } }]),
    });
    handle.destroy();
    handle.destroy();
    await assert.rejects(handle.getDocument(), (error: unknown) => {
      return (error as { code?: string }).code === 'destroyed';
    });
  });
});
