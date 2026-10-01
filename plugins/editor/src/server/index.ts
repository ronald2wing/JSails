/**
 * Server-side rendering for rich-text documents (`src/editor/server`): the
 * HTML renderer plus a plain-text projection for excerpts and search.
 */

export {
  RenderError,
  renderRichText,
  type MediaResolver,
  type RenderErrorCode,
  type RenderRichTextOptions,
  type ResolvedMedia,
} from './render.js';

export { richTextToPlainText, PLAIN_TEXT_MAX_LENGTH } from './plain-text.js';
