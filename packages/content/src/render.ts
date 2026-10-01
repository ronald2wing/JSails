/**
 * Markdown rendering for the content layer.
 *
 * The markdown output is **trusted producer HTML** — no sanitizer runs here.
 * Content is hand-authored and version-controlled. Rendered pages, the TOC,
 * plain-text extraction (search corpus), the excerpt, and the reading-time
 * estimate all derive from this module.
 */

import MarkdownIt, { type Token } from 'markdown-it';

import { Str } from 'jsails/support';

import { highlightCode } from './highlight.js';
import type { ContentPage, TocHeading } from './model.js';
import { toUrlSlug } from './slug.js';

// --- Rendering engine -------------------------------------------------------

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
});

md.enable('table');

// Emit the Shiki output stored on a fence token by `renderMarkdown`, falling
// back to markdown-it's own fence renderer. Installed once: wrapping the rule
// per render would nest a new closure around the previous one on every page.
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, opts, env, renderer) => {
  const highlighted = tokens[idx]?.meta?.highlighted;
  if (typeof highlighted === 'string') {
    return highlighted;
  }
  return defaultFence ? defaultFence(tokens, idx, opts, env, renderer) : '';
};

// --- Heading extraction ----------------------------------------------------

/**
 * Strip the leading H1 heading token triplet from a markdown-it token array.
 *
 * The frontmatter `title` is the canonical page title; the body's `# Title`
 * H1 would duplicate it when a page already renders `<h1>{title}</h1>`.
 * Only a heading that is the document's FIRST block is removed — an H1 that
 * appears after any other content (a paragraph, a list, a second heading) is a
 * legitimate in-body section heading and is left intact. Other heading depths
 * are never touched.
 *
 * Returns the same array (mutated in place) so both the HTML renderer and
 * TOC extraction consume the stripped stream.
 */
function stripLeadingH1(tokens: Token[]): Token[] {
  const first = tokens[0];
  // Not a leading heading at all — no strip.
  if (!first || first.type !== 'heading_open' || first.tag !== 'h1') return tokens;

  // Headings are never nested in markdown-it, so the matching heading_close is
  // the next heading_close after the open (normally 2 positions ahead).
  let closeIndex = -1;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t && t.type === 'heading_close' && t.tag === 'h1') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return tokens;

  tokens.splice(0, closeIndex + 1);
  return tokens;
}

function injectHeadingIds(tokens: Token[]): TocHeading[] {
  const headings: TocHeading[] = [];
  const slugCounts = new Map<string, number>();

  function makeSlug(text: string): string {
    const slug = toUrlSlug(text) || 'heading';
    const count = slugCounts.get(slug) ?? 0;
    slugCounts.set(slug, count + 1);
    return count === 0 ? slug : `${slug}-${count + 1}`;
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.type !== 'heading_open') continue;
    const depth = parseInt(token.tag.slice(1), 10);
    const next = tokens[i + 1];
    if (!next || next.type !== 'inline') continue;
    const text = Str.stripTags(next.content).trim();
    const id = makeSlug(text);

    // Inject the id attribute so the rendered heading element carries
    // id="heading-slug" — the TOC links to href="#heading-slug".
    token.attrs = token.attrs ?? [];
    token.attrs.push(['id', id]);

    headings.push({ depth, id, text });
  }

  return headings;
}

// --- Markdown rendering (with async Shiki highlighting) --------------------

/**
 * Render markdown content to HTML with async Shiki syntax highlighting for
 * fenced code blocks.
 *
 * Approach: parse tokens with `md.parse`, collect all `fence` blocks, highlight
 * each in parallel via the shared Shiki highlighter, store the highlighted HTML
 * on each fence token, and let the module-level fence rule emit it.
 */
export async function renderMarkdown(
  content: string,
): Promise<{ html: string; toc: TocHeading[] }> {
  const tokens = md.parse(content, {});

  // Strip the leading H1 so the frontmatter title is the canonical page title.
  stripLeadingH1(tokens);

  // Collect fence blocks.
  const fenceIndices: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.type === 'fence') {
      fenceIndices.push(i);
    }
  }

  // Highlight all fence blocks in parallel.
  if (fenceIndices.length > 0) {
    const highlighted = await Promise.all(
      fenceIndices.map(async (idx) => {
        const token = tokens[idx];
        // Unreachable: `idx` was collected from a real fence token above.
        if (!token) return { idx, html: '' };
        const lang = token.info.trim().split(/\s+/)[0] || 'text';
        const html = await highlightCode(token.content, lang);
        return { idx, html };
      }),
    );

    for (const { idx, html } of highlighted) {
      const token = tokens[idx];
      if (token) {
        // `meta` is markdown-it's sanctioned plugin-data slot; storing the
        // highlight result here (not on an ad-hoc `_highlighted` property)
        // keeps the token shape typed.
        token.meta ??= {};
        token.meta.highlighted = html;
      }
    }
  }

  // Inject heading ids into tokens and extract the TOC before rendering
  // so the rendered HTML carries id="heading-slug" attributes that match
  // the TOC's href="#heading-slug" links.
  const toc = injectHeadingIds(tokens);

  const html = md.renderer.render(tokens, md.options, {});

  return { html, toc };
}

// --- Plain text extraction (for search corpus) -----------------------------

/**
 * Collapse rendered HTML to whitespace-normalized plain text: code blocks and
 * tags become spaces, entities are dropped, and runs of whitespace collapse.
 * Unbounded; callers that need a budget apply it themselves. Tags are replaced
 * by a space rather than removed (`Str.stripTags`) so adjacent elements do not
 * run their words together.
 */
function htmlToText(html: string): string {
  return Str.squish(
    html
      .replace(/<pre[^>]*>[\s\S]*?<\/pre>/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-z]+;/g, ' '),
  );
}

/** The search-corpus text of a page, bounded per document. */
export function stripHtml(html: string): string {
  return htmlToText(html).slice(0, 4000);
}

/**
 * First non-empty paragraph text, cut at a word boundary near 200 characters.
 * Returns `undefined` when the rendered HTML has no leading paragraph.
 */
export function extractExcerpt(html: string): string | undefined {
  const match = html.match(/<p>([^<]*)<\/p>/);
  if (!match) return undefined;
  const text = (match[1] ?? '').trim();
  if (text.length === 0) return undefined;
  return Str.excerpt(text, 200);
}

const WORDS_PER_MINUTE = 200;

/**
 * Estimate reading time in whole minutes from a page's rendered HTML.
 *
 * Strips HTML tags, counts words, and divides by 200 wpm. The result is
 * always at least 1. Returns 1 for an empty or whitespace-only body so
 * "0 min" never appears in a UI.
 */
export function readingTime(page: ContentPage): number {
  const text = htmlToText(page.html);
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  const minutes = Math.ceil(words / WORDS_PER_MINUTE);
  return Math.max(1, minutes);
}
