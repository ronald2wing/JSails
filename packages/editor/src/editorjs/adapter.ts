/**
 * Editor.js as a first-party {@link RichTextEditorAdapter}.
 *
 * Editor.js output is already the canonical block shape used by JSails, so this
 * adapter is an identity bridge: it validates the same `RichTextDocument`, uses
 * the stable `rich-text` island, and keeps the envelope native payload optional.
 * Another adapter can store a different native payload while projecting onto
 * the same canonical content.
 */

import {
  DEFAULT_RICH_TEXT_ISLAND,
  defineRichTextEditorAdapter,
  richTextSchema,
  type RichTextDocument,
  type RichTextEditorAdapter,
} from 'jsails/rich-text';

/** The first-party Editor.js adapter; its id is persisted in an `EditorDocument` envelope. */
export const editorJsAdapter: RichTextEditorAdapter<RichTextDocument> = defineRichTextEditorAdapter(
  {
    id: 'editorjs',
    island: DEFAULT_RICH_TEXT_ISLAND,
    payloadSchema: richTextSchema,
    toContent: (payload) => payload,
    fromContent: (content) => content,
  },
);
