/**
 * What the `.jsails` template parser knows about HTML elements: void elements,
 * elements whose content is text, and the CSS default-display and
 * white-space tables that decide where whitespace is significant.
 *
 * The two tables are Prettier's (`prettier/plugins/html.mjs`), copied so the
 * template's whitespace rule classifies every run exactly as `jsails format`
 * does (docs/design/sfc.md §5.2); a test pins them to the installed Prettier.
 * Lookups are case-sensitive, as Prettier's `vue` parser is: `<Div>` is a
 * component, not a `div`.
 */

/** Elements that never have content or an end tag. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Elements whose content is text until their end tag (HTML's RCDATA): no child
 * elements, entities decoded, interpolation allowed.
 */
export const TEXT_ONLY_ELEMENTS: ReadonlySet<string> = new Set(['textarea', 'title']);

/** Elements whose start tag drops one line break right after it (HTML's rule). */
export const LEADING_NEWLINE_ELEMENTS: ReadonlySet<string> = new Set([
  'pre',
  'textarea',
  'listing',
]);

/**
 * Prettier's implied-end-tag table (its angular-html-parser's
 * `closedByChildren`): the start tag of a listed child ends the parent element
 * first, as HTML does, so `<p><div></div></p>` is `<p></p><div></div>` and
 * then a stray `</p>`. Prettier refuses such a file, and a browser would build
 * a different tree from the rendered markup, so the parser rejects the
 * nesting. A test pins the table to the installed Prettier.
 */
export const CLOSED_BY_CHILDREN: Readonly<Record<string, readonly string[]>> = Object.freeze({
  p: Object.freeze([
    'address',
    'article',
    'aside',
    'blockquote',
    'div',
    'dl',
    'fieldset',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hgroup',
    'hr',
    'main',
    'nav',
    'ol',
    'p',
    'pre',
    'section',
    'table',
    'ul',
  ]),
  thead: Object.freeze(['tbody', 'tfoot']),
  tbody: Object.freeze(['tbody', 'tfoot']),
  tfoot: Object.freeze(['tbody']),
  tr: Object.freeze(['tr']),
  td: Object.freeze(['td', 'th']),
  th: Object.freeze(['td', 'th']),
  li: Object.freeze(['li']),
  dt: Object.freeze(['dt', 'dd']),
  dd: Object.freeze(['dt', 'dd']),
  rb: Object.freeze(['rb', 'rt', 'rtc', 'rp']),
  rt: Object.freeze(['rb', 'rt', 'rtc', 'rp']),
  rtc: Object.freeze(['rb', 'rtc', 'rp']),
  rp: Object.freeze(['rb', 'rt', 'rtc', 'rp']),
  optgroup: Object.freeze(['optgroup']),
  option: Object.freeze(['option', 'optgroup']),
});

/**
 * Whether an HTML child's start tag ends its HTML `parent` element. As in
 * Prettier, the parent is looked up as written and the child in lower case, so
 * a `<Header>` component inside a `<p>` ends it too.
 */
export function closesParent(parent: string, child: string): boolean {
  const children = Object.hasOwn(CLOSED_BY_CHILDREN, parent)
    ? CLOSED_BY_CHILDREN[parent]
    : undefined;
  return children?.includes(child.toLowerCase()) ?? false;
}

/** Elements a template may not contain: they run code or load styles. */
export const FORBIDDEN_TEMPLATE_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style']);

/**
 * Prettier's display override, a comment right before an element
 * (`<!-- display: block -->`). Its pattern takes no hyphen, so
 * `<!-- display: inline-block -->` overrides nothing; a test pins it.
 */
export const DISPLAY_OVERRIDE_COMMENT: RegExp = /^\s*display:\s*([a-z]+)\s*$/;

/** The display of an element not in the table, components included. */
export const DEFAULT_DISPLAY = 'inline';

/** Prettier's default CSS display per element. */
export const ELEMENT_DISPLAY: Readonly<Record<string, string>> = Object.freeze({
  area: 'none',
  base: 'none',
  basefont: 'none',
  datalist: 'none',
  head: 'none',
  link: 'none',
  meta: 'none',
  noembed: 'none',
  noframes: 'none',
  param: 'block',
  rp: 'none',
  script: 'block',
  style: 'none',
  template: 'inline',
  title: 'none',
  html: 'block',
  body: 'block',
  address: 'block',
  blockquote: 'block',
  center: 'block',
  dialog: 'block',
  div: 'block',
  figure: 'block',
  figcaption: 'block',
  footer: 'block',
  form: 'block',
  header: 'block',
  hr: 'block',
  legend: 'block',
  listing: 'block',
  main: 'block',
  p: 'block',
  plaintext: 'block',
  pre: 'block',
  search: 'block',
  xmp: 'block',
  slot: 'contents',
  ruby: 'ruby',
  rt: 'ruby-text',
  article: 'block',
  aside: 'block',
  h1: 'block',
  h2: 'block',
  h3: 'block',
  h4: 'block',
  h5: 'block',
  h6: 'block',
  hgroup: 'block',
  nav: 'block',
  section: 'block',
  dir: 'block',
  dd: 'block',
  dl: 'block',
  dt: 'block',
  menu: 'block',
  ol: 'block',
  ul: 'block',
  li: 'list-item',
  table: 'table',
  caption: 'table-caption',
  colgroup: 'table-column-group',
  col: 'table-column',
  thead: 'table-header-group',
  tbody: 'table-row-group',
  tfoot: 'table-footer-group',
  tr: 'table-row',
  td: 'table-cell',
  th: 'table-cell',
  input: 'inline-block',
  button: 'inline-block',
  fieldset: 'block',
  details: 'block',
  summary: 'block',
  marquee: 'inline-block',
  option: 'block',
  optgroup: 'block',
  select: 'inline-block',
  source: 'block',
  track: 'block',
  meter: 'inline-block',
  progress: 'inline-block',
  object: 'inline-block',
  video: 'inline-block',
  audio: 'inline-block',
});

/** Prettier's CSS `white-space` per element; every other element is `normal`. */
export const ELEMENT_WHITE_SPACE: Readonly<Record<string, string>> = Object.freeze({
  listing: 'pre',
  plaintext: 'pre',
  pre: 'pre',
  xmp: 'pre',
  nobr: 'nowrap',
  table: 'initial',
  textarea: 'pre-wrap',
});

/** Whether a display starts a block box (Prettier's `isBlockLikeCssDisplay`). */
export function isBlockLikeDisplay(display: string): boolean {
  return display === 'block' || display === 'list-item' || display.startsWith('table');
}

/** Whether an element keeps its whitespace exactly (`white-space: pre*`). */
export function keepsWhitespace(tag: string): boolean {
  const whiteSpace = Object.hasOwn(ELEMENT_WHITE_SPACE, tag) ? ELEMENT_WHITE_SPACE[tag] : undefined;
  return whiteSpace?.startsWith('pre') ?? false;
}

/** Where an element sits for display purposes: HTML, or inside an `<svg>`. */
export type ElementNamespace = 'html' | 'svg';

/**
 * The default display of an element, as Prettier computes it: an override
 * comment (`<!-- display: block -->`) wins; inside `<svg>`, `svg` itself is
 * `inline-block` and every other element `block`, except in or at a
 * `<foreignObject>` (`inForeignObject`, the element itself included), where
 * every element, svg ones too, is looked up in the table; otherwise the table,
 * defaulting to `inline`.
 */
export function elementDisplay(
  tag: string,
  namespace: ElementNamespace,
  inForeignObject: boolean,
  override: string | undefined,
): string {
  if (override !== undefined) {
    return override;
  }
  if (namespace === 'svg' && !inForeignObject) {
    return tag === 'svg' ? 'inline-block' : 'block';
  }
  return (
    (Object.hasOwn(ELEMENT_DISPLAY, tag) ? ELEMENT_DISPLAY[tag] : undefined) ?? DEFAULT_DISPLAY
  );
}
