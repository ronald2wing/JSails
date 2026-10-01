/**
 * Editor.js as a first-party {@link RichTextEditorAdapter}.
 *
 * Editor.js output is already the canonical block shape used by JSails, so this
 * adapter is an identity bridge: it validates the same `RichTextDocument`, uses
 * the stable `rich-text` island, and keeps the envelope native payload optional.
 * A future Lexical/custom adapter can store a different native payload while
 * projecting onto the same canonical content.
 */

import {
  DEFAULT_RICH_TEXT_ISLAND,
  defineRichTextEditorAdapter,
  richTextSchema,
  type RichTextDocument,
} from 'jsails/rich-text';

import type { RichTextEditorAdapter } from 'jsails/rich-text';

/** Stable editor id persisted in an `EditorDocument` envelope. */
export const EDITOR_JS_ADAPTER_ID = 'editorjs';

/** The first-party Editor.js adapter. */
export const editorJsAdapter: RichTextEditorAdapter<RichTextDocument> = defineRichTextEditorAdapter(
  {
    id: EDITOR_JS_ADAPTER_ID,
    island: DEFAULT_RICH_TEXT_ISLAND,
    payloadSchema: richTextSchema,
    toContent: (payload) => payload,
    fromContent: (content) => content,
  },
);
