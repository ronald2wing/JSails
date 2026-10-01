/**
 * Rich-text model (`jsails/rich-text`): the persisted document, version 2.
 *
 * Browser-safe and editor-agnostic. `parseRichText` is the only reader of a
 * stored or submitted document; writers build any schema-valid document and
 * store `normalizeRichText(document)`. `isLinkHref` and `isEmbedUrl` are the
 * URL predicates the schema applies, `measureRichText` the size budget,
 * `richTextToPlainText` the text projection, and `upgradeRichTextDocument`
 * the explicit path from version 1. Rendering to HTML and editing are
 * `@jsails/editor`'s.
 */

export {
  BLOCK_TYPES,
  CALLOUT_TONES,
  INLINE_MARKS,
  LIST_STYLES,
  MAX_ALT_LENGTH,
  MAX_BLOCK_CHARS,
  MAX_BLOCKS,
  MAX_CAPTION_LENGTH,
  MAX_CITATION_LENGTH,
  MAX_CTA_LABEL_LENGTH,
  MAX_DOCUMENT_BYTES,
  MAX_GALLERY_ITEMS,
  MAX_HEADING_LEVEL,
  MAX_LANGUAGE_LENGTH,
  MAX_LIST_DEPTH,
  MAX_LIST_ITEMS,
  MAX_MEDIA_ID_LENGTH,
  MIN_HEADING_LEVEL,
  RICH_TEXT_VERSION,
  createEmptyRichTextDocument,
  richTextContract,
  richTextSchema,
  type CalloutBlock,
  type CalloutTone,
  type CodeBlock,
  type CtaBlock,
  type DividerBlock,
  type EmbedBlock,
  type GalleryBlock,
  type HeadingBlock,
  type HeadingLevel,
  type ImageBlock,
  type InlineContent,
  type InlineMark,
  type InlineRun,
  type ListBlock,
  type ListItem,
  type ListStyle,
  type ParagraphBlock,
  type QuoteBlock,
  type RichTextBlock,
  type RichTextBlockType,
  type RichTextDocument,
} from './document.js';
export { normalizeRichText } from './canonical.js';
export { measureRichText, type RichTextMeasure } from './measure.js';
export {
  parseRichText,
  type RichTextIssue,
  type RichTextIssueCode,
  type RichTextParseResult,
} from './parse.js';
export { richTextToPlainText } from './plain-text.js';
export { upgradeRichTextDocument } from './upgrade.js';
export { MAX_URL_LENGTH, isEmbedUrl, isLinkHref, type EmbedUrl, type LinkHref } from './url.js';
