/**
 * The canonical form of a rich-text document: the one spelling of its content
 * that a store holds, so two documents with the same content are equal as
 * JSON and an editor's codec can promise `decode(encode(d))` equals `d`.
 *
 * Canonical means, beyond what the schema already requires:
 *
 * - no run with empty text;
 * - a run's `marks` is absent or non-empty, without duplicates, sorted in
 *   {@link INLINE_MARKS} order, and `['code']` alone when it holds `code`;
 * - no two adjacent runs share both marks and href (they are one run);
 * - an empty optional string (`citation`, `language`, `alt`, `caption`) is
 *   absent, and so is an empty `children` list;
 * - every item of a `task` list carries `checked`, and items of other lists
 *   never do;
 * - no list without items and no gallery without media.
 *
 * Writers call {@link normalizeRichText} before storing; `parseRichText`
 * refuses anything not already canonical, so a reader never repairs data.
 */

import {
  INLINE_MARKS,
  type InlineContent,
  type InlineMark,
  type InlineRun,
  type ListItem,
  type ListStyle,
  type RichTextBlock,
  type RichTextDocument,
} from './document.js';

const MARK_ORDER: ReadonlyMap<InlineMark, number> = new Map(
  INLINE_MARKS.map((mark, index) => [mark, index]),
);

function canonicalMarks(marks: readonly InlineMark[] | undefined): readonly InlineMark[] {
  if (marks === undefined || marks.length === 0) {
    return [];
  }
  if (marks.includes('code')) {
    return ['code'];
  }
  return [...new Set(marks)].sort((a, b) => (MARK_ORDER.get(a) ?? 0) - (MARK_ORDER.get(b) ?? 0));
}

function sameMarks(a: readonly InlineMark[], b: readonly InlineMark[]): boolean {
  return a.length === b.length && a.every((mark, index) => mark === b[index]);
}

function run(text: string, marks: readonly InlineMark[], href: InlineRun['href']): InlineRun {
  return {
    text,
    ...(marks.length === 0 ? {} : { marks }),
    ...(href === undefined ? {} : { href }),
  };
}

function normalizeInline(content: InlineContent): InlineContent {
  const out: InlineRun[] = [];
  for (const current of content) {
    if (current.text === '') {
      continue;
    }
    const marks = canonicalMarks(current.marks);
    const previous = out.at(-1);
    if (
      previous !== undefined &&
      previous.href === current.href &&
      sameMarks(previous.marks ?? [], marks)
    ) {
      out[out.length - 1] = run(previous.text + current.text, marks, current.href);
      continue;
    }
    out.push(run(current.text, marks, current.href));
  }
  return out;
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined || value === '' ? {} : { [key]: value }) as { [P in K]?: string };
}

function normalizeItems(items: readonly ListItem[], style: ListStyle): readonly ListItem[] {
  return items.map((item) => {
    const children = item.children === undefined ? [] : normalizeItems(item.children, style);
    return {
      content: normalizeInline(item.content),
      ...(style === 'task' ? { checked: item.checked === true } : {}),
      ...(children.length === 0 ? {} : { children }),
    };
  });
}

function normalizeBlock(block: RichTextBlock): RichTextBlock | undefined {
  switch (block.type) {
    case 'paragraph':
      return { type: 'paragraph', content: normalizeInline(block.content) };
    case 'heading':
      return { type: 'heading', level: block.level, content: normalizeInline(block.content) };
    case 'quote':
      return {
        type: 'quote',
        content: normalizeInline(block.content),
        ...optional('citation', block.citation),
      };
    case 'callout':
      return { type: 'callout', tone: block.tone, content: normalizeInline(block.content) };
    case 'code':
      return { type: 'code', code: block.code, ...optional('language', block.language) };
    case 'list':
      return block.items.length === 0
        ? undefined
        : { type: 'list', style: block.style, items: normalizeItems(block.items, block.style) };
    case 'image':
      return {
        type: 'image',
        mediaId: block.mediaId,
        ...optional('alt', block.alt),
        ...optional('caption', block.caption),
      };
    case 'gallery':
      return block.mediaIds.length === 0
        ? undefined
        : { type: 'gallery', mediaIds: [...block.mediaIds], ...optional('alt', block.alt) };
    case 'embed':
      return { type: 'embed', url: block.url };
    case 'cta':
      return { type: 'cta', label: block.label, href: block.href };
    case 'divider':
      return { type: 'divider' };
  }
}

/**
 * The canonical form of a schema-valid document. Pure and idempotent; the
 * result holds no reference to the input's arrays or objects.
 *
 * @public
 */
export function normalizeRichText(document: RichTextDocument): RichTextDocument {
  const blocks: RichTextBlock[] = [];
  for (const block of document.blocks) {
    const normalized = normalizeBlock(block);
    if (normalized !== undefined) {
      blocks.push(normalized);
    }
  }
  return { version: document.version, blocks };
}

/**
 * Structural equality of JSON values. Object key order is ignored, because
 * it carries no meaning in JSON and some stores (PostgreSQL `jsonb`) reorder
 * keys; a key holding `undefined` counts as absent.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    );
  }
  const left = a as Readonly<Record<string, unknown>>;
  const right = b as Readonly<Record<string, unknown>>;
  const keys = (record: Readonly<Record<string, unknown>>): string[] =>
    Object.keys(record).filter((key) => record[key] !== undefined);
  const leftKeys = keys(left);
  return (
    leftKeys.length === keys(right).length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
  );
}

/**
 * The path of the first block that differs from its canonical form, or
 * `undefined` when the document is canonical. A dropped block (an empty list
 * or gallery) shifts every later index, so the comparison stops there.
 */
export function firstNonCanonicalPath(
  document: RichTextDocument,
): readonly (string | number)[] | undefined {
  for (let index = 0; index < document.blocks.length; index += 1) {
    const block = document.blocks[index] as RichTextBlock;
    if (!jsonEqual(normalizeBlock(block), block)) {
      return ['blocks', index];
    }
  }
  return undefined;
}
