/**
 * The rich-text `body` field of a post or page as the admin resources persist
 * it: a canonical `RichTextDocument`, or, when an editor adapter is configured,
 * an `EditorDocument` envelope carrying the adapter's native payload.
 */

import {
  createCanonicalEditorDocument,
  editorDocumentContent,
  editorDocumentPayload,
  editorDocumentSchema,
  isEditorDocument,
  richTextSchema,
  type EditorDocument,
  type EditorJsonValue,
  type RichTextDocument,
  type RichTextEditorAdapter,
} from 'jsails/rich-text';

/** The blocks for a newly-created admin post/page: an empty document (no body yet). */
export function emptyDocument(): RichTextDocument {
  return { version: 1, blocks: [] };
}

/** Validate a submitted body as a rich-text document, or `null` when invalid. */
export function toRichTextDocument(value: unknown): RichTextDocument | null {
  const result = richTextSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * The persistence triple an adapter-backed `body` resolves to: canonical blocks
 * plus the editor id and (optional) native payload.
 */
export interface EditorBody {
  readonly blocks: RichTextDocument;
  readonly editorId: string;
  readonly native?: EditorJsonValue;
}

/** The stored editor fields of a post or page record. */
export interface StoredEditorFields {
  readonly editor?: string;
  readonly native?: EditorJsonValue;
}

/**
 * The `EditorDocument` envelope returned by `get` for an adapter-backed body.
 * A record already carrying `editor`/`native` preserves them; a
 * canonical-only record falls back to the adapter id with canonical content and
 * no native payload.
 */
export function editorEnvelope(
  editor: RichTextEditorAdapter,
  blocks: RichTextDocument,
  record: StoredEditorFields,
): EditorDocument {
  return editorDocumentSchema.parse({
    version: 1,
    editor: record.editor ?? editor.id,
    content: blocks,
    ...(record.native === undefined ? {} : { native: record.native }),
  });
}

/**
 * Resolve a submitted adapter-backed body into its persistence triple, or
 * `null` for a value-free rejection (unrecognized shape, mismatched editor id,
 * or a native payload the adapter's schema rejects). A canonical-only
 * document is accepted: its content is projected onto the adapter's payload via
 * {@link editorDocumentPayload} so a first adapter-backed save round-trips the
 * native payload on the next `get`.
 */
export function editorBody(editor: RichTextEditorAdapter, value: unknown): EditorBody | null {
  if (isEditorDocument(value)) {
    if (value.editor !== editor.id) {
      return null;
    }
    if (value.native !== undefined && !editor.payloadSchema.safeParse(value.native).success) {
      return null;
    }
    return {
      blocks: editorDocumentContent(value),
      editorId: value.editor,
      ...(value.native === undefined ? {} : { native: value.native }),
    };
  }
  const parsed = richTextSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const envelope = createCanonicalEditorDocument(editor.id, parsed.data);
  return {
    blocks: editorDocumentContent(envelope),
    editorId: envelope.editor,
    native: editorDocumentPayload(editor, envelope),
  };
}
