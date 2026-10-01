/**
 * Server-side rich text (`@jsails/editor/server`): the HTML renderer
 * (`renderRichText`) and the markup of a rich-text form field
 * (`RichTextField`), which the `rich-text` island from
 * `@jsails/editor/preact` hydrates into an editor. The plain-text projection
 * is `richTextToPlainText` in `jsails/rich-text`.
 */

export { RichTextField, type RichTextFieldProps } from './field.js';
export {
  renderRichText,
  type MediaResolver,
  type RenderRichTextOptions,
  type ResolvedMedia,
} from './render.js';
export { RichTextRenderErrors } from './render-errors.js';
