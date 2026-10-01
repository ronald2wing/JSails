/**
 * Tests for the editor adapter contract (`jsails/rich-text`).
 *
 * The contract is intentionally independent of any editor package: a fake
 * adapter exercises envelope construction, canonical projection, native
 * payload fallback, registry lookup, and validation without importing
 * Editor.js, Lexical, Preact, or the DOM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import {
  EditorAdapterError,
  EditorRegistry,
  createCanonicalEditorDocument,
  createEditorDocument,
  defineRichTextEditorAdapter,
  editorDocumentContent,
  editorDocumentPayload,
  isEditorDocument,
  type RichTextDocument,
} from '../../src/rich-text/index.js';

const content: RichTextDocument = {
  version: 1,
  blocks: [{ id: 'b1', type: 'paragraph', text: 'hello' }],
};

const adapter = defineRichTextEditorAdapter({
  id: 'fake',
  island: 'fake-editor',
  payloadSchema: z.object({ text: z.string() }),
  toContent(payload: { text: string }): RichTextDocument {
    return { version: 1, blocks: [{ id: 'b1', type: 'paragraph', text: payload.text }] };
  },
  fromContent(document: RichTextDocument): { text: string } {
    const first = document.blocks[0];
    return { text: first?.type === 'paragraph' ? first.text : '' };
  },
  render(payload: { text: string }): string {
    return `<p>${payload.text}</p>`;
  },
});

describe('editor adapter contract', () => {
  it('validates and freezes an adapter definition', () => {
    assert.equal(adapter.id, 'fake');
    assert.equal(adapter.island, 'fake-editor');
    assert.throws(
      () => defineRichTextEditorAdapter({ ...adapter, id: 'Bad ID' }),
      (error: unknown) => error instanceof EditorAdapterError,
    );
  });

  it('builds an envelope with canonical content and native payload', () => {
    const document = createEditorDocument(adapter, { text: 'hello' });
    assert.equal(document.version, 1);
    assert.equal(document.editor, 'fake');
    assert.deepEqual(document.content, content);
    assert.deepEqual(document.native, { text: 'hello' });
    assert.equal(isEditorDocument(document), true);
  });

  it('builds a canonical-only envelope', () => {
    const document = createCanonicalEditorDocument('fake', content);
    assert.equal(document.native, undefined);
    assert.deepEqual(editorDocumentContent(document), content);
  });

  it('resolves native payloads, falling back to fromContent', () => {
    const withNative = createEditorDocument(adapter, { text: 'hello' });
    assert.deepEqual(editorDocumentPayload(adapter, withNative), { text: 'hello' });

    const withoutNative = createCanonicalEditorDocument('fake', content);
    assert.deepEqual(editorDocumentPayload(adapter, withoutNative), { text: 'hello' });
  });

  it('rejects a non-JSON native payload', () => {
    const payload = { text: 'hello', callback: () => undefined } as unknown as { text: string };
    assert.throws(
      () => createEditorDocument(adapter, payload),
      (error: unknown) => error instanceof EditorAdapterError && error.code === 'invalid_document',
    );
  });

  it('rejects a malformed envelope and canonical document', () => {
    assert.throws(
      () => editorDocumentContent({ version: 2, blocks: [] }),
      (error: unknown) => error instanceof EditorAdapterError,
    );
  });

  it('constructs a registry and rejects duplicate ids', () => {
    const registry = new EditorRegistry([adapter]);
    assert.deepEqual(registry.ids(), ['fake']);
    assert.equal(registry.get('fake'), adapter);
    assert.throws(
      () => registry.register(adapter),
      (error: unknown) => error instanceof EditorAdapterError,
    );
  });

  it('renders through an adapter renderer and returns undefined without one', () => {
    const document = createEditorDocument(adapter, { text: 'hello' });
    assert.equal(new EditorRegistry([adapter]).render(document), '<p>hello</p>');

    const canonicalOnly = defineRichTextEditorAdapter({ ...adapter, render: undefined });
    assert.equal(new EditorRegistry([canonicalOnly]).render(document), undefined);
  });
});
