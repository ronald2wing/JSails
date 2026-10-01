/**
 * {@link richTextToPlainText}: the plain-text projection of a document, for
 * search indexes, excerpts and meta descriptions. The result is plain text,
 * not HTML; a caller placing it into markup escapes it there.
 */

import type { InlineContent, ListItem, RichTextBlock, RichTextDocument } from './document.js';

function inlineText(content: InlineContent): string {
  let out = '';
  for (const run of content) {
    out += run.text;
  }
  return out;
}

function pushItems(items: readonly ListItem[], lines: string[]): void {
  for (const item of items) {
    lines.push(inlineText(item.content));
    if (item.children !== undefined) {
      pushItems(item.children, lines);
    }
  }
}

function pushBlock(block: RichTextBlock, lines: string[]): void {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'callout':
      lines.push(inlineText(block.content));
      return;
    case 'quote':
      lines.push(inlineText(block.content), block.citation ?? '');
      return;
    case 'code':
      lines.push(block.code);
      return;
    case 'list':
      pushItems(block.items, lines);
      return;
    case 'image':
      lines.push(block.alt ?? '', block.caption ?? '');
      return;
    case 'gallery':
      lines.push(block.alt ?? '');
      return;
    case 'cta':
      lines.push(block.label);
      return;
    case 'embed':
    case 'divider':
      return;
  }
}

/**
 * The text of a document, exactly: each block's runs concatenated (a quote
 * followed by its citation; code as written; an image's alt and caption; a
 * gallery's alt; a call to action's label), every list item at every depth
 * as its own line, and the non-empty lines joined by `\n` in document order.
 * Embeds and dividers contribute nothing. Hard breaks inside a run stay `\n`.
 * Nothing is truncated; callers bound the length they store.
 *
 * @public
 */
export function richTextToPlainText(document: RichTextDocument): string {
  const lines: string[] = [];
  for (const block of document.blocks) {
    pushBlock(block, lines);
  }
  return lines.filter((line) => line !== '').join('\n');
}
