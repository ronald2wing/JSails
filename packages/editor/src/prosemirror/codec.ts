/**
 * The codec between the `jsails/rich-text` model and the editor schema.
 *
 * {@link encode} turns any schema-valid document into the JSON of an editor
 * document (normalising it first, so a non-canonical document encodes to its
 * canonical content); `richTextEditorSchema.nodeFromJSON` builds the node and
 * its attribute validation re-checks every URL and text attribute. For every
 * canonical document `decode(nodeFromJSON(encode(d)))` equals `d`, and the
 * JSON is exactly what the built node's `toJSON()` returns.
 *
 * {@link decode} is total over the editor's documents: run text is brought
 * within the model's character rules (`text-rules.ts`), a `hard_break` is a
 * run's `\n`, marks and link come from the node's marks, and each block is
 * normalised, so the result is canonical. Size is not decode's concern: the
 * limits plugin keeps the state within budget. In development and test
 * builds `decode` reads its own output back through `parseRichText` and
 * throws `rich_text_editor.decode_refused` on any issue but a budget one.
 *
 * Decoded blocks are cached by node identity and frozen. A ProseMirror node is
 * immutable and a transaction shares every untouched block with the previous
 * document, so decoding after an edit re-decodes only the blocks it changed.
 */

import type { Mark, Node as ProseMirrorNode } from 'prosemirror-model';

import {
  normalizeRichText,
  parseRichText,
  RICH_TEXT_VERSION,
  type CalloutTone,
  type EmbedUrl,
  type HeadingLevel,
  type InlineContent,
  type InlineMark,
  type InlineRun,
  type LinkHref,
  type ListItem,
  type ListStyle,
  type RichTextBlock,
  type RichTextDocument,
  type RichTextIssue,
} from 'jsails/rich-text';

import { RichTextEditorErrors } from './editor-errors.js';
import { LIST_ITEM_NODES, LIST_NODES, richTextEditorSchema } from './schema.js';
import { cleanCodeText, cleanerFor } from './text-rules.js';

/**
 * The JSON of an editor mark, as `Mark.toJSON` writes it.
 */
export interface ProseMirrorMarkJSON {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

/**
 * The JSON of an editor node, as `Node.toJSON` writes it and
 * `Schema.nodeFromJSON` reads it.
 */
export interface ProseMirrorNodeJSON {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly ProseMirrorNodeJSON[];
  readonly marks?: readonly ProseMirrorMarkJSON[];
  readonly text?: string;
}

const notADocument: RichTextIssue = Object.freeze({
  path: [],
  code: 'invalid_type',
  message: 'node is not a document of the rich-text editor schema',
});

const tooDeep: RichTextIssue = Object.freeze({
  path: [],
  code: 'invalid_type',
  message: 'list items nest deeper than the model allows',
});

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

function node(
  type: string,
  attrs: Readonly<Record<string, unknown>> | undefined,
  content: readonly ProseMirrorNodeJSON[],
): ProseMirrorNodeJSON {
  return {
    type,
    ...(attrs === undefined ? {} : { attrs }),
    ...(content.length === 0 ? {} : { content }),
  };
}

function runMarks(run: InlineRun): readonly ProseMirrorMarkJSON[] {
  return [
    ...(run.href === undefined ? [] : [{ type: 'link', attrs: { href: run.href } }]),
    ...(run.marks ?? []).map((type) => ({ type })),
  ];
}

function encodeInline(content: InlineContent): ProseMirrorNodeJSON[] {
  const out: ProseMirrorNodeJSON[] = [];
  for (const run of content) {
    const marks = runMarks(run);
    const marked = marks.length === 0 ? {} : { marks };
    run.text.split('\n').forEach((part, index) => {
      if (index > 0) {
        out.push({ type: 'hard_break', ...marked });
      }
      if (part !== '') {
        out.push({ type: 'text', ...marked, text: part });
      }
    });
  }
  return out;
}

function encodeItem(item: ListItem, depth: 0 | 1 | 2, style: ListStyle): ProseMirrorNodeJSON {
  const children = item.children ?? [];
  const content = [node('paragraph', undefined, encodeInline(item.content))];
  if (children.length > 0) {
    if (depth === 2) {
      // The model's schema stops at three levels; only an unparsed value gets here.
      throw new RichTextEditorErrors.Error(
        'invalid_document',
        {},
        { payload: { issues: [tooDeep] } },
      );
    }
    const next = depth === 0 ? 1 : 2;
    content.push(
      node(
        LIST_NODES[next],
        undefined,
        children.map((child) => encodeItem(child, next, style)),
      ),
    );
  }
  return node(
    LIST_ITEM_NODES[depth],
    { checked: style === 'task' && item.checked === true },
    content,
  );
}

function encodeBlock(block: RichTextBlock): ProseMirrorNodeJSON {
  switch (block.type) {
    case 'paragraph':
      return node('paragraph', undefined, encodeInline(block.content));
    case 'heading':
      return node('heading', { level: block.level }, encodeInline(block.content));
    case 'quote':
      return node('quote', { citation: block.citation ?? '' }, encodeInline(block.content));
    case 'callout':
      return node('callout', { tone: block.tone }, encodeInline(block.content));
    case 'code':
      return node(
        'code_block',
        { language: block.language ?? '' },
        block.code === '' ? [] : [{ type: 'text', text: block.code }],
      );
    case 'list':
      return node(
        'list',
        { style: block.style },
        block.items.map((item) => encodeItem(item, 0, block.style)),
      );
    case 'image':
      return node(
        'image',
        { mediaId: block.mediaId, alt: block.alt ?? '', caption: block.caption ?? '' },
        [],
      );
    case 'gallery':
      return node('gallery', { mediaIds: [...block.mediaIds], alt: block.alt ?? '' }, []);
    case 'embed':
      return node('embed', { url: block.url }, []);
    case 'cta':
      return node('cta', { label: block.label, href: block.href }, []);
    case 'divider':
      return node('divider', undefined, []);
  }
}

/**
 * The editor JSON of a schema-valid document, built from its canonical form.
 * Pass the result to `richTextEditorSchema.nodeFromJSON`, which validates
 * every attribute again.
 */
export function encode(document: RichTextDocument): ProseMirrorNodeJSON {
  return node('doc', undefined, normalizeRichText(document).blocks.map(encodeBlock));
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const field of Object.values(value)) {
      freeze(field);
    }
    Object.freeze(value);
  }
  return value;
}

function runOf(text: string, marks: readonly Mark[]): InlineRun {
  let href: LinkHref | undefined;
  const names: InlineMark[] = [];
  for (const mark of marks) {
    if (mark.type.name === 'link') {
      href = mark.attrs.href as LinkHref;
    } else {
      names.push(mark.type.name as InlineMark);
    }
  }
  return {
    text,
    ...(names.length === 0 ? {} : { marks: names }),
    ...(href === undefined ? {} : { href }),
  };
}

function decodeInline(block: ProseMirrorNode): InlineContent {
  const clean = cleanerFor(block.type.name);
  const runs: InlineRun[] = [];
  block.forEach((child) => {
    runs.push(runOf(child.isText ? clean(child.text ?? '') : '\n', child.marks));
  });
  return runs;
}

function decodeItems(list: ProseMirrorNode, style: ListStyle): ListItem[] {
  const items: ListItem[] = [];
  list.forEach((item) => {
    const paragraph = item.firstChild;
    const nested = item.childCount > 1 ? item.lastChild : null;
    items.push({
      content: paragraph === null ? [] : decodeInline(paragraph),
      ...(style === 'task' ? { checked: item.attrs.checked === true } : {}),
      ...(nested === null ? {} : { children: decodeItems(nested, style) }),
    });
  });
  return items;
}

function optional<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  return (typeof value === 'string' && value !== '' ? { [key]: value } : {}) as {
    [P in K]?: string;
  };
}

function decodeRawBlock(block: ProseMirrorNode): RichTextBlock {
  const attrs = block.attrs;
  switch (block.type.name) {
    case 'heading':
      return { type: 'heading', level: attrs.level as HeadingLevel, content: decodeInline(block) };
    case 'quote':
      return {
        type: 'quote',
        content: decodeInline(block),
        ...optional('citation', attrs.citation),
      };
    case 'callout':
      return { type: 'callout', tone: attrs.tone as CalloutTone, content: decodeInline(block) };
    case 'code_block':
      return {
        type: 'code',
        code: cleanCodeText(block.textContent),
        ...optional('language', attrs.language),
      };
    case 'list': {
      const style = attrs.style as ListStyle;
      return { type: 'list', style, items: decodeItems(block, style) };
    }
    case 'image':
      return {
        type: 'image',
        mediaId: attrs.mediaId as string,
        ...optional('alt', attrs.alt),
        ...optional('caption', attrs.caption),
      };
    case 'gallery':
      return {
        type: 'gallery',
        mediaIds: [...(attrs.mediaIds as readonly string[])],
        ...optional('alt', attrs.alt),
      };
    case 'embed':
      return { type: 'embed', url: attrs.url as EmbedUrl };
    case 'cta':
      return { type: 'cta', label: attrs.label as string, href: attrs.href as LinkHref };
    case 'divider':
      return { type: 'divider' };
    default:
      return { type: 'paragraph', content: decodeInline(block) };
  }
}

const decodedBlocks = new WeakMap<ProseMirrorNode, RichTextBlock | null>();

/** The canonical, frozen model block of an editor block (`null` when canonical form drops it). */
function decodeBlock(block: ProseMirrorNode): RichTextBlock | null {
  const cached = decodedBlocks.get(block);
  if (cached !== undefined) {
    return cached;
  }
  const normalized =
    normalizeRichText({ version: RICH_TEXT_VERSION, blocks: [decodeRawBlock(block)] }).blocks[0] ??
    null;
  const frozen = freeze(normalized);
  decodedBlocks.set(block, frozen);
  return frozen;
}

/**
 * {@link decode} without the development-build check: what the limits plugin
 * measures on every transaction.
 */
export function decodeUnchecked(doc: ProseMirrorNode): RichTextDocument {
  if (doc.type !== richTextEditorSchema.topNodeType) {
    throw new RichTextEditorErrors.Error(
      'invalid_document',
      {},
      { payload: { issues: [notADocument] } },
    );
  }
  const blocks: RichTextBlock[] = [];
  doc.forEach((child) => {
    const block = decodeBlock(child);
    if (block !== null) {
      blocks.push(block);
    }
  });
  return { version: RICH_TEXT_VERSION, blocks };
}

/** Issue codes that only say a document is over budget. */
const BUDGET_CODES: ReadonlySet<string> = new Set([
  'too_large',
  'too_many_blocks',
  'block_too_long',
  'too_many_list_items',
]);

/**
 * True in development and test builds. A bundler replaces
 * `process.env.NODE_ENV` in a production build; a browser that never defines
 * `process` throws on the access, which counts as production.
 */
function checksEnabled(): boolean {
  try {
    return process.env.NODE_ENV !== 'production';
  } catch {
    // `process` (or its `env`) does not exist here: a browser build without the replacement.
    return false;
  }
}

/**
 * The canonical model document of an editor document. Total over documents
 * of `richTextEditorSchema`; anything else throws
 * `rich_text_editor.invalid_document`.
 */
export function decode(doc: ProseMirrorNode): RichTextDocument {
  const document = decodeUnchecked(doc);
  if (checksEnabled()) {
    const result = parseRichText(document);
    if (!result.ok && result.issues.some((issue) => !BUDGET_CODES.has(issue.code))) {
      throw new RichTextEditorErrors.Error(
        'decode_refused',
        {},
        { payload: { issues: result.issues } },
      );
    }
  }
  return document;
}
