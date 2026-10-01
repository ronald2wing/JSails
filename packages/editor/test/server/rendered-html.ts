/**
 * Test support for the server renderer: a strict tokenizer for exactly the
 * HTML the renderer may emit, the element and attribute allowlist, and
 * `parseRendered`, which reads rendered markup back into a document so the
 * round trip `parseRendered(render(d)) = d` can be checked.
 *
 * The tokenizer accepts double-quoted attribute values, bare boolean
 * attributes, the five entities `Str.escapeHtml` produces, and nothing else:
 * a stray `<`, `>`, unknown entity, comment, or unbalanced tag throws, so
 * markup that leaked through unescaped fails the test rather than being
 * parsed leniently the way a browser would.
 */

import {
  normalizeRichText,
  type InlineMark,
  type InlineRun,
  type ListItem,
  type RichTextBlock,
  type RichTextDocument,
} from 'jsails/rich-text';

/** Elements the renderer may emit, each with the attributes it may carry. */
export const ALLOWED_ELEMENTS: Readonly<Record<string, readonly string[]>> = {
  p: ['class'],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  strong: [],
  em: [],
  s: [],
  code: ['class', 'data-language'],
  br: [],
  a: ['href', 'rel'],
  blockquote: [],
  footer: [],
  cite: [],
  aside: ['class'],
  pre: [],
  ol: [],
  ul: ['class'],
  li: [],
  input: ['type', 'disabled', 'checked'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  figure: ['class'],
  figcaption: [],
  div: ['class'],
  iframe: ['src', 'loading', 'allowfullscreen'],
  span: ['class', 'aria-hidden'],
  hr: [],
};

const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'input']);

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

export interface HtmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string | true>>;
  readonly children: readonly HtmlNode[];
}

export type HtmlNode = HtmlElement | string;

function decode(raw: string): string {
  return raw.replace(/&[^;]*;?/g, (entity) => {
    const value = ENTITIES[entity];
    if (value === undefined) {
      throw new Error(`unexpected entity at ${JSON.stringify(entity.slice(0, 12))}`);
    }
    return value;
  });
}

const OPEN = /^<([a-z][a-z0-9]*)((?: [a-z][a-z-]*(?:="[^"<>]*")?)*)>/;
const CLOSE = /^<\/([a-z][a-z0-9]*)>/;
const ATTR = / ([a-z][a-z-]*)(?:="([^"<>]*)")?/g;

/**
 * Parse renderer output into a node list, throwing on anything outside the
 * strict grammar, an element or attribute not in {@link ALLOWED_ELEMENTS},
 * or an unbalanced tag.
 */
export function parseHtml(html: string): HtmlNode[] {
  const root: { name: string; attrs: Record<string, string | true>; children: HtmlNode[] } = {
    name: '#root',
    attrs: {},
    children: [],
  };
  const stack = [root];
  let rest = html;
  while (rest.length > 0) {
    const top = stack[stack.length - 1] as (typeof stack)[number];
    if (rest.startsWith('</')) {
      const match = CLOSE.exec(rest);
      if (match === null || match[1] !== top.name) {
        throw new Error('unbalanced or malformed closing tag');
      }
      stack.pop();
      rest = rest.slice(match[0].length);
      continue;
    }
    if (rest.startsWith('<')) {
      const match = OPEN.exec(rest);
      if (match === null) {
        throw new Error('malformed opening tag');
      }
      const name = match[1] as string;
      const allowed = ALLOWED_ELEMENTS[name];
      if (allowed === undefined) {
        throw new Error(`element ${name} is not allowed`);
      }
      const attrs: Record<string, string | true> = {};
      for (const attr of (match[2] ?? '').matchAll(ATTR)) {
        const key = attr[1] as string;
        if (!allowed.includes(key) || Object.hasOwn(attrs, key)) {
          throw new Error(`attribute ${key} is not allowed on ${name}`);
        }
        attrs[key] = attr[2] === undefined ? true : decode(attr[2]);
      }
      const element = { name, attrs, children: [] as HtmlNode[] };
      top.children.push(element);
      if (!VOID_ELEMENTS.has(name)) {
        stack.push(element);
      }
      rest = rest.slice(match[0].length);
      continue;
    }
    const end = rest.search(/[<>]/);
    const raw = end === -1 ? rest : rest.slice(0, end);
    if (raw === '') {
      throw new Error('stray >');
    }
    top.children.push(decode(raw));
    rest = rest.slice(raw.length);
  }
  if (stack.length !== 1) {
    throw new Error('unclosed element');
  }
  return root.children;
}

/** Every element in a node list, depth first. */
export function elements(nodes: readonly HtmlNode[]): HtmlElement[] {
  return nodes.flatMap((node) =>
    typeof node === 'string' ? [] : [node, ...elements(node.children)],
  );
}

/** The top-level elements of renderer output; the text between them must be `\n`. */
export function topLevel(html: string): HtmlElement[] {
  const nodes = parseHtml(html);
  for (const node of nodes) {
    if (typeof node === 'string' && node !== '\n') {
      throw new Error('text outside a block');
    }
  }
  return nodes.filter((node): node is HtmlElement => typeof node !== 'string');
}

const TAG_MARKS: Readonly<Record<string, InlineMark>> = {
  strong: 'bold',
  em: 'italic',
  s: 'strike',
  code: 'code',
};

function inline(nodes: readonly HtmlNode[], marks: readonly InlineMark[], href?: string) {
  const runs: InlineRun[] = [];
  const push = (text: string) =>
    runs.push({
      text,
      ...(marks.length === 0 ? {} : { marks }),
      ...(href === undefined ? {} : { href: href as InlineRun['href'] }),
    });
  for (const node of nodes) {
    if (typeof node === 'string') {
      push(node);
    } else if (node.name === 'br') {
      push('\n');
    } else if (node.name === 'a') {
      if (href !== undefined) {
        throw new Error('nested link');
      }
      runs.push(...inline(node.children, marks, String(node.attrs['href'])));
    } else {
      const mark = TAG_MARKS[node.name];
      if (mark === undefined) {
        throw new Error(`${node.name} inside inline content`);
      }
      runs.push(...inline(node.children, [...marks, mark], href));
    }
  }
  return runs;
}

function text(nodes: readonly HtmlNode[]): string {
  return nodes.map((node) => (typeof node === 'string' ? node : text(node.children))).join('');
}

function child(element: HtmlElement, name: string): HtmlElement | undefined {
  return element.children.find(
    (node): node is HtmlElement => typeof node !== 'string' && node.name === name,
  );
}

function items(list: HtmlElement, task: boolean): ListItem[] {
  return list.children.map((node) => {
    if (typeof node === 'string' || node.name !== 'li') {
      throw new Error('list holds something other than items');
    }
    let rest = node.children;
    let checked: boolean | undefined;
    if (task) {
      const box = rest[0];
      if (typeof box === 'string' || box?.name !== 'input') {
        throw new Error('task item without its checkbox');
      }
      checked = box.attrs['checked'] === true;
      rest = rest.slice(1);
    }
    const nested = rest.at(-1);
    const hasChildren =
      nested !== undefined && typeof nested !== 'string' && ['ol', 'ul'].includes(nested.name);
    const content = hasChildren ? rest.slice(0, -1) : rest;
    return {
      content: inline(content, []),
      ...(checked === undefined ? {} : { checked }),
      ...(hasChildren ? { children: items(nested, task) } : {}),
    };
  });
}

function block(element: HtmlElement): RichTextBlock {
  switch (element.name) {
    case 'p':
      return { type: 'paragraph', content: inline(element.children, []) };
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return {
        type: 'heading',
        level: Number(element.name.slice(1)) as 2,
        content: inline(element.children, []),
      };
    case 'blockquote': {
      const body = child(element, 'p');
      const footer = child(element, 'footer');
      return {
        type: 'quote',
        content: inline(body?.children ?? [], []),
        ...(footer === undefined ? {} : { citation: text(footer.children) }),
      };
    }
    case 'aside': {
      const tone = String(element.attrs['class']).replace('jsails-callout jsails-callout--', '');
      return { type: 'callout', tone: tone as 'info', content: inline(element.children, []) };
    }
    case 'pre': {
      const code = child(element, 'code');
      const cls = code?.attrs['class'];
      const data = code?.attrs['data-language'];
      const language =
        typeof cls === 'string'
          ? cls.replace(/^language-/, '')
          : typeof data === 'string'
            ? data
            : undefined;
      return {
        type: 'code',
        code: text(code?.children ?? []),
        ...(language === undefined ? {} : { language }),
      };
    }
    case 'ol':
    case 'ul': {
      const task = element.attrs['class'] === 'jsails-task-list';
      const style = element.name === 'ol' ? 'ordered' : task ? 'task' : 'unordered';
      return { type: 'list', style, items: items(element, task) };
    }
    case 'hr':
      return { type: 'divider' };
    default:
      throw new Error(`${element.name} is not a text block`);
  }
}

/**
 * Read renderer output back into a canonical document. Defined for documents
 * without image, gallery, embed or CTA blocks, whose markup depends on
 * render options rather than on the document alone.
 */
export function parseRendered(html: string): RichTextDocument {
  return normalizeRichText({ version: 2, blocks: topLevel(html).map(block) });
}
