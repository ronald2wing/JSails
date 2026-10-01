/**
 * The plain-text alternative derived from a rendered mail's HTML.
 *
 * The input is Preact's own output, so it is well formed: every `<` and `&` in
 * text is an entity, and attribute values are double-quoted with `"`, `<`, and
 * `&` escaped. A `>` may still appear inside a quoted value, so a tag is
 * matched as `<` followed by unquoted characters or whole quoted values up to
 * the first unquoted `>`, without a parser. Whitespace is collapsed the way a
 * browser would, block elements and `<br>` become line breaks, list items get
 * a `- ` marker, and a link keeps its target in parentheses so the text part
 * still carries it. `<head>`, `<style>`, `<script>`, and `<title>` content is
 * dropped. Entities are decoded last, once, so an escaped `&lt;b&gt;` stays
 * the literal text `<b>`.
 */

/** The inside of a tag after its name: unquoted characters or quoted values. */
const ATTRS = String.raw`(?:[^>"]|"[^"]*")*`;

/** Elements whose content is never part of the readable text. */
const HIDDEN_BLOCKS = new RegExp(
  String.raw`<(head|style|script|title)\b${ATTRS}>[\s\S]*?<\/\1\s*>`,
  'gi',
);

/** An anchor with a double-quoted href, as Preact renders it. */
const ANCHOR = new RegExp(
  String.raw`<a\b(?:[^>"]|"[^"]*")*?\shref="([^"]*)"${ATTRS}>([\s\S]*?)<\/a\s*>`,
  'gi',
);

/** Tags that start or end a block of text. */
const BLOCK_TAG = new RegExp(
  String.raw`<\/?(?:p|div|h[1-6]|ul|ol|table|thead|tbody|tfoot|blockquote|section|article|header|footer|main|nav|aside|pre|hr|center)\b${ATTRS}>`,
  'gi',
);

/** A line break. */
const BREAK = new RegExp(String.raw`<br\b${ATTRS}>`, 'gi');

/** A list item start, which gets a `- ` marker on a new line. */
const LIST_ITEM = new RegExp(String.raw`<li\b${ATTRS}>`, 'gi');

/** A table cell end: cells of one row are separated by a space. */
const CELL_END = /<\/(?:td|th)\s*>/gi;

/** A row end: one line per table row. */
const ROW_END = /<\/tr\s*>/gi;

/** Any other tag. */
const TAG = new RegExp(String.raw`<${ATTRS}>`, 'g');

/** The named entities Preact emits, plus the common ones a raw string may carry. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode numeric and the known named entities; leave anything else as written. */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

/** Derive readable plain text from rendered mail HTML. */
export function htmlToText(html: string): string {
  const text = html
    .replace(HIDDEN_BLOCKS, '')
    .replace(/\s+/g, ' ')
    .replace(ANCHOR, (_match, href: string, inner: string) => {
      const label = inner.replace(TAG, '').trim();
      const target = href.trim();
      if (
        target === '' ||
        target.startsWith('#') ||
        decodeEntities(label) === decodeEntities(target)
      ) {
        return inner;
      }
      return `${inner} (${target})`;
    })
    .replace(BREAK, '\n')
    .replace(LIST_ITEM, '\n- ')
    .replace(CELL_END, ' ')
    .replace(ROW_END, '\n')
    .replace(BLOCK_TAG, '\n')
    .replace(TAG, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
