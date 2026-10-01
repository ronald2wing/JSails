/**
 * Markdown import for the blog content model: convert a CommonMark source
 * string into a validated {@link RichTextDocument}.
 *
 * ## Scope and policy
 *
 * The importer maps the common authoring constructs — paragraphs, headings
 * (h2..h6), bullet/ordered lists, blockquotes, fenced and indented code,
 * horizontal rules, and `media:<id>` images — onto the rich-text block kinds
 * ([`paragraph`], [`heading`], [`list`], [`quote`], [`code`], [`divider`],
 * [`image`]). Everything else is rejected with a value-free
 * {@link ContentError}; nothing is silently dropped.
 *
 * - **Headings** — h2..h6 map to [`heading`] blocks at their level. An h1 is
 *   rejected (`unsupported_construct`): level 1 is out of contract (headings
 *   are bounded to 2..6), and the document title already lives on the post/page
 *   beside the body, so an h1 in the body is authoring error rather than
 *   content to remap.
 * - **Inline content** is flattened to plain text: emphasis, strong, code
 *   spans, and strikethrough keep their text and drop the markers; links keep
 *   their label; soft line breaks join and hard breaks become a newline.
 * - **Images** — a paragraph that is a single image imports as an [`image`]
 *   block when its source is `media:<id>` (the id becomes `mediaId`; the alt
 *   text is preserved). A normal URL image is rejected rather than having an id
 *   invented for it, as is an image interleaved with other text or nested
 *   inside a heading, list item, or quote (those cannot be represented without
 *   lossy splitting).
 * - **Rejects** — tables, raw HTML blocks, inline HTML, and any other
 *   unsupported construct raise `unsupported_construct`.
 *
 * ## Output
 *
 * Blocks are assigned stable `block-N` ids in document order (N is the
 * zero-based block position), mirroring the editor reverse path's positional
 * id strategy. A list or blockquote contributes exactly one block with its own
 * `block-N` id at its position. The assembled document is validated through
 * {@link richTextSchema} before it is returned, so callers always receive a
 * schema-valid document or a thrown {@link ContentError}.
 */

import MarkdownIt, { type Token } from 'markdown-it';

import { richTextSchema, type RichTextBlock, type RichTextDocument } from 'jsails/rich-text';

import { ContentError } from './repository.js';

// ---------------------------------------------------------------------------
// Parsing engine
// ---------------------------------------------------------------------------

// `html: true` keeps raw HTML as distinct `html_block`/`html_inline` tokens so
// it can be rejected explicitly; with `html: false` markdown-it silently folds
// it into paragraph text, which would be an unannounced format change. Linkify
// stays off (a bare URL should import as text, not as a link whose label is the
// URL itself). Typographer is off so source text survives literally.
const md = new MarkdownIt({
  html: true,
  linkify: false,
  typographer: false,
});

/** Shared accumulator threaded through the recursive token walk. */
interface ConversionContext {
  blocks: RichTextBlock[];
}

// ---------------------------------------------------------------------------
// Inline flattening
// ---------------------------------------------------------------------------

/**
 * The plain text of an inline `children` array. Formatting markers drop, links
 * keep their label, and soft breaks join. Raises `unsupported_construct` on
 * inline raw HTML or an image: those are block-level concerns the caller must
 * route to the image path, never silently flattened.
 */
function inlineText(children: readonly Token[] | null, location: string): string {
  if (children === null) return '';
  let out = '';
  for (const token of children) {
    switch (token.type) {
      case 'text':
      case 'code_inline':
        out += token.content;
        break;
      case 'softbreak':
        out += ' ';
        break;
      case 'hardbreak':
        out += '\n';
        break;
      case 'em_open':
      case 'em_close':
      case 'strong_open':
      case 'strong_close':
      case 's_open':
      case 's_close':
      case 'link_open':
      case 'link_close':
        break;
      case 'image':
        throw new ContentError(
          'unsupported_construct',
          `markdown construct "image" cannot be imported inside ${location}`,
        );
      case 'html_inline':
        throw new ContentError(
          'unsupported_construct',
          `markdown construct "html inline" cannot be imported inside ${location}`,
        );
      default:
        break;
    }
  }
  return out;
}

/** The inline children of the paragraph/heading opened at `index`. */
function paragraphChildren(index: number, tokens: readonly Token[]): readonly Token[] | null {
  const token = tokens[index];
  if (token === undefined) return null;
  for (let i = index + 1; i < tokens.length; i++) {
    const next = tokens[i];
    if (next === undefined) continue;
    if (next.type === 'paragraph_close' || next.type === 'heading_close') break;
    if (next.type === 'inline' && next.level === token.level + 1) return next.children;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conversion entry
// ---------------------------------------------------------------------------

/**
 * Parse and convert markdown source to a validated rich-text document.
 *
 * @throws {ContentError} `invalid_input` for non-string input, or when the
 *   output exceeds the rich-text contract (for example a code body longer than
 *   the contract bound, or more blocks than the maximum).
 * @throws {ContentError} `unsupported_construct` for any construct the importer
 *   does not map.
 */
export function markdownToRichText(source: string): RichTextDocument {
  if (typeof source !== 'string') {
    throw new ContentError('invalid_input', 'markdown source must be a string');
  }

  const context: ConversionContext = { blocks: [] };
  convertBlocks(md.parse(source, {}), context);

  const result = richTextSchema.safeParse({ version: 1, blocks: context.blocks });
  if (!result.success) {
    throw new ContentError('invalid_input', 'markdown produced an invalid rich-text document');
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Block walk
// ---------------------------------------------------------------------------

/**
 * Walk the block token stream, converting each top-level construct in order via
 * {@link convertOne}. Unsupported constructs throw.
 */
function convertBlocks(tokens: readonly Token[], context: ConversionContext): void {
  let i = 0;
  while (i < tokens.length) {
    i = convertOne(i, tokens, context);
  }
}

/** Human-facing, source-free label for an unsupported token. */
function tokenTypeLabel(token: Token): string {
  switch (token.type) {
    case 'table_open':
      return 'table';
    case 'html_block':
      return 'html block';
    case 'heading_open':
      return token.tag === 'h1' ? 'h1' : token.tag;
    default:
      return token.type;
  }
}

/** The `unsupported_construct` error for a token. */
function unsupported(token: Token): ContentError {
  return new ContentError(
    'unsupported_construct',
    `markdown construct "${tokenTypeLabel(token)}" cannot be imported`,
  );
}

/**
 * Convert the construct starting at `index` into zero or more blocks, returning
 * the index one past the consumed tokens. Throws on unsupported constructs.
 */
function convertOne(index: number, tokens: readonly Token[], context: ConversionContext): number {
  const token = tokens[index];
  if (token === undefined) return index + 1;

  switch (token.type) {
    case 'paragraph_open': {
      const children = paragraphChildren(index, tokens);
      if (children === null) {
        push(context, { id: '', type: 'paragraph', text: '' });
        return skipToClose(index, tokens, 'paragraph_close');
      }
      // A paragraph that is a single image becomes an image block; a paragraph
      // with an image among other content is rejected (no lossless block split).
      if (children.length === 1 && children[0]?.type === 'image') {
        return convertImage(children[0], context, index, tokens);
      }
      push(context, { id: '', type: 'paragraph', text: inlineText(children, 'a paragraph') });
      return skipToClose(index, tokens, 'paragraph_close');
    }

    case 'heading_open': {
      const level = Number(token.tag.slice(1));
      if (level < 2) throw unsupported(token); // h1 is out of contract
      const children = paragraphChildren(index, tokens);
      push(context, {
        id: '',
        type: 'heading',
        level,
        text: children === null ? '' : inlineText(children, 'a heading'),
      });
      return skipToClose(index, tokens, 'heading_close');
    }

    case 'bullet_list_open':
    case 'ordered_list_open':
      return convertList(index, tokens, context);

    case 'blockquote_open':
      return convertQuote(index, tokens, context);

    case 'fence':
    case 'code_block': {
      const language = token.type === 'fence' ? languageFromInfo(token.info) : undefined;
      push(context, buildCode(token.content, language));
      return index + 1;
    }

    case 'hr':
      push(context, { id: '', type: 'divider' });
      return index + 1;

    // Any other block token — tables, raw HTML, stray closing/internals — is
    // unsupported and reported, never skipped.
    default:
      throw unsupported(token);
  }
}

// ---------------------------------------------------------------------------
// Paragraph / heading close skip
// ---------------------------------------------------------------------------

/** Index one past the matching close of the construct opened at `index`. */
function skipToClose(index: number, tokens: readonly Token[], closeType: string): number {
  const level = tokens[index]?.level;
  for (let i = index + 1; i < tokens.length; i++) {
    if (tokens[i]?.type === closeType && tokens[i]?.level === level) return i + 1;
  }
  return tokens.length;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * Convert a list container (opened at `index`) into a single [`list`] block,
 * consuming through its matching close. Nested lists are flattened into their
 * item text; any other nested block raises.
 */
function convertList(index: number, tokens: readonly Token[], context: ConversionContext): number {
  const open = tokens[index];
  if (open === undefined) return index + 1;
  const isOrdered = open.type === 'ordered_list_open';
  const closeType = isOrdered ? 'ordered_list_close' : 'bullet_list_close';
  const items: string[] = [];

  let i = index + 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) {
      i++;
      continue;
    }
    if (token.type === closeType && token.level === open.level) {
      i++;
      break;
    }
    if (token.type === 'list_item_open') {
      const [text, next] = listItemText(i + 1, tokens, token.level + 1);
      items.push(text);
      i = next;
      continue;
    }
    if (token.type === 'list_item_close') {
      i++;
      continue;
    }
    throw unsupported(token);
  }

  push(context, { id: '', type: 'list', style: isOrdered ? 'ordered' : 'unordered', items });
  return i;
}

/**
 * The plain text of a list item and the index one past its matching close.
 * Nested lists are flattened into the item's text.
 */
function listItemText(
  index: number,
  tokens: readonly Token[],
  itemLevel: number,
): readonly [string, number] {
  let text = '';
  let i = index;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) {
      i++;
      continue;
    }
    if (token.type === 'list_item_close' && token.level === itemLevel - 1) {
      return [text.trim(), i + 1];
    }
    if (token.type === 'inline' && token.level >= itemLevel) {
      text += inlineText(token.children, 'a list item');
    }
    i++;
  }
  return [text.trim(), i];
}

// ---------------------------------------------------------------------------
// Blockquotes
// ---------------------------------------------------------------------------

/**
 * Convert a blockquote into a single [`quote`] block (its paragraphs joined by
 * a space), consuming through its matching close.
 */
function convertQuote(index: number, tokens: readonly Token[], context: ConversionContext): number {
  const open = tokens[index];
  if (open === undefined) return index + 1;
  const parts: string[] = [];

  let i = index + 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) {
      i++;
      continue;
    }
    if (token.type === 'blockquote_close' && token.level === open.level) {
      i++;
      break;
    }
    // A blockquote body is a sequence of paragraphs; their open/close tokens
    // are scaffolding, not content, so skip them and collect each inline body.
    if (token.type === 'paragraph_open' || token.type === 'paragraph_close') {
      i++;
      continue;
    }
    if (token.type === 'inline' && token.level > open.level) {
      parts.push(inlineText(token.children, 'a blockquote'));
      i++;
      continue;
    }
    throw unsupported(token);
  }

  push(context, { id: '', type: 'quote', text: parts.join(' ').trim() });
  return i;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Convert a standalone image token into an [`image`] block and skip the
 * enclosing paragraph close. Rejects a non-`media:` source instead of inventing
 * an id.
 */
function convertImage(
  image: Token,
  context: ConversionContext,
  index: number,
  tokens: readonly Token[],
): number {
  const source = image.attrGet('src');
  if (typeof source !== 'string' || !source.startsWith('media:')) {
    throw new ContentError(
      'unsupported_construct',
      'markdown image must use a "media:<id>" reference',
    );
  }
  const mediaId = source.slice('media:'.length);
  if (mediaId === '') {
    throw new ContentError(
      'unsupported_construct',
      'markdown image must use a "media:<id>" reference',
    );
  }
  // markdown-it stores the alt text in the image token's `content` (the `alt`
  // attribute is left empty); the alt text is read from there, not `attrGet`.
  const alt = image.content.trim();
  push(context, {
    id: '',
    type: 'image',
    mediaId,
    ...(alt === '' ? {} : { alt }),
  });
  return skipToClose(index, tokens, 'paragraph_close');
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

/** Build a code block from its literal body and optional language tag. */
function buildCode(code: string, language: string | undefined): RichTextBlock {
  return {
    id: '',
    type: 'code',
    code,
    ...(language === undefined ? {} : { language }),
  };
}

/** The first word of a fence info string is the language; extra info is ignored. */
function languageFromInfo(info: string): string | undefined {
  const word = info.trim().split(/\s+/)[0];
  return word === undefined || word === '' ? undefined : word;
}

// ---------------------------------------------------------------------------
// Id assignment
// ---------------------------------------------------------------------------

/** The next positional block id (`block-N`), stable under re-conversion. */
function nextId(context: ConversionContext): string {
  return `block-${context.blocks.length}`;
}

/**
 * Append a block, filling in its positional id. The block object carries its
 * `type` discriminator; `id` (the placeholder `''`) is overwritten with the
 * positional id so each variant type-checks against its exact union member.
 */
function push(context: ConversionContext, block: RichTextBlock): void {
  context.blocks.push({ ...block, id: nextId(context) });
}
