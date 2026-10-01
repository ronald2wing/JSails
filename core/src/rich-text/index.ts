/**
 * Rich-text data contract (`jsails/rich-text`).
 *
 * The persisted schema is framework-owned and intentionally independent of the
 * optional `@jsails/editor` UI package: a model, API, or renderer can use the
 * contract without installing the editor UI. The editor package consumes this
 * subpath.
 */

export {
  BLOCK_TYPES,
  CALLOUT_TONES,
  LIST_STYLES,
  MAX_ALT_LENGTH,
  MAX_BLOCK_ID_LENGTH,
  MAX_BLOCK_TEXT_LENGTH,
  MAX_BLOCKS,
  MAX_CAPTION_LENGTH,
  MAX_CITATION_LENGTH,
  MAX_CODE_LENGTH,
  MAX_CTA_LABEL_LENGTH,
  MAX_GALLERY_ITEMS,
  MAX_HEADING_LEVEL,
  MAX_LANGUAGE_LENGTH,
  MAX_LIST_ITEMS,
  MAX_URL_LENGTH,
  MIN_HEADING_LEVEL,
  RICH_TEXT_VERSION,
  createEmptyRichTextDocument,
  richTextContract,
  richTextSchema,
  validateRichTextDocument,
  type RichTextBlock,
  type RichTextBlockType,
  type RichTextDocument,
  type RichTextValidationResult,
} from './document.js';
export {
  DEFAULT_RICH_TEXT_ISLAND,
  EDITOR_DOCUMENT_VERSION,
  EditorAdapterError,
  createCanonicalEditorDocument,
  createEditorDocument,
  defineRichTextEditorAdapter,
  editorDocumentContent,
  editorDocumentPayload,
  editorDocumentSchema,
  isEditorDocument,
  type EditorDocument,
  type EditorJsonValue,
  type EditorPayloadSchema,
  type EditorRenderOptions,
  type RichTextEditorAdapter,
} from './editor.js';
