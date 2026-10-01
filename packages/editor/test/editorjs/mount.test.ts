import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RichTextDocument } from 'jsails/rich-text';

import type { EditorJsOutputData } from '../../src/editorjs/conversion.js';
import {
  RichTextListTool,
  mountRichTextEditor,
  richTextEditorTools,
  type EditorElement,
  type EditorJsInstance,
} from '../../src/editorjs/mount.js';

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

/** A DOM-free Editor.js double whose `save` returns the current blocks. */
function fakeEditor(
  blocks: EditorJsOutputData['blocks'],
): (
  _element: EditorElement,
  data: EditorJsOutputData,
  onEditorChange: () => void,
) => EditorJsInstance {
  let current = { blocks };
  return (_element, data) => {
    current = data;
    return {
      isReady: Promise.resolve(),
      save: async () => ({ blocks: current.blocks }),
      render: async (next) => {
        current = next;
      },
      focus: () => true,
      destroy() {},
    };
  };
}

/** A deferred value, so a test decides when each save settles. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/**
 * An Editor.js double whose saves settle only when the test says so, plus the
 * change callback the mount hands it (what Editor.js calls `onChange`).
 */
function scriptedEditor() {
  const saves: ReturnType<typeof deferred<unknown>>[] = [];
  let change: (() => void) | undefined;
  return {
    saves,
    change(): void {
      assert.ok(change !== undefined, 'the editor has not been created');
      change();
    },
    create(_element: EditorElement, _data: EditorJsOutputData, onEditorChange: () => void) {
      change = onEditorChange;
      const instance: EditorJsInstance = {
        isReady: Promise.resolve(),
        save: () => {
          const save = deferred<unknown>();
          saves.push(save);
          return save.promise;
        },
        render: async () => {},
        focus: () => true,
        destroy() {},
      };
      return instance;
    },
  };
}

function editorJsParagraph(text: string) {
  return { blocks: [{ id: 'b1', type: 'paragraph', data: { text } }] };
}

function textOf(value: RichTextDocument): string {
  const block = value.blocks[0];
  return block?.type === 'paragraph' ? block.text : '';
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A paragraph block. */
function paragraph(text: string, id: string) {
  return { id, type: 'paragraph', text } as const;
}

function document(blocks: RichTextDocument['blocks']): RichTextDocument {
  return { version: 1, blocks };
}

describe('RichTextListTool', () => {
  it('offers no checklist, which a persisted list cannot hold', () => {
    const toolbox = RichTextListTool.toolbox;
    const styles = (Array.isArray(toolbox) ? toolbox : [toolbox]).map(
      (entry) => (entry.data as { style?: unknown } | undefined)?.style,
    );
    assert.deepEqual(styles, ['unordered', 'ordered']);

    // The block tunes come from the library's own `renderSettings`, which
    // reads only these fields for an unordered list.
    const tunes = RichTextListTool.prototype.renderSettings.call({
      listStyle: 'unordered',
      api: { i18n: { t: (key: string) => key } },
      data: { meta: {} },
    } as unknown as RichTextListTool);
    assert.deepEqual(
      tunes.map((tune) => ('label' in tune ? tune.label : undefined)),
      ['Unordered', 'Ordered'],
    );
  });
});

describe('richTextEditorTools', () => {
  it('configures the list without nesting, which a persisted list cannot hold', () => {
    const list = richTextEditorTools(undefined).list as { class: unknown; config: unknown };
    assert.equal(list.class, RichTextListTool);
    assert.deepEqual(list.config, { maxLevel: 1 });
  });
});

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

  it('fires onChange with the converted document after an editor change', async () => {
    const editor = scriptedEditor();
    const seen: string[] = [];
    const handle = mountRichTextEditor({
      element: editorElement(),
      document: document([paragraph('hello', 'b1')]),
      _createEditor: (element, data, onEditorChange) =>
        editor.create(element, data, onEditorChange),
      onChange: (next) => seen.push(textOf(next)),
    });
    await handle.ready();

    editor.change();
    editor.saves[0]?.resolve(editorJsParagraph('edited'));
    await settle();
    assert.deepEqual(seen, ['edited']);

    handle.destroy();
  });

  it('reports an edit with no rich-text form as invalid instead of dropping it', async () => {
    const editor = scriptedEditor();
    const seen: string[] = [];
    const handle = mountRichTextEditor({
      element: editorElement(),
      document: document([paragraph('hello', 'b1')]),
      _createEditor: (element, data, onEditorChange) =>
        editor.create(element, data, onEditorChange),
      onChange: () => seen.push('change'),
      onInvalid: () => seen.push('invalid'),
    });
    await handle.ready();

    editor.change();
    editor.saves[0]?.resolve({
      blocks: [{ id: 'b1', type: 'list', data: { style: 'checklist', items: [] } }],
    });
    await settle();
    editor.change();
    editor.saves[1]?.resolve(editorJsParagraph('fixed'));
    await settle();
    assert.deepEqual(seen, ['invalid', 'change']);

    handle.destroy();
  });

  it('reports only the newest save when saves settle out of order', async () => {
    const editor = scriptedEditor();
    const seen: string[] = [];
    const handle = mountRichTextEditor({
      element: editorElement(),
      document: document([paragraph('hello', 'b1')]),
      _createEditor: (element, data, onEditorChange) =>
        editor.create(element, data, onEditorChange),
      onChange: (next) => seen.push(textOf(next)),
      onInvalid: () => seen.push('invalid'),
    });
    await handle.ready();

    editor.change();
    editor.change();
    editor.saves[1]?.resolve(editorJsParagraph('newer'));
    await settle();
    editor.saves[0]?.resolve(editorJsParagraph('older'));
    await settle();
    assert.deepEqual(seen, ['newer']);

    handle.destroy();
  });

  it('reports a failed save as invalid', async () => {
    const editor = scriptedEditor();
    const seen: string[] = [];
    const handle = mountRichTextEditor({
      element: editorElement(),
      document: document([paragraph('hello', 'b1')]),
      _createEditor: (element, data, onEditorChange) =>
        editor.create(element, data, onEditorChange),
      onChange: () => seen.push('change'),
      onInvalid: () => seen.push('invalid'),
    });
    await handle.ready();

    editor.change();
    editor.saves[0]?.reject(new Error('save failed'));
    await settle();
    assert.deepEqual(seen, ['invalid']);

    handle.destroy();
  });

  it('flush resolves with the newest content, waiting for a change made during its save', async () => {
    const editor = scriptedEditor();
    const handle = mountRichTextEditor({
      element: editorElement(),
      document: document([paragraph('hello', 'b1')]),
      _createEditor: (element, data, onEditorChange) =>
        editor.create(element, data, onEditorChange),
    });
    await handle.ready();

    const flushed = handle.flush();
    await settle();
    editor.change();
    editor.saves[0]?.resolve(editorJsParagraph('typed before submit'));
    await settle();
    editor.saves[1]?.resolve(editorJsParagraph('typed during the save'));
    const snapshot = await flushed;
    assert.equal(snapshot.ok && textOf(snapshot.document), 'typed during the save');

    handle.destroy();
  });

  it('flush resolves not ok when the content has no rich-text form', async () => {
    const editor = scriptedEditor();
    const handle = mountRichTextEditor({
      element: editorElement(),
      document: document([paragraph('hello', 'b1')]),
      _createEditor: (element, data, onEditorChange) =>
        editor.create(element, data, onEditorChange),
    });
    await handle.ready();

    const flushed = handle.flush();
    await settle();
    editor.saves[0]?.resolve({ blocks: [{ id: 'b1', type: 'unknown', data: {} }] });
    assert.deepEqual(await flushed, { ok: false });

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
