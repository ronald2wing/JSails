/**
 * Server-side renderer for rich-text documents (`src/editor/server`).
 *
 * {@link renderRichText} turns a validated {@link RichTextDocument} into a
 * safe, allowlisted HTML fragment. Every text, attribute, and URL value is
 * escaped before it reaches the output; there is no raw-HTML block and no
 * client-supplied HTML is ever trusted. Media and embed resolution are the only
 * caller-supplied seams, and both degrade to a safe placeholder rather than an
 * error when an id or URL is unknown.
 *
 * ## Security posture
 *
 * - Text and attribute values go through {@link Str.escapeHtml} (the same
 *   five-entity `& < > " '` escape used everywhere else in the codebase).
 * - Embed URLs are validated against an allowlist: `https:` always, `http:`
 *   only when {@link RenderRichTextOptions.allowHttpEmbed} is set (local
 *   development), and the hostname must match an allowlist entry (exact match
 *   or the `<any>.domain` "this domain and its subdomains" form). Any other
 *   value renders an empty placeholder, never an error.
 * - CTA hrefs reject the `javascript:` / `data:` / `vbscript:` schemes
 *   case-insensitively and reject control characters; a same-origin path is
 *   rendered as-is, and every other absolute URL is a plain external link with
 *   `rel="noopener noreferrer"`.
 *
 * ## Errors
 *
 * Only programmer mistakes throw a value-free {@link RenderError}
 * (`invalid_document`, `invalid_option`, `invalid_media`); messages never echo
 * the offending input. A missing media id or a disallowed URL is content data,
 * not an error, and is rendered as a safe placeholder.
 */

import { Str } from 'jsails/support';

import { richTextSchema, type RichTextBlock, type RichTextDocument } from 'jsails/rich-text';
import { CONTROL_CHARS } from 'jsails/support';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Machine-readable reason for a {@link RenderError}. */
export type RenderErrorCode = 'invalid_document' | 'invalid_option' | 'invalid_media';

/** Raised for programmer mistakes only. Messages are value-free. */
export class RenderError extends Error {
  readonly code: RenderErrorCode;

  constructor(code: RenderErrorCode, message: string) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

/** Display data a {@link MediaResolver} returns for a media id. */
export interface ResolvedMedia {
  /** The renderable source URL (an absolute URL or a root-relative path). */
  readonly src: string;
  /** Alternative text; the image block's own `alt` wins over this fallback. */
  readonly alt?: string;
  /** Optional width in pixels. */
  readonly width?: number;
  /** Optional height in pixels. */
  readonly height?: number;
}

/**
 * Maps a media id to its display data, or `undefined` when the id is unknown.
 * Called synchronously during render; callers doing I/O must pre-resolve ids
 * (the renderer is pure and must not await a lookup).
 */
export type MediaResolver = (mediaId: string) => ResolvedMedia | undefined;

/** Render options for {@link renderRichText}. */
export interface RenderRichTextOptions {
  /**
   * Maps media ids to display data for `image` and `gallery` blocks. When
   * omitted (or the resolver returns `undefined`), a safe placeholder is
   * rendered instead of the asset.
   */
  readonly resolveMedia?: MediaResolver;
  /**
   * Allowlist of embed hosts. An entry is an exact hostname (`vimeo.com`) or a
   * "this domain and its subdomains" entry (`.youtube.com`). Matching is
   * case-insensitive and strips a trailing dot. Defaults to an empty allowlist,
   * so no embed renders unless the caller opts hosts in.
   */
  readonly embedHostAllowlist?: readonly string[];
  /**
   * Permit `http:` embed URLs. Defaults to `false`; set it only for local
   * development, never for production traffic.
   */
  readonly allowHttpEmbed?: boolean;
}

// ---------------------------------------------------------------------------
// Validation (programmer mistakes only)
// ---------------------------------------------------------------------------

/** Validate an untrusted document at the render boundary, value-free. */
function assertValidDocument(input: unknown): asserts input is RichTextDocument {
  if (richTextSchema.safeParse(input).success) {
    return;
  }
  throw new RenderError('invalid_document', 'render requires a validated rich-text document');
}

/** Validate the option object shape so a bad option never yields a raw TypeError. */
function assertValidOptions(options: RenderRichTextOptions): void {
  if (options.resolveMedia !== undefined && typeof options.resolveMedia !== 'function') {
    throw new RenderError('invalid_option', 'resolveMedia must be a function');
  }
  if (options.allowHttpEmbed !== undefined && typeof options.allowHttpEmbed !== 'boolean') {
    throw new RenderError('invalid_option', 'allowHttpEmbed must be a boolean');
  }
  if (options.embedHostAllowlist !== undefined) {
    if (
      !Array.isArray(options.embedHostAllowlist) ||
      options.embedHostAllowlist.some((entry) => typeof entry !== 'string')
    ) {
      throw new RenderError('invalid_option', 'embedHostAllowlist must be an array of strings');
    }
  }
}

/** True for a well-formed {@link ResolvedMedia} descriptor. */
function isValidResolvedMedia(value: unknown): value is ResolvedMedia {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { src?: unknown; alt?: unknown; width?: unknown; height?: unknown };
  if (typeof candidate.src !== 'string') {
    return false;
  }
  if (candidate.alt !== undefined && typeof candidate.alt !== 'string') {
    return false;
  }
  const isPositiveInteger = (n: unknown): boolean =>
    typeof n === 'number' && Number.isInteger(n) && n > 0;
  if (candidate.width !== undefined && !isPositiveInteger(candidate.width)) {
    return false;
  }
  if (candidate.height !== undefined && !isPositiveInteger(candidate.height)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

/** Schemes a CTA href is never allowed to carry (ASCII case-insensitive). */
const FORBIDDEN_CTA_SCHEMES = /^(?:javascript|vbscript|data):/i;

/** Control characters (including the null byte) must never reach an attribute. */
/**
 * Classify a CTA href: same-origin (safe), external (safe with `noopener`), or
 * forbidden (a script/data scheme). The classification is detection-only; the
 * renderer escapes whatever it finally emits.
 */
function classifyCtaHref(href: string): 'forbidden' | 'internal' | 'external' {
  const trimmed = href.trim();
  if (trimmed === '' || CONTROL_CHARS.test(trimmed)) {
    return 'forbidden';
  }
  if (FORBIDDEN_CTA_SCHEMES.test(trimmed)) {
    return 'forbidden';
  }
  // A leading `/` is a same-origin absolute path; a value without a scheme is a
  // same-origin relative path. Both need no `rel` hardening.
  if (trimmed.startsWith('/') || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return 'internal';
  }
  return 'external';
}

/** Normalize an allowlist hostname entry: trimmed, lower-cased, dot-stripped. */
function normalizeAllowlistHost(entry: string): string {
  return entry.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * True when `host` matches the allowlist. A leading-dot entry matches the
 * domain and any subdomain (`.example.com` matches `example.com` and
 * `a.example.com`); a bare entry is an exact hostname.
 */
function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const candidate = host.toLowerCase().replace(/\.$/, '');
  for (const raw of allowlist) {
    const entry = normalizeAllowlistHost(raw);
    if (entry === '') {
      continue;
    }
    if (entry.startsWith('.')) {
      const domain = entry.slice(1);
      if (candidate === domain || candidate.endsWith(`.${domain}`)) {
        return true;
      }
    } else if (candidate === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Validate an embed URL against scheme and host policy. Returns the normalized
 * URL when allowed, or `null` (render an empty placeholder) otherwise.
 */
function validateEmbedUrl(rawUrl: string, options: RenderRichTextOptions): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowHttpEmbed === true)) {
    return null;
  }
  const allowlist = options.embedHostAllowlist;
  if (allowlist === undefined || allowlist.length === 0) {
    return null;
  }
  if (!hostAllowed(url.hostname, allowlist)) {
    return null;
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Media resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a media id to a display descriptor. A missing id returns `undefined`
 * (the caller renders the placeholder); a malformed descriptor is a
 * `invalid_media` programmer error.
 */
function resolveMedia(mediaId: string, options: RenderRichTextOptions): ResolvedMedia | undefined {
  const resolver = options.resolveMedia;
  if (resolver === undefined) {
    return undefined;
  }
  const resolved = resolver(mediaId);
  if (resolved === undefined || resolved === null) {
    return undefined;
  }
  if (!isValidResolvedMedia(resolved)) {
    throw new RenderError('invalid_media', 'resolveMedia returned an invalid display descriptor');
  }
  return resolved;
}

/** The placeholder markup for a missing or disallowed asset/embed. */
const MISSING_MEDIA_PLACEHOLDER =
  '<span class="jsails-media-placeholder" aria-hidden="true"></span>';

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

function renderParagraph(block: Extract<RichTextBlock, { type: 'paragraph' }>): string {
  return `<p>${Str.escapeHtml(block.text)}</p>`;
}

function renderHeading(block: Extract<RichTextBlock, { type: 'heading' }>): string {
  return `<h${block.level}>${Str.escapeHtml(block.text)}</h${block.level}>`;
}

function renderList(block: Extract<RichTextBlock, { type: 'list' }>): string {
  const tag = block.style === 'ordered' ? 'ol' : 'ul';
  const items = block.items.map((item) => `<li>${Str.escapeHtml(item)}</li>`).join('');
  return `<${tag}>${items}</${tag}>`;
}

function renderQuote(block: Extract<RichTextBlock, { type: 'quote' }>): string {
  const citation = block.citation;
  const footer =
    citation !== undefined && citation !== ''
      ? `<footer><cite>${Str.escapeHtml(citation)}</cite></footer>`
      : '';
  return `<blockquote><p>${Str.escapeHtml(block.text)}</p>${footer}</blockquote>`;
}

function renderCode(block: Extract<RichTextBlock, { type: 'code' }>): string {
  const lang = block.language;
  // The language is a short, author-authored token; it must still be escaped
  // so a crafted value cannot break out of the `class` attribute.
  const classAttr =
    lang !== undefined && lang !== '' ? ` class="language-${Str.escapeHtml(lang)}"` : '';
  return `<pre><code${classAttr}>${Str.escapeHtml(block.code)}</code></pre>`;
}

/**
 * Build the `<img>` element for a validated display descriptor. The placement
 * alt (the block's own `alt`) wins over the asset's fallback alt.
 */
function renderImageElement(resolved: ResolvedMedia, blockAlt?: string): string {
  const parts: string[] = [`src="${Str.escapeHtml(resolved.src)}"`];
  const alt = blockAlt !== undefined && blockAlt !== '' ? blockAlt : resolved.alt;
  parts.push(alt !== undefined && alt !== '' ? `alt="${Str.escapeHtml(alt)}"` : 'alt=""');
  if (resolved.width !== undefined) {
    parts.push(`width="${resolved.width}"`);
  }
  if (resolved.height !== undefined) {
    parts.push(`height="${resolved.height}"`);
  }
  parts.push('loading="lazy"');
  return `<img ${parts.join(' ')}>`;
}

function renderImage(
  block: Extract<RichTextBlock, { type: 'image' }>,
  options: RenderRichTextOptions,
): string {
  const resolved = resolveMedia(block.mediaId, options);
  if (resolved === undefined) {
    return MISSING_MEDIA_PLACEHOLDER;
  }
  const img = renderImageElement(resolved, block.alt);
  if (block.caption !== undefined && block.caption !== '') {
    return `<figure>${img}<figcaption>${Str.escapeHtml(block.caption)}</figcaption></figure>`;
  }
  return img;
}

function renderGallery(
  block: Extract<RichTextBlock, { type: 'gallery' }>,
  options: RenderRichTextOptions,
): string {
  const items: string[] = [];
  for (const mediaId of block.mediaIds) {
    const resolved = resolveMedia(mediaId, options);
    items.push(
      resolved === undefined ? MISSING_MEDIA_PLACEHOLDER : renderImageElement(resolved, block.alt),
    );
  }
  return `<figure class="jsails-gallery">${items.join('')}</figure>`;
}

function renderEmbed(
  block: Extract<RichTextBlock, { type: 'embed' }>,
  options: RenderRichTextOptions,
): string {
  const href = validateEmbedUrl(block.url, options);
  if (href === null) {
    return MISSING_MEDIA_PLACEHOLDER;
  }
  // The allowlist is the security boundary here: no `sandbox` is applied because
  // it would break most providers (YouTube embeds need scripts + same-origin),
  // and only caller-approved https hosts ever become an iframe.
  return `<div class="jsails-embed"><iframe src="${Str.escapeHtml(href)}" loading="lazy" allowfullscreen></iframe></div>`;
}

function renderCallout(block: Extract<RichTextBlock, { type: 'callout' }>): string {
  return `<aside class="jsails-callout jsails-callout--${Str.escapeHtml(block.tone)}">${Str.escapeHtml(block.text)}</aside>`;
}

function renderCta(block: Extract<RichTextBlock, { type: 'cta' }>): string {
  const kind = classifyCtaHref(block.href);
  if (kind === 'forbidden') {
    // A forbidden href renders the label without a link: the author's text is
    // still meaningful, but it must never become a clickable script/data URL.
    return `<p class="jsails-cta"><span>${Str.escapeHtml(block.label)}</span></p>`;
  }
  const rel = kind === 'external' ? ' rel="noopener noreferrer"' : '';
  return `<p class="jsails-cta"><a href="${Str.escapeHtml(block.href)}"${rel}>${Str.escapeHtml(block.label)}</a></p>`;
}

function renderDivider(): string {
  return '<hr>';
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Render one block, dispatching on its discriminated type. */
function renderBlock(block: RichTextBlock, options: RenderRichTextOptions): string {
  switch (block.type) {
    case 'paragraph':
      return renderParagraph(block);
    case 'heading':
      return renderHeading(block);
    case 'list':
      return renderList(block);
    case 'quote':
      return renderQuote(block);
    case 'code':
      return renderCode(block);
    case 'image':
      return renderImage(block, options);
    case 'gallery':
      return renderGallery(block, options);
    case 'embed':
      return renderEmbed(block, options);
    case 'callout':
      return renderCallout(block);
    case 'cta':
      return renderCta(block);
    case 'divider':
      return renderDivider();
    default: {
      // Unreachable for a validated document; kept as a value-free guard so a
      // future block type added to the contract fails loudly, not silently.
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

/**
 * Render a validated {@link RichTextDocument} to a safe HTML fragment.
 *
 * The document must already conform to the rich-text contract (validated on
 * write or via {@link validateRichTextDocument}); a malformed document throws a
 * value-free {@link RenderError}. Each block is escaped independently and the
 * blocks are joined with a newline, so the output is a single deterministic
 * string.
 */
export function renderRichText(
  document: RichTextDocument,
  options: RenderRichTextOptions = {},
): string {
  assertValidDocument(document);
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new RenderError('invalid_option', 'render options must be an object');
  }
  assertValidOptions(options);
  return document.blocks.map((block) => renderBlock(block, options)).join('\n');
}
