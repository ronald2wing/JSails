/**
 * Server-side rendering for rich-text documents (`@jsails/editor/server`): the
 * HTML renderer plus a plain-text projection for excerpts and search.
 */

export {
  RichTextRenderError,
  renderRichText,
  type MediaResolver,
  type RichTextRenderErrorCode,
  type RenderRichTextOptions,
  type ResolvedMedia,
} from './render.js';

export { richTextToPlainText, PLAIN_TEXT_MAX_LENGTH, type PlainTextOptions } from './plain-text.js';
