/**
 * Plain-text projection of a rich-text document (`@jsails/editor/server`).
 *
 * {@link richTextToPlainText} collapses a validated {@link RichTextDocument}
 * into a single, deterministic plain-text string for excerpts, search indexes,
 * and meta descriptions. It is structure-aware (headings and list items get
 * their own lines; code, embeds, and media contribute nothing) and bounded:
 * every textual field is already bounded by the contract, and the joined result
 * is truncated to {@link PLAIN_TEXT_MAX_LENGTH} by default so a caller can
 * safely feed it into a length-limited meta description or excerpt column. A
 * search index passes `maxLength: Infinity` to keep the whole body matchable.
 *
 * Unlike the HTML renderer, this module performs no escaping: plain text is not
 * HTML, so there is nothing to escape. Callers that place the result back into
 * HTML must run it through {@link Str.escapeHtml} themselves.
 */

import { richTextSchema, type RichTextBlock, type RichTextDocument } from 'jsails/rich-text';
import { RichTextRenderError } from './render.js';

/**
 * Hard cap on the returned string length, in UTF-16 code units. The contract's
 * per-field bounds allow a document whose concatenated text exceeds any
 * reasonable excerpt, so the final join is sliced defensively.
 */
export const PLAIN_TEXT_MAX_LENGTH = 2000;

/** Options for {@link richTextToPlainText}. */
export interface PlainTextOptions {
  /** Truncation bound in UTF-16 code units. Defaults to {@link PLAIN_TEXT_MAX_LENGTH}. */
  readonly maxLength?: number;
}

/**
 * Extract a deterministic plain-text summary of a rich-text document.
 *
 * Text-bearing blocks (paragraph, heading, list, quote, callout, and the CTA
 * label) contribute their text; the quote citation is appended in parentheses;
 * code, image, gallery, embed, and divider blocks are skipped. Blocks are
 * separated by a single newline, which callers may further collapse. The result
 * is truncated to `options.maxLength` (default {@link PLAIN_TEXT_MAX_LENGTH});
 * an empty document yields `''`.
 *
 * A malformed document throws the same value-free {@link RichTextRenderError} as the
 * HTML renderer, so the two surfaces fail identically on bad input.
 */
export function richTextToPlainText(
  document: RichTextDocument,
  options: PlainTextOptions = {},
): string {
  if (!richTextSchema.safeParse(document).success) {
    throw new RichTextRenderError(
      'invalid_document',
      'plain-text rendering requires a validated rich-text document',
    );
  }

  const parts: string[] = [];
  for (const block of document.blocks) {
    pushBlockText(block, parts);
  }

  const maxLength = options.maxLength ?? PLAIN_TEXT_MAX_LENGTH;
  const joined = parts.filter((part) => part.trim().length > 0).join('\n');
  return joined.length <= maxLength ? joined : joined.slice(0, maxLength);
}

/** Append this block's textual content (if any) to `parts`. */
function pushBlockText(block: RichTextBlock, parts: string[]): void {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'callout':
      parts.push(block.text);
      return;
    case 'list':
      for (const item of block.items) {
        parts.push(item);
      }
      return;
    case 'quote': {
      const citation = block.citation;
      parts.push(
        citation !== undefined && citation !== '' ? `${block.text} (${citation})` : block.text,
      );
      return;
    }
    case 'cta':
      parts.push(block.label);
      return;
    // Code, media, embeds, and dividers carry no plain text.
    case 'code':
    case 'image':
    case 'gallery':
    case 'embed':
    case 'divider':
      return;
  }
}
