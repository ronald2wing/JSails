/**
 * Safe, declarative theme templates.
 *
 * A theme template is JSON, never code. It is a small element tree with:
 * - allowlisted element tags and attributes;
 * - escaped text nodes;
 * - named slots filled by the application with already-sanitized HTML (for
 *   example the framework's canonical rich-text renderer).
 *
 * The renderer never evaluates a template, never accepts event-handler
 * attributes, never accepts `style`, `script`, `iframe`, or arbitrary tags, and
 * rejects unsafe URLs. A malicious or malformed template fails closed with a
 * value-free {@link ThemeTemplateError}; it is never partially rendered.
 *
 * This module is browser-safe: it has no `node:*` imports and performs no I/O.
 * A caller reads a template file and passes its parsed JSON here.
 */

import { z } from 'zod';

import { Str } from 'jsails/support';
import { CONTROL_CHARS } from 'jsails/support';

/** Maximum template tree depth. */
export const MAX_TEMPLATE_DEPTH = 32;

/** Maximum number of nodes in one template. */
export const MAX_TEMPLATE_NODES = 2000;

/** Maximum length of a text node or slot value name. */
export const MAX_TEMPLATE_TEXT = 20000;

/** Tags a theme template may emit. */
export const THEME_TEMPLATE_TAGS = Object.freeze([
  'a',
  'article',
  'aside',
  'blockquote',
  'br',
  'code',
  'div',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'img',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'small',
  'span',
  'strong',
  'time',
  'ul',
] as const);

/** A tag a theme template may emit. */
export type ThemeTemplateTag = (typeof THEME_TEMPLATE_TAGS)[number];

/** Attributes a theme template may emit. */
export const THEME_TEMPLATE_ATTRIBUTES = Object.freeze([
  'alt',
  'aria-hidden',
  'aria-label',
  'class',
  'height',
  'href',
  'id',
  'loading',
  'rel',
  'role',
  'src',
  'target',
  'title',
  'width',
] as const);

/** An attribute a theme template may emit. */
export type ThemeTemplateAttribute = (typeof THEME_TEMPLATE_ATTRIBUTES)[number];

/** A rendered element node. */
export interface ThemeTemplateElement {
  readonly type: 'element';
  readonly tag: ThemeTemplateTag;
  readonly attributes?: Readonly<Partial<Record<ThemeTemplateAttribute, string>>>;
  readonly children: readonly ThemeTemplateNode[];
}

/** An escaped text node. */
export interface ThemeTemplateText {
  readonly type: 'text';
  readonly value: string;
}

/** A named slot whose value is already-sanitized HTML supplied by the app. */
export interface ThemeTemplateSlot {
  readonly type: 'slot';
  readonly name: string;
}

/** One node in a theme template tree. */
export type ThemeTemplateNode = ThemeTemplateElement | ThemeTemplateText | ThemeTemplateSlot;

/** A validated theme template. */
export interface ThemeTemplate {
  readonly version: 1;
  readonly name: string;
  readonly contentType?: string;
  readonly root: ThemeTemplateNode;
}

/** Raised for a malformed or unsafe theme template. Messages are value-free. */
export class ThemeTemplateError extends Error {
  readonly code: 'invalid_template' | 'unsafe_template';

  constructor(code: 'invalid_template' | 'unsafe_template', message: string) {
    super(message);
    this.name = 'ThemeTemplateError';
    this.code = code;
  }
}

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SLOT_PATTERN = /^[a-z][A-Za-z0-9-]*$/;
const SAFE_CLASS = /^[A-Za-z0-9 _-]*$/;
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SAFE_DIMENSION = /^\d{1,6}$/;
const UNSAFE_URL = /^(?:javascript|data|vbscript|file):/i;
const VOID_TAGS = new Set<ThemeTemplateTag>(['br', 'hr', 'img']);

const nodeSchema: z.ZodType<ThemeTemplateNode> = z.lazy(() =>
  z.union([
    z
      .object({
        type: z.literal('element'),
        tag: z.enum(THEME_TEMPLATE_TAGS),
        attributes: z.record(z.string(), z.string()).optional(),
        children: z.array(nodeSchema).max(MAX_TEMPLATE_NODES),
      })
      .strict(),
    z.object({ type: z.literal('text'), value: z.string().max(MAX_TEMPLATE_TEXT) }).strict(),
    z.object({ type: z.literal('slot'), name: z.string().min(1).max(64) }).strict(),
  ]),
);

const templateSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(190).regex(NAME_PATTERN),
    contentType: z.string().min(1).max(64).optional(),
    root: nodeSchema,
  })
  .strict();

/** True when a URL is safe for a theme `href` or `src`. */
function isSafeUrl(value: string): boolean {
  if (value.length === 0 || CONTROL_CHARS.test(value) || UNSAFE_URL.test(value)) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  if (value.startsWith('#')) return true;
  if (/^https:\/\//i.test(value)) return true;
  // `mailto:` is a link-only scheme; allow it for href, never for src.
  if (/^mailto:[^\s]+$/i.test(value)) return true;
  return false;
}

/** Validate one attribute value and return a safe string, or undefined when unsafe. */
function safeAttribute(name: ThemeTemplateAttribute, value: string): string | undefined {
  if (CONTROL_CHARS.test(value)) return undefined;
  switch (name) {
    case 'class':
      return SAFE_CLASS.test(value) ? value : undefined;
    case 'id':
      return SAFE_ID.test(value) ? value : undefined;
    case 'href':
      return isSafeUrl(value) ? value : undefined;
    case 'src':
      return isSafeUrl(value) && !value.startsWith('#') && !/^mailto:/i.test(value)
        ? value
        : undefined;
    case 'width':
    case 'height':
      return SAFE_DIMENSION.test(value) ? value : undefined;
    case 'role':
      return /^[a-z][a-z0-9-]*$/i.test(value) ? value : undefined;
    case 'rel':
      return /^(?:noopener|noreferrer|nofollow|ugc|sponsored)(?:\s+(?:noopener|noreferrer|nofollow|ugc|sponsored))*$/i.test(
        value,
      )
        ? value
        : undefined;
    case 'target':
      return value === '_blank' || value === '_self' ? value : undefined;
    case 'loading':
      return value === 'lazy' || value === 'eager' ? value : undefined;
    case 'alt':
    case 'aria-hidden':
    case 'aria-label':
    case 'title':
      return value;
  }
}

/** Validate the node tree, including tag/attribute allowlists and depth. */
function validateNode(node: ThemeTemplateNode, depth: number, counter: { count: number }): void {
  counter.count += 1;
  if (counter.count > MAX_TEMPLATE_NODES) {
    throw new ThemeTemplateError('unsafe_template', 'theme template is too large');
  }
  if (depth > MAX_TEMPLATE_DEPTH) {
    throw new ThemeTemplateError('unsafe_template', 'theme template is too deeply nested');
  }
  if (node.type === 'text') {
    return;
  }
  if (node.type === 'slot') {
    if (!SLOT_PATTERN.test(node.name)) {
      throw new ThemeTemplateError('unsafe_template', 'theme template slot name is invalid');
    }
    return;
  }
  if (!(THEME_TEMPLATE_TAGS as readonly string[]).includes(node.tag)) {
    throw new ThemeTemplateError('unsafe_template', 'theme template tag is not allowed');
  }
  if (VOID_TAGS.has(node.tag) && node.children.length > 0) {
    throw new ThemeTemplateError(
      'unsafe_template',
      'void theme template tags cannot have children',
    );
  }
  if (node.attributes !== undefined) {
    for (const [rawName, value] of Object.entries(node.attributes)) {
      if (!(THEME_TEMPLATE_ATTRIBUTES as readonly string[]).includes(rawName)) {
        throw new ThemeTemplateError('unsafe_template', 'theme template attribute is not allowed');
      }
      if (safeAttribute(rawName as ThemeTemplateAttribute, value) === undefined) {
        throw new ThemeTemplateError('unsafe_template', 'theme template attribute value is unsafe');
      }
    }
  }
  for (const child of node.children) {
    validateNode(child, depth + 1, counter);
  }
}

/** Parse and validate a raw theme template. */
export function parseThemeTemplate(raw: unknown): ThemeTemplate {
  const parsed = templateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ThemeTemplateError('invalid_template', 'theme template has an invalid shape');
  }
  validateNode(parsed.data.root, 0, { count: 0 });
  return Object.freeze({
    version: 1,
    name: parsed.data.name,
    ...(parsed.data.contentType === undefined ? {} : { contentType: parsed.data.contentType }),
    root: deepFreeze(parsed.data.root),
  });
}

/** Escape text and attribute values for safe HTML output. */
function escapeHtml(value: string): string {
  return Str.escapeHtml(value);
}

/** Render one validated node. Slot values are trusted, already-sanitized HTML. */
function renderNode(node: ThemeTemplateNode, slots: Readonly<Record<string, string>>): string {
  if (node.type === 'text') {
    return escapeHtml(node.value);
  }
  if (node.type === 'slot') {
    return slots[node.name] ?? '';
  }
  const attributes =
    node.attributes === undefined
      ? ''
      : Object.entries(node.attributes)
          .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
          .join('');
  if (VOID_TAGS.has(node.tag)) {
    return `<${node.tag}${attributes}>`;
  }
  const children = node.children.map((child) => renderNode(child, slots)).join('');
  return `<${node.tag}${attributes}>${children}</${node.tag}>`;
}

/**
 * Render a validated theme template.
 *
 * Slot values are inserted verbatim and must already be sanitized by the
 * caller. Use them only for framework-produced HTML such as the canonical
 * rich-text renderer; never pass client data.
 */
export function renderThemeTemplate(
  template: ThemeTemplate,
  slots: Readonly<Record<string, string>> = {},
): string {
  return renderNode(template.root, slots);
}

/** Deep-freeze a template tree. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value as Record<string, unknown>)) {
      deepFreeze(member);
    }
    Object.freeze(value);
  }
  return value;
}
