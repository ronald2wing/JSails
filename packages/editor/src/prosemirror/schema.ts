/**
 * The ProseMirror schema of the rich-text editor, mirroring the
 * `jsails/rich-text` model node for node, so the editor state can hold exactly
 * the documents the model accepts and nothing else.
 *
 * - Every model block is a node in the `block` group (`code` is `code_block`,
 *   since node and mark names share one namespace); the top node is `doc`
 *   with `block*`, so the empty document is representable.
 * - Text is `text` plus `hard_break` (a `\n` of a run). Headings hold `text*`,
 *   because a heading run may not contain `\n`; code holds unmarked `text*`,
 *   where `\n` and `\t` are literal.
 * - A list is one node type per depth (`list` > `list_item` > `list_2` >
 *   `list_item_2` > `list_3` > `list_item_3`), so the depth bound and the rule
 *   that nested items belong to the root list's style are structural: only
 *   the root `list` carries `style`, and no fourth level exists.
 * - Marks are `link` (its `href` is the run's href) and `bold`, `italic`,
 *   `strike`, `code` in the model's canonical order; `code` excludes the other
 *   three, as a canonical run's marks do, and coexists with `link`.
 * - Every attribute validates with the model's own rules: links and embeds
 *   with `isLinkHref` and `isEmbedUrl`, level, tone and style against the
 *   model's vocabularies, and every text attribute by parsing a probe block
 *   through `richTextSchema`. A refused value throws
 *   `rich_text_editor.invalid_attribute` from node or mark creation, so
 *   `nodeFromJSON`, a step and a command cannot produce one; the DOM parse
 *   rules test the same predicates and skip a refused value instead, so a
 *   pasted `javascript:` link arrives as plain text.
 *
 * Two rules span more than one node, so a schema cannot hold them and a
 * plugin keeps them in the state: `text-rules.ts` keeps run text within the
 * model's character rules (a line break in a heading becomes a space), and
 * `task-items.ts` keeps `checked` to the items of task lists.
 */

import {
  DOMParser as ProseMirrorDOMParser,
  DOMSerializer as ProseMirrorDOMSerializer,
  Fragment,
  Schema,
  type AttributeSpec,
  type Attrs,
  type DOMOutputSpec,
  type MarkSpec,
  type Node as ProseMirrorNode,
  type NodeSpec,
  type NodeType,
  type TagParseRule,
} from 'prosemirror-model';

import {
  CALLOUT_TONES,
  LIST_STYLES,
  MAX_HEADING_LEVEL,
  MAX_LIST_DEPTH,
  MIN_HEADING_LEVEL,
  RICH_TEXT_VERSION,
  isEmbedUrl,
  isLinkHref,
  richTextSchema,
  type InlineMark,
  type RichTextBlockType,
} from 'jsails/rich-text';

import { RichTextEditorErrors } from './editor-errors.js';

/** The node type names of {@link richTextEditorSchema}. */
export type RichTextNodeName =
  | 'doc'
  | 'paragraph'
  | 'heading'
  | 'quote'
  | 'callout'
  | 'code_block'
  | 'list'
  | 'list_item'
  | 'list_2'
  | 'list_item_2'
  | 'list_3'
  | 'list_item_3'
  | 'image'
  | 'gallery'
  | 'embed'
  | 'cta'
  | 'divider'
  | 'text'
  | 'hard_break';

/** The mark type names of {@link richTextEditorSchema}. */
export type RichTextMarkName = 'link' | InlineMark;

/**
 * The node each model block becomes. Typed over every model block type, so a
 * block added to the model fails to compile here until the schema has it.
 */
export const BLOCK_NODES: Readonly<Record<RichTextBlockType, RichTextNodeName>> = Object.freeze({
  paragraph: 'paragraph',
  heading: 'heading',
  quote: 'quote',
  callout: 'callout',
  code: 'code_block',
  list: 'list',
  image: 'image',
  gallery: 'gallery',
  embed: 'embed',
  cta: 'cta',
  divider: 'divider',
});

/** List node names by depth (index 0 is the root list). */
export const LIST_NODES: readonly ['list', 'list_2', 'list_3'] = ['list', 'list_2', 'list_3'];

/** List item node names by depth (index 0 is an item of the root list). */
export const LIST_ITEM_NODES: readonly ['list_item', 'list_item_2', 'list_item_3'] = [
  'list_item',
  'list_item_2',
  'list_item_3',
];

// ---------------------------------------------------------------------------
// Attribute rules
// ---------------------------------------------------------------------------

type Predicate = (value: unknown) => boolean;

/** True when the model's schema accepts a document holding exactly `block`. */
function modelAccepts(block: Readonly<Record<string, unknown>>): boolean {
  return richTextSchema.safeParse({ version: RICH_TEXT_VERSION, blocks: [block] }).success;
}

/** A text attribute the model accepts in the block `probe` builds around it. */
function textRule(probe: (value: string) => Readonly<Record<string, unknown>>): Predicate {
  return (value) => typeof value === 'string' && modelAccepts(probe(value));
}

function memberRule(members: readonly unknown[]): Predicate {
  return (value) => members.includes(value);
}

const isLevel: Predicate = (value) =>
  Number.isInteger(value) &&
  (value as number) >= MIN_HEADING_LEVEL &&
  (value as number) <= MAX_HEADING_LEVEL;

const isBoolean: Predicate = (value) => typeof value === 'boolean';

const isHref: Predicate = (value) => typeof value === 'string' && isLinkHref(value);

/**
 * The model's rule for every attribute, keyed by node or mark name and then
 * attribute name. The DOM parse rules and the attribute validators both read
 * this table, so parsing and construction refuse the same values.
 */
export const ATTRIBUTE_RULES: Readonly<Record<string, Readonly<Record<string, Predicate>>>> =
  Object.freeze({
    heading: { level: isLevel },
    quote: { citation: textRule((citation) => ({ type: 'quote', content: [], citation })) },
    callout: { tone: memberRule(CALLOUT_TONES) },
    code_block: { language: textRule((language) => ({ type: 'code', code: '', language })) },
    list: { style: memberRule(LIST_STYLES) },
    list_item: { checked: isBoolean },
    list_item_2: { checked: isBoolean },
    list_item_3: { checked: isBoolean },
    image: {
      mediaId: textRule((mediaId) => ({ type: 'image', mediaId })),
      alt: textRule((alt) => ({ type: 'image', mediaId: 'm', alt })),
      caption: textRule((caption) => ({ type: 'image', mediaId: 'm', caption })),
    },
    gallery: {
      // A gallery without media is not canonical, so the state cannot hold one.
      mediaIds: (value) =>
        Array.isArray(value) &&
        value.length > 0 &&
        modelAccepts({ type: 'gallery', mediaIds: value }),
      alt: textRule((alt) => ({ type: 'gallery', mediaIds: ['m'], alt })),
    },
    embed: { url: (value) => typeof value === 'string' && isEmbedUrl(value) },
    cta: {
      label: textRule((label) => ({ type: 'cta', label, href: '/' })),
      href: isHref,
    },
    link: { href: isHref },
  });

/** True when the model accepts `value` as attribute `attribute` of `owner`. */
export function acceptsAttribute(owner: string, attribute: string, value: unknown): boolean {
  const rule = ATTRIBUTE_RULES[owner]?.[attribute];
  return rule !== undefined && rule(value);
}

/** An attribute spec whose validation is the model's rule for it. */
function attribute(owner: string, name: string, fallback?: unknown): AttributeSpec {
  const validate = (value: unknown): void => {
    if (!acceptsAttribute(owner, name, value)) {
      throw new RichTextEditorErrors.Error('invalid_attribute', { owner, attribute: name });
    }
  };
  return fallback === undefined ? { validate } : { default: fallback, validate };
}

/** The value of a DOM attribute when the model accepts it for `owner.name`. */
function domAttribute(
  dom: HTMLElement,
  owner: string,
  name: string,
  domName: string,
): string | undefined {
  const value = dom.getAttribute(domName);
  return value !== null && acceptsAttribute(owner, name, value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * The lines of `content`, in order: the content of each textblock, and each
 * run of inline nodes outside one (a slice keeps the inline content before
 * its first block at its top level, not in a paragraph).
 */
function inlineLines(content: Fragment, lines: ProseMirrorNode[][]): void {
  let loose: ProseMirrorNode[] | undefined;
  content.forEach((node) => {
    if (node.isInline) {
      if (loose === undefined) {
        loose = [];
        lines.push(loose);
      }
      loose.push(node);
      return;
    }
    loose = undefined;
    if (node.isTextblock) {
      const line: ProseMirrorNode[] = [];
      node.forEach((child) => {
        line.push(child);
      });
      lines.push(line);
    } else {
      inlineLines(node.content, lines);
    }
  });
}

/**
 * The inline content the children of `dom` parse to, as one run: its lines
 * are joined by hard breaks, and a code block's `\n` becomes one too. A
 * quote, a callout and a list item's paragraph are each a single run, while
 * pasted HTML usually wraps its text in paragraphs; parsing those as blocks
 * would split the block apart.
 */
function flattenInline(dom: Node, schema: Schema): Fragment {
  const lines: ProseMirrorNode[][] = [];
  inlineLines(ProseMirrorDOMParser.fromSchema(schema).parseSlice(dom).content, lines);
  const hardBreak = schema.nodes.hard_break as NodeType;
  const nodes: ProseMirrorNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) {
      nodes.push(hardBreak.create());
    }
    for (const node of line) {
      if (!node.isText) {
        nodes.push(node);
        continue;
      }
      (node.text ?? '').split('\n').forEach((part, partIndex) => {
        if (partIndex > 0) {
          nodes.push(hardBreak.create(null, null, node.marks));
        }
        if (part !== '') {
          nodes.push(schema.text(part, node.marks));
        }
      });
    }
  });
  return Fragment.from(nodes);
}

/** Elements that start a block of their own in pasted HTML. */
const BLOCK_ELEMENTS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'DL',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'LI',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'UL',
]);

function isBlockElement(node: Node): node is HTMLElement {
  return node.nodeType === 1 && BLOCK_ELEMENTS.has(node.nodeName);
}

function hasBlockChildren(dom: HTMLElement): boolean {
  return Array.from(dom.childNodes).some(isBlockElement);
}

/** True for a node that adds nothing to a line: a comment or whitespace-only text. */
function isBlank(node: Node): boolean {
  return node.nodeType === 8 || (node.nodeType === 3 && /^\s*$/.test(node.nodeValue ?? ''));
}

/**
 * True when `nodes` already parse to a single run: inline content only, or
 * one `<p>` (the shape this schema serializes an item's paragraph as).
 */
function isSingleRun(nodes: readonly Node[]): boolean {
  const content = nodes.filter((node) => !isBlank(node));
  return !content.some(isBlockElement) || (content.length === 1 && content[0]?.nodeName === 'P');
}

/**
 * The element a list item parses its content from. A model item is one
 * paragraph and then at most a nested list, so the item itself serves when
 * the content before its first nested list is a single run. Otherwise, as in
 * a "loose" list of several paragraphs per item, the item is read from a copy
 * whose content before the nested list is one `<p>` holding
 * {@link flattenInline} of it, written back as the markup this schema
 * serializes; the parser would otherwise turn each further paragraph into a
 * nested item, or a sibling at the deepest level. The nested list and what
 * follows it are left to the parser, which reads them in the item's context;
 * so the text keeps its order.
 */
function itemContent(node: Node): HTMLElement {
  const dom = node as HTMLElement;
  const children = Array.from(dom.childNodes);
  const nested = children.findIndex((child) => child.nodeName === 'UL' || child.nodeName === 'OL');
  const leading = nested < 0 ? children : children.slice(0, nested);
  if (isSingleRun(leading)) {
    return dom;
  }
  const document = dom.ownerDocument;
  const holder = document.createElement('div');
  holder.append(...leading.map((child) => child.cloneNode(true)));
  const paragraph = document.createElement('p');
  paragraph.append(
    ProseMirrorDOMSerializer.fromSchema(richTextEditorSchema).serializeFragment(
      flattenInline(holder, richTextEditorSchema),
      { document },
    ),
  );
  const copy = dom.cloneNode(false) as HTMLElement;
  copy.append(paragraph, ...children.slice(leading.length).map((child) => child.cloneNode(true)));
  return copy;
}

function quoteAttrs(dom: HTMLElement): Attrs {
  return { citation: domAttribute(dom, 'quote', 'citation', 'data-citation') ?? '' };
}

function calloutAttrs(dom: HTMLElement): Attrs {
  return { tone: domAttribute(dom, 'callout', 'tone', 'data-tone') ?? 'info' };
}

/** The language named by a `language-*` class, as Markdown renderers emit it. */
function classLanguage(dom: HTMLElement): string | null {
  const code = dom.querySelector('code');
  const match = /(?:^|\s)language-(\S+)/.exec(code?.className ?? dom.className);
  return match?.[1] ?? null;
}

function listStyleOf(dom: HTMLElement): Attrs {
  const declared = domAttribute(dom, 'list', 'style', 'data-list-style');
  if (declared !== undefined) {
    return { style: declared };
  }
  // GitHub-flavoured Markdown renders task lists as `ul.contains-task-list`.
  return { style: dom.classList.contains('contains-task-list') ? 'task' : 'unordered' };
}

function checkedOf(dom: HTMLElement): Attrs {
  if (dom.getAttribute('data-checked') === 'true') {
    return { checked: true };
  }
  // A Markdown task item starts with a checkbox, directly or in its first paragraph.
  const first = dom.firstElementChild;
  const box = first?.tagName === 'P' ? first.firstElementChild : first;
  return {
    checked:
      box?.tagName === 'INPUT' &&
      box.getAttribute('type') === 'checkbox' &&
      box.hasAttribute('checked'),
  };
}

/**
 * Parse rules of a nested list level: the list element and its items map to
 * the node types of `depth`, matched only inside an item one level up (or
 * that item's open paragraph, which inline content before the nested list
 * leaves open).
 */
function nestedListRules(depth: 1 | 2): TagParseRule[] {
  const parentItem = LIST_ITEM_NODES[depth - 1];
  const list = LIST_NODES[depth];
  const item = LIST_ITEM_NODES[depth];
  const context = `${parentItem}/|${parentItem}/paragraph/`;
  return [
    { tag: 'ul', node: list, context, priority: 60 },
    { tag: 'ol', node: list, context, priority: 60 },
    {
      tag: 'li',
      node: item,
      context: `${list}/`,
      priority: 60,
      getAttrs: checkedOf,
      contentElement: itemContent,
    },
  ];
}

// ---------------------------------------------------------------------------
// Nodes and marks
// ---------------------------------------------------------------------------

function listItemSpec(depth: 0 | 1 | 2): NodeSpec {
  const name = LIST_ITEM_NODES[depth];
  const nested = depth < MAX_LIST_DEPTH - 1 ? LIST_NODES[depth + 1] : undefined;
  return {
    content: nested === undefined ? 'paragraph' : `paragraph ${nested}?`,
    attrs: { checked: attribute(name, 'checked', false) },
    defining: true,
    toDOM: (node) => ['li', node.attrs.checked === true ? { 'data-checked': 'true' } : {}, 0],
    // Root items parse through the rule below; nested levels add their own
    // context-bound rules (`nestedListRules`).
    ...(depth === 0
      ? {
          parseDOM: [
            {
              tag: 'li',
              context: 'list/',
              priority: 60,
              getAttrs: checkedOf,
              contentElement: itemContent,
            },
          ],
        }
      : {}),
  };
}

function nestedListSpec(depth: 1 | 2): NodeSpec {
  return {
    content: `${LIST_ITEM_NODES[depth]}+`,
    toDOM: () => ['ul', { 'data-list-nested': '' }, 0],
  };
}

function headingRules(): TagParseRule[] {
  return [1, 2, 3, 4, 5, 6].map((level) => ({
    tag: `h${level}`,
    // Level 1 belongs to the page title.
    attrs: { level: Math.max(level, MIN_HEADING_LEVEL) },
  }));
}

function mediaFigure(kind: string, attrs: Readonly<Record<string, string>>): DOMOutputSpec {
  return ['figure', { 'data-rich-text': kind, ...attrs }];
}

function optionalData(name: string, value: unknown): Readonly<Record<string, string>> {
  return typeof value === 'string' && value !== '' ? { [name]: value } : {};
}

const nodes: Readonly<Record<RichTextNodeName, NodeSpec>> = {
  doc: { content: 'block*' },
  paragraph: {
    group: 'block',
    content: 'inline*',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },
  heading: {
    group: 'block',
    content: 'text*',
    attrs: { level: attribute('heading', 'level', MIN_HEADING_LEVEL) },
    defining: true,
    // A `<br>` in a heading, pasted or put in the live heading by the browser,
    // has no place there: the heading is the element's own context, so the
    // parser cannot close it to fit a `hard_break`, and reads the `<br>` as a
    // `\n` instead. The line rule then makes it a space (in `decode`, and in
    // the state through the text rules), so the words stay apart.
    parseDOM: headingRules(),
    toDOM: (node) => [`h${String(node.attrs.level)}`, 0],
  },
  quote: {
    group: 'block',
    content: 'inline*',
    attrs: { citation: attribute('quote', 'citation', '') },
    defining: true,
    parseDOM: [
      // A quote this schema serialized holds inline content only, parsed with
      // the caller's whitespace options (the clipboard preserves whitespace).
      {
        tag: 'blockquote',
        priority: 60,
        getAttrs: (dom) => (hasBlockChildren(dom) ? false : quoteAttrs(dom)),
      },
      { tag: 'blockquote', getAttrs: quoteAttrs, getContent: flattenInline },
    ],
    toDOM: (node) => ['blockquote', optionalData('data-citation', node.attrs.citation), 0],
  },
  callout: {
    group: 'block',
    content: 'inline*',
    attrs: { tone: attribute('callout', 'tone', 'info') },
    defining: true,
    parseDOM: [
      // As with the quote: an aside this schema serialized holds inline
      // content only; pasted asides wrap their text in paragraphs.
      {
        tag: 'aside',
        priority: 60,
        getAttrs: (dom) => (hasBlockChildren(dom) ? false : calloutAttrs(dom)),
      },
      { tag: 'aside', getAttrs: calloutAttrs, getContent: flattenInline },
    ],
    toDOM: (node) => ['aside', { 'data-tone': String(node.attrs.tone) }, 0],
  },
  code_block: {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    attrs: { language: attribute('code_block', 'language', '') },
    parseDOM: [
      {
        tag: 'pre',
        preserveWhitespace: 'full',
        getAttrs: (dom) => {
          const language = dom.getAttribute('data-language') ?? classLanguage(dom);
          return {
            language: acceptsAttribute('code_block', 'language', language) ? language : '',
          };
        },
      },
    ],
    toDOM: (node) => ['pre', optionalData('data-language', node.attrs.language), ['code', 0]],
  },
  list: {
    group: 'block',
    content: 'list_item+',
    attrs: { style: attribute('list', 'style', 'unordered') },
    parseDOM: [
      { tag: 'ol', attrs: { style: 'ordered' } },
      { tag: 'ul', getAttrs: listStyleOf },
    ],
    toDOM: (node) =>
      node.attrs.style === 'ordered'
        ? ['ol', 0]
        : ['ul', node.attrs.style === 'task' ? { 'data-list-style': 'task' } : {}, 0],
  },
  list_item: listItemSpec(0),
  list_2: { ...nestedListSpec(1), parseDOM: nestedListRules(1) },
  list_item_2: listItemSpec(1),
  list_3: { ...nestedListSpec(2), parseDOM: nestedListRules(2) },
  list_item_3: listItemSpec(2),
  image: {
    group: 'block',
    atom: true,
    attrs: {
      mediaId: attribute('image', 'mediaId'),
      alt: attribute('image', 'alt', ''),
      caption: attribute('image', 'caption', ''),
    },
    leafText: (node) => String(node.attrs.alt),
    parseDOM: [
      {
        tag: 'figure[data-rich-text="image"]',
        getAttrs: (dom) => {
          const mediaId = domAttribute(dom, 'image', 'mediaId', 'data-media-id');
          return mediaId === undefined
            ? false
            : {
                mediaId,
                alt: domAttribute(dom, 'image', 'alt', 'data-alt') ?? '',
                caption: domAttribute(dom, 'image', 'caption', 'data-caption') ?? '',
              };
        },
      },
    ],
    toDOM: (node) =>
      mediaFigure('image', {
        'data-media-id': String(node.attrs.mediaId),
        ...optionalData('data-alt', node.attrs.alt),
        ...optionalData('data-caption', node.attrs.caption),
      }),
  },
  gallery: {
    group: 'block',
    atom: true,
    attrs: { mediaIds: attribute('gallery', 'mediaIds'), alt: attribute('gallery', 'alt', '') },
    leafText: (node) => String(node.attrs.alt),
    parseDOM: [
      {
        tag: 'figure[data-rich-text="gallery"]',
        getAttrs: (dom) => {
          let mediaIds: unknown;
          try {
            mediaIds = JSON.parse(dom.getAttribute('data-media-ids') ?? '');
          } catch {
            // Not JSON: not a gallery this schema serialized, so the rule does not match.
            return false;
          }
          return acceptsAttribute('gallery', 'mediaIds', mediaIds)
            ? { mediaIds, alt: domAttribute(dom, 'gallery', 'alt', 'data-alt') ?? '' }
            : false;
        },
      },
    ],
    toDOM: (node) =>
      mediaFigure('gallery', {
        'data-media-ids': JSON.stringify(node.attrs.mediaIds),
        ...optionalData('data-alt', node.attrs.alt),
      }),
  },
  embed: {
    group: 'block',
    atom: true,
    attrs: { url: attribute('embed', 'url') },
    parseDOM: [
      {
        tag: 'figure[data-rich-text="embed"]',
        getAttrs: (dom) => {
          const url = domAttribute(dom, 'embed', 'url', 'data-url');
          return url === undefined ? false : { url };
        },
      },
    ],
    toDOM: (node) => mediaFigure('embed', { 'data-url': String(node.attrs.url) }),
  },
  cta: {
    group: 'block',
    atom: true,
    attrs: { label: attribute('cta', 'label'), href: attribute('cta', 'href') },
    leafText: (node) => String(node.attrs.label),
    parseDOM: [
      {
        tag: 'div[data-rich-text="cta"]',
        getAttrs: (dom) => {
          const label = domAttribute(dom, 'cta', 'label', 'data-label');
          const href = domAttribute(dom, 'cta', 'href', 'data-href');
          return label === undefined || href === undefined ? false : { label, href };
        },
      },
    ],
    toDOM: (node) => [
      'div',
      {
        'data-rich-text': 'cta',
        'data-label': String(node.attrs.label),
        'data-href': String(node.attrs.href),
      },
      String(node.attrs.label),
    ],
  },
  divider: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },
  text: { group: 'inline' },
  hard_break: {
    group: 'inline',
    inline: true,
    selectable: false,
    // Turning a paragraph into code turns its breaks into `\n`, and back.
    linebreakReplacement: true,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },
};

/** True for a `font-weight` value that renders bold. */
function isBoldWeight(value: string): boolean {
  return /^(bold(er)?|[5-9]\d{2})$/.test(value);
}

const marks: Readonly<Record<RichTextMarkName, MarkSpec>> = {
  link: {
    attrs: { href: attribute('link', 'href') },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom) => {
          const href = domAttribute(dom, 'link', 'href', 'href');
          return href === undefined ? false : { href };
        },
      },
    ],
    toDOM: (mark) => [
      'a',
      { href: String(mark.attrs.href), rel: 'noopener noreferrer nofollow' },
      0,
    ],
  },
  bold: {
    parseDOM: [
      { tag: 'strong' },
      // Google Docs wraps whole documents in `<b style="font-weight:normal">`.
      { tag: 'b', getAttrs: (dom) => dom.style.fontWeight !== 'normal' && null },
      { style: 'font-weight', getAttrs: (value) => isBoldWeight(value) && null },
    ],
    toDOM: () => ['strong', 0],
  },
  italic: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
    toDOM: () => ['em', 0],
  },
  strike: {
    parseDOM: [
      { tag: 's' },
      { tag: 'del' },
      { tag: 'strike' },
      { style: 'text-decoration', getAttrs: (value) => value.includes('line-through') && null },
      {
        style: 'text-decoration-line',
        getAttrs: (value) => value.includes('line-through') && null,
      },
    ],
    toDOM: () => ['s', 0],
  },
  code: {
    // A canonical run marked `code` carries no other mark (its link is not a mark).
    excludes: 'bold italic strike code',
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code', 0],
  },
};

/**
 * The editor schema. Mark order is the model's canonical mark order, so the
 * marks of a node list in the order a canonical run lists them.
 */
export const richTextEditorSchema: Schema<RichTextNodeName, RichTextMarkName> = new Schema({
  nodes,
  marks,
});

/** The node type named `name` in {@link richTextEditorSchema}. */
export function nodeType(name: RichTextNodeName): NodeType {
  return richTextEditorSchema.nodes[name];
}
