/**
 * The size budget of a rich-text document. {@link measureRichText} reports
 * every measured quantity at once, so an editor can refuse an edit that would
 * leave the budget (rather than producing a document that cannot be saved)
 * and `parseRichText` can name each exceeded limit.
 */

import {
  MAX_BLOCK_CHARS,
  MAX_BLOCKS,
  MAX_DOCUMENT_BYTES,
  MAX_LIST_ITEMS,
  type InlineContent,
  type ListItem,
  type RichTextBlock,
  type RichTextDocument,
} from './document.js';

/**
 * The measured size of a document.
 *
 * @public
 */
export interface RichTextMeasure {
  /** UTF-8 length of the document's JSON. */
  readonly bytes: number;
  /** Number of blocks. */
  readonly blocks: number;
  /** Text of the largest block, in UTF-16 code units. */
  readonly maxBlockChars: number;
  /** Items of the largest list, nested items included. */
  readonly maxListItems: number;
  /** True when every quantity is within its `MAX_*` budget. */
  readonly withinBudget: boolean;
}

/** UTF-8 length of a string without encoding it. */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        // A lone surrogate is encoded as U+FFFD.
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function inlineChars(content: InlineContent): number {
  let chars = 0;
  for (const run of content) {
    chars += run.text.length;
  }
  return chars;
}

function itemStats(items: readonly ListItem[]): { chars: number; count: number } {
  let chars = 0;
  let count = 0;
  for (const item of items) {
    chars += inlineChars(item.content);
    count += 1;
    if (item.children !== undefined) {
      const nested = itemStats(item.children);
      chars += nested.chars;
      count += nested.count;
    }
  }
  return { chars, count };
}

function blockChars(block: RichTextBlock): number {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'callout':
      return inlineChars(block.content);
    case 'quote':
      return inlineChars(block.content) + (block.citation?.length ?? 0);
    case 'code':
      return block.code.length + (block.language?.length ?? 0);
    case 'list':
      return itemStats(block.items).chars;
    case 'image':
      return (block.alt?.length ?? 0) + (block.caption?.length ?? 0);
    case 'gallery':
      return block.alt?.length ?? 0;
    case 'cta':
      return block.label.length;
    case 'embed':
    case 'divider':
      return 0;
  }
}

/**
 * Measure a document against the budget (`MAX_DOCUMENT_BYTES`, `MAX_BLOCKS`,
 * `MAX_BLOCK_CHARS`, `MAX_LIST_ITEMS`).
 *
 * @public
 */
export function measureRichText(document: RichTextDocument): RichTextMeasure {
  let maxBlockChars = 0;
  let maxListItems = 0;
  for (const block of document.blocks) {
    maxBlockChars = Math.max(maxBlockChars, blockChars(block));
    if (block.type === 'list') {
      maxListItems = Math.max(maxListItems, itemStats(block.items).count);
    }
  }
  const bytes = utf8Length(JSON.stringify(document));
  const blocks = document.blocks.length;
  return {
    bytes,
    blocks,
    maxBlockChars,
    maxListItems,
    withinBudget:
      bytes <= MAX_DOCUMENT_BYTES &&
      blocks <= MAX_BLOCKS &&
      maxBlockChars <= MAX_BLOCK_CHARS &&
      maxListItems <= MAX_LIST_ITEMS,
  };
}
