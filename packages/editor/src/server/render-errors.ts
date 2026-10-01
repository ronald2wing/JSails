/**
 * The error codes of the rich-text HTML renderer, `rich_text_render.*`.
 *
 * Only programmer mistakes raise them: a value that skipped `parseRichText`,
 * a malformed option, or a media resolver that returned an unusable
 * descriptor. Every code is value-free: it names the option, never the
 * document, the URL or the resolver's output.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const RICH_TEXT_RENDER_ERRORS = {
  invalid_document: {
    kind: 'invalid',
    message: 'render requires a document parseRichText accepts',
    suggestion: 'read stored values with parseRichText before rendering them',
  },
  invalid_option: {
    kind: 'invalid',
    message: 'render option {option} is malformed',
    context: { option: 'identifier' },
  },
  invalid_media: {
    kind: 'invalid',
    message: 'resolveMedia returned an invalid display descriptor',
    suggestion: 'return { src } with a root-relative path or an http(s) URL, or undefined',
  },
} as const;

/**
 * The renderer's codes: a document `parseRichText` refuses, a malformed
 * option (`options`, `resolveMedia`, `embedHostAllowlist`), and a media
 * descriptor whose `src` is not a path or an http(s) URL.
 *
 * @public
 */
export const RichTextRenderErrors: ErrorRegistry<
  'rich_text_render',
  typeof RICH_TEXT_RENDER_ERRORS
> = defineErrors('rich_text_render', RICH_TEXT_RENDER_ERRORS);
