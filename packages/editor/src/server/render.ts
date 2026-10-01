/**
 * Server-side renderer for rich-text documents (`@jsails/editor/server`).
 *
 * {@link renderRichText} turns a document into an HTML fragment built from a
 * fixed set of elements and attributes. Every text and attribute value goes
 * through `Str.escapeHtml`; there is no raw-HTML block.
 *
 * ## What the renderer trusts
 *
 * Its input is read with `parseRichText`, so every link and embed URL already
 * passed the model's predicates (`isLinkHref`, `isEmbedUrl`) and the renderer
 * carries no scheme checks of its own. What remains here is policy that is not
 * a property of the document: which embed hosts may become a frame (an
 * allowlist, empty by default) and how a media id resolves to an image (a
 * caller-supplied resolver whose `src` must be a path or an http(s) URL).
 * An unknown media id or a disallowed embed host renders a placeholder.
 *
 * ## Output grammar
 *
 * - Runs: marks nest in model order (`strong`, `em`, `s`, `code`, outermost
 *   first), `\n` is `<br>`, and adjacent runs with the same href share one
 *   `<a>`; an absolute `http(s)` link gets `rel="noopener noreferrer"`.
 * - Blocks: `p`, `h2`-`h6`, `blockquote` (with `footer > cite`), `aside`
 *   (callout), `pre > code`, `ol`/`ul` (a task list is `ul.jsails-task-list`
 *   whose items start with a disabled checkbox), `img`/`figure`, `iframe`
 *   (embed), `p.jsails-cta > a`, `hr`. Blocks are joined with `\n`.
 *
 * Only programmer mistakes throw, with a value-free `rich_text_render.*` code
 * (`render-errors.ts`).
 */

import {
  isLinkHref,
  parseRichText,
  type InlineContent,
  type InlineMark,
  type InlineRun,
  type ListItem,
  type ListStyle,
  type RichTextBlock,
  type RichTextDocument,
} from 'jsails/rich-text';
import { Str } from 'jsails/support';

import { RichTextRenderErrors } from './render-errors.js';

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

/**
 * Display data a {@link MediaResolver} returns for a media id.
 *
 * @public
 */
export interface ResolvedMedia {
  /** A root-relative path or an absolute `http(s)` URL. */
  readonly src: string;
  /** Alternative text; the block's own `alt` wins over this fallback. */
  readonly alt?: string;
  /** Optional width in pixels. */
  readonly width?: number;
  /** Optional height in pixels. */
  readonly height?: number;
}

/**
 * Maps a media id to its display data, or `undefined` when the id is unknown.
 * Called synchronously during render; callers doing I/O pre-resolve ids.
 *
 * @public
 */
export type MediaResolver = (mediaId: string) => ResolvedMedia | undefined;

/**
 * Render options for {@link renderRichText}.
 *
 * @public
 */
export interface RenderRichTextOptions {
  /**
   * Maps media ids to display data for `image` and `gallery` blocks. Without
   * it, or for an id it does not know, a placeholder is rendered.
   */
  readonly resolveMedia?: MediaResolver;
  /**
   * Embed hosts that may render as a frame: an exact hostname (`vimeo.com`)
   * or a leading-dot entry for a domain and its subdomains (`.youtube.com`).
   * Matching ignores case and a trailing dot. Defaults to none.
   */
  readonly embedHostAllowlist?: readonly string[];
}

// ---------------------------------------------------------------------------
// Validation (programmer mistakes only)
// ---------------------------------------------------------------------------

function assertValidOptions(options: RenderRichTextOptions): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new RichTextRenderErrors.Error('invalid_option', { option: 'options' });
  }
  if (options.resolveMedia !== undefined && typeof options.resolveMedia !== 'function') {
    throw new RichTextRenderErrors.Error('invalid_option', { option: 'resolveMedia' });
  }
  if (
    options.embedHostAllowlist !== undefined &&
    (!Array.isArray(options.embedHostAllowlist) ||
      options.embedHostAllowlist.some((entry) => typeof entry !== 'string'))
  ) {
    throw new RichTextRenderErrors.Error('invalid_option', { option: 'embedHostAllowlist' });
  }
}

/** True for a path or an absolute http(s) URL the link predicate accepts. */
function isMediaSrc(src: string): boolean {
  return (
    isLinkHref(src) &&
    (src.startsWith('/') || src.startsWith('https://') || src.startsWith('http://'))
  );
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidResolvedMedia(value: unknown): value is ResolvedMedia {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { src?: unknown; alt?: unknown; width?: unknown; height?: unknown };
  return (
    typeof candidate.src === 'string' &&
    isMediaSrc(candidate.src) &&
    (candidate.alt === undefined || typeof candidate.alt === 'string') &&
    (candidate.width === undefined || isPositiveInteger(candidate.width)) &&
    (candidate.height === undefined || isPositiveInteger(candidate.height))
  );
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const candidate = host.toLowerCase().replace(/\.$/, '');
  return allowlist.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/\.$/, '');
    if (entry === '' || entry === '.') {
      return false;
    }
    if (entry.startsWith('.')) {
      const domain = entry.slice(1);
      return candidate === domain || candidate.endsWith(entry);
    }
    return candidate === entry;
  });
}

function resolveMedia(mediaId: string, options: RenderRichTextOptions): ResolvedMedia | undefined {
  const resolved = options.resolveMedia?.(mediaId);
  if (resolved === undefined || resolved === null) {
    return undefined;
  }
  if (!isValidResolvedMedia(resolved)) {
    throw new RichTextRenderErrors.Error('invalid_media');
  }
  return resolved;
}

const MISSING_MEDIA_PLACEHOLDER =
  '<span class="jsails-media-placeholder" aria-hidden="true"></span>';

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const MARK_TAGS: Readonly<Record<InlineMark, string>> = {
  bold: 'strong',
  italic: 'em',
  strike: 's',
  code: 'code',
};

function relFor(href: string): string {
  return href.startsWith('https://') || href.startsWith('http://')
    ? ' rel="noopener noreferrer"'
    : '';
}

function renderRun(run: InlineRun): string {
  let html = Str.escapeHtml(run.text).replaceAll('\n', '<br>');
  const marks = run.marks ?? [];
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const tag = MARK_TAGS[marks[index] as InlineMark];
    html = `<${tag}>${html}</${tag}>`;
  }
  return html;
}

function renderInline(content: InlineContent): string {
  let html = '';
  let start = 0;
  while (start < content.length) {
    const href = content[start]?.href;
    let end = start;
    let inner = '';
    while (end < content.length && content[end]?.href === href) {
      inner += renderRun(content[end] as InlineRun);
      end += 1;
    }
    html +=
      href === undefined ? inner : `<a href="${Str.escapeHtml(href)}"${relFor(href)}>${inner}</a>`;
    start = end;
  }
  return html;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** A language usable as a class token; anything else goes to `data-language`. */
const LANGUAGE_TOKEN = /^[A-Za-z0-9_+#.-]+$/;

function renderCode(block: Extract<RichTextBlock, { type: 'code' }>): string {
  const language = block.language;
  const attr =
    language === undefined
      ? ''
      : LANGUAGE_TOKEN.test(language)
        ? ` class="language-${language}"`
        : ` data-language="${Str.escapeHtml(language)}"`;
  return `<pre><code${attr}>${Str.escapeHtml(block.code)}</code></pre>`;
}

function renderItems(items: readonly ListItem[], style: ListStyle): string {
  const tag = style === 'ordered' ? 'ol' : 'ul';
  const open = style === 'task' ? `<${tag} class="jsails-task-list">` : `<${tag}>`;
  const body = items
    .map((item) => {
      const box =
        style === 'task'
          ? `<input type="checkbox" disabled${item.checked === true ? ' checked' : ''}>`
          : '';
      const children = item.children === undefined ? '' : renderItems(item.children, style);
      return `<li>${box}${renderInline(item.content)}${children}</li>`;
    })
    .join('');
  return `${open}${body}</${tag}>`;
}

function renderImageElement(resolved: ResolvedMedia, blockAlt: string | undefined): string {
  const alt = blockAlt ?? resolved.alt ?? '';
  const parts = [`src="${Str.escapeHtml(resolved.src)}"`, `alt="${Str.escapeHtml(alt)}"`];
  if (resolved.width !== undefined) {
    parts.push(`width="${resolved.width}"`);
  }
  if (resolved.height !== undefined) {
    parts.push(`height="${resolved.height}"`);
  }
  parts.push('loading="lazy"');
  return `<img ${parts.join(' ')}>`;
}

function renderBlock(block: RichTextBlock, options: RenderRichTextOptions): string {
  switch (block.type) {
    case 'paragraph':
      return `<p>${renderInline(block.content)}</p>`;
    case 'heading':
      return `<h${block.level}>${renderInline(block.content)}</h${block.level}>`;
    case 'quote': {
      const footer =
        block.citation === undefined
          ? ''
          : `<footer><cite>${Str.escapeHtml(block.citation)}</cite></footer>`;
      return `<blockquote><p>${renderInline(block.content)}</p>${footer}</blockquote>`;
    }
    case 'callout':
      return `<aside class="jsails-callout jsails-callout--${block.tone}">${renderInline(block.content)}</aside>`;
    case 'code':
      return renderCode(block);
    case 'list':
      return renderItems(block.items, block.style);
    case 'image': {
      const resolved = resolveMedia(block.mediaId, options);
      if (resolved === undefined) {
        return MISSING_MEDIA_PLACEHOLDER;
      }
      const img = renderImageElement(resolved, block.alt);
      return block.caption === undefined
        ? img
        : `<figure>${img}<figcaption>${Str.escapeHtml(block.caption)}</figcaption></figure>`;
    }
    case 'gallery': {
      const items = block.mediaIds.map((mediaId) => {
        const resolved = resolveMedia(mediaId, options);
        return resolved === undefined
          ? MISSING_MEDIA_PLACEHOLDER
          : renderImageElement(resolved, block.alt);
      });
      return `<figure class="jsails-gallery">${items.join('')}</figure>`;
    }
    case 'embed': {
      if (!hostAllowed(new URL(block.url).hostname, options.embedHostAllowlist ?? [])) {
        return MISSING_MEDIA_PLACEHOLDER;
      }
      // The allowlist is the boundary: providers need scripts and same-origin
      // inside their frame, so no `sandbox` is applied.
      return `<div class="jsails-embed"><iframe src="${Str.escapeHtml(block.url)}" loading="lazy" allowfullscreen></iframe></div>`;
    }
    case 'cta':
      return `<p class="jsails-cta"><a href="${Str.escapeHtml(block.href)}"${relFor(block.href)}>${Str.escapeHtml(block.label)}</a></p>`;
    case 'divider':
      return '<hr>';
  }
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

/**
 * Render a document to an HTML fragment. The document is read with
 * `parseRichText` first; one it refuses (not canonical, over budget, or not a
 * document) throws `rich_text_render.invalid_document`, so a value that
 * skipped the reader cannot reach the output.
 *
 * @public
 */
export function renderRichText(
  document: RichTextDocument,
  options: RenderRichTextOptions = {},
): string {
  assertValidOptions(options);
  const parsed = parseRichText(document);
  if (!parsed.ok) {
    throw new RichTextRenderErrors.Error('invalid_document');
  }
  return parsed.value.blocks.map((block) => renderBlock(block, options)).join('\n');
}
