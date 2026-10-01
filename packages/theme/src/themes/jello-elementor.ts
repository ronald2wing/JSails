/**
 * Jello Elementor: the first-party, Bricks-inspired blog theme.
 *
 * A complete, functional blog theme — not an Elementor clone. It supplies
 * design tokens, scoped CSS, and declarative layouts for the blog shell
 * (header/footer), index/archive, single post, and error state. Layouts are
 * data validated by the same safe template renderer as every other theme; no
 * theme code is executed.
 *
 * The name is intentional: "Jello" for the soft, rounded visual language and
 * "Elementor" as a nod to visual theme composition, while JSails keeps the
 * actual contract declarative and server-safe.
 */

import type { ThemeLayoutName, ThemeTemplateNode } from '../packages/index.js';
import type { ThemeTemplate } from '../packages/template.js';

/** Build a validated-shape layout object (validation happens at discovery). */
function layout(name: ThemeLayoutName, root: ThemeTemplateNode): ThemeTemplate {
  return { version: 1, name, root };
}

/** An element node. */
function element(
  tag: Extract<ThemeTemplateNode, { type: 'element' }>['tag'],
  children: readonly ThemeTemplateNode[] = [],
  attributes?: Readonly<Record<string, string>>,
): ThemeTemplateNode {
  return {
    type: 'element',
    tag,
    ...(attributes === undefined ? {} : { attributes }),
    children: [...children],
  };
}

/** A text node. */
function text(value: string): ThemeTemplateNode {
  return { type: 'text', value };
}

/** A trusted slot node. */
function slot(name: string): ThemeTemplateNode {
  return { type: 'slot', name };
}

const css = `
.jello-header {
  border-bottom: 1px solid var(--jsails-border, #ded7ca);
  background: color-mix(in srgb, var(--jsails-bg, #fbfaf6) 92%, transparent);
  backdrop-filter: blur(14px);
}
.jello-header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding-block: 1rem;
}
.jello-shell {
  width: min(1120px, calc(100% - 2rem));
  margin-inline: auto;
}
.jello-brand {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--jsails-fg, #191919);
  font-weight: 750;
  letter-spacing: -0.03em;
  text-decoration: none;
}
.jello-mark {
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: 0.7rem;
  background: var(--jsails-accent, #e11d63);
  color: #fff;
  font-size: 0.95rem;
}
.jello-nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  color: var(--jsails-muted-fg, #5f5a52);
  font-size: 0.9rem;
}
.jello-nav a {
  border-radius: 999px;
  padding: 0.45rem 0.7rem;
  color: inherit;
  text-decoration: none;
}
.jello-nav a:hover {
  background: var(--jsails-muted, #f0ece4);
  color: var(--jsails-fg, #191919);
}
.jello-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
}
.jello-actions a {
  border-radius: 999px;
  padding: 0.5rem 0.85rem;
  color: var(--jsails-fg, #191919);
  text-decoration: none;
}
.jello-actions a:last-child {
  background: var(--jsails-accent, #e11d63);
  color: #fff;
}
.jello-blog {
  padding-block: clamp(2.5rem, 6vw, 5rem);
}
.jello-hero {
  max-width: 44rem;
  margin-bottom: 2.5rem;
}
.jello-eyebrow {
  margin: 0 0 0.75rem;
  color: var(--jsails-accent, #e11d63);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.jello-hero h1,
.jello-post h1,
.jello-error h1 {
  margin: 0;
  font-size: clamp(2.25rem, 5vw, 4.5rem);
  line-height: 0.98;
  letter-spacing: -0.055em;
}
.jello-hero p {
  margin: 1rem 0 0;
  color: var(--jsails-muted-fg, #5f5a52);
  font-size: 1.05rem;
  line-height: 1.7;
}
.jello-grid {
  display: grid;
  gap: 1rem;
}
.jello-grid > * {
  border: 1px solid var(--jsails-border, #ded7ca);
  border-radius: var(--jsails-radius, 0.9rem);
  background: var(--jsails-surface, #fff);
  padding: 1.15rem;
}
.jello-post {
  padding-block: clamp(2.5rem, 6vw, 5rem);
}
.jello-post > header {
  max-width: 46rem;
  margin-bottom: 2rem;
}
.jello-meta {
  margin-top: 1rem;
  color: var(--jsails-muted-fg, #5f5a52);
  font-size: 0.9rem;
}
.jello-body {
  max-width: 46rem;
  color: var(--jsails-fg, #191919);
  font-size: 1.05rem;
  line-height: 1.8;
}
.jello-body h2,
.jello-body h3 {
  letter-spacing: -0.03em;
}
.jello-body a {
  color: var(--jsails-accent, #e11d63);
}
.jello-body img {
  max-width: 100%;
  border-radius: var(--jsails-radius, 0.9rem);
}
.jello-back {
  display: inline-block;
  margin-top: 2.5rem;
  color: var(--jsails-accent, #e11d63);
  font-weight: 650;
  text-decoration: none;
}
.jello-footer {
  border-top: 1px solid var(--jsails-border, #ded7ca);
  color: var(--jsails-muted-fg, #5f5a52);
  font-size: 0.875rem;
}
.jello-footer-inner {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 1rem;
  padding-block: 1.5rem;
}
.jello-footer nav {
  display: flex;
  gap: 1rem;
}
.jello-footer a {
  color: inherit;
}
.jello-error {
  padding-block: 4rem;
  text-align: center;
}
.jello-error p {
  color: var(--jsails-muted-fg, #5f5a52);
}
@media (max-width: 720px) {
  .jello-header-inner {
    flex-wrap: wrap;
  }
  .jello-nav {
    order: 3;
    width: 100%;
  }
}
`;

const jelloElementorManifest = {
  name: 'jello-elementor',
  version: '1.0.0',
  description:
    'Jello Elementor: a soft, editorial, Bricks-inspired blog theme with a functional shell.',
  author: 'JSails',
  tokens: {
    '--jsails-bg': '#fbfaf6',
    '--jsails-fg': '#191919',
    '--jsails-accent': '#e11d63',
    '--jsails-muted': '#f0ece4',
    '--jsails-muted-fg': '#5f5a52',
    '--jsails-border': '#ded7ca',
    '--jsails-surface': '#ffffff',
    '--jsails-radius': '0.9rem',
  },
  contentTypes: ['article', 'page'],
  css,
  layouts: {
    header: layout(
      'header',
      element(
        'header',
        [
          element(
            'div',
            [
              element(
                'a',
                [
                  element('span', [text('J')], {
                    class: 'jello-mark',
                    'aria-hidden': 'true',
                  }),
                  slot('siteName'),
                ],
                { class: 'jello-brand', href: '/' },
              ),
              element('nav', [slot('navigation')], {
                class: 'jello-nav',
                'aria-label': 'Primary',
              }),
              element('div', [slot('actions')], { class: 'jello-actions' }),
            ],
            { class: 'jello-shell jello-header-inner' },
          ),
        ],
        { class: 'jello-header' },
      ),
    ),
    footer: layout(
      'footer',
      element(
        'footer',
        [
          element(
            'div',
            [
              element('p', [slot('copyright')], { class: 'jello-copyright' }),
              element('nav', [slot('navigation')], { 'aria-label': 'Footer' }),
            ],
            { class: 'jello-shell jello-footer-inner' },
          ),
        ],
        { class: 'jello-footer' },
      ),
    ),
    blogIndex: layout(
      'blogIndex',
      element(
        'div',
        [
          element(
            'header',
            [
              element('p', [text('Journal')], { class: 'jello-eyebrow' }),
              element('h1', [slot('heading')]),
              element('p', [slot('description')]),
            ],
            { class: 'jello-hero' },
          ),
          element('div', [slot('posts')], { class: 'jello-grid' }),
        ],
        { class: 'jello-shell jello-blog' },
      ),
    ),
    blogArchive: layout(
      'blogArchive',
      element(
        'div',
        [
          element(
            'header',
            [
              element('p', [text('Archive')], { class: 'jello-eyebrow' }),
              element('h1', [slot('heading')]),
              element('p', [slot('description')]),
            ],
            { class: 'jello-hero' },
          ),
          element('div', [slot('posts')], { class: 'jello-grid' }),
        ],
        { class: 'jello-shell jello-blog' },
      ),
    ),
    blogSingle: layout(
      'blogSingle',
      element(
        'article',
        [
          element('header', [
            element('p', [text('Blog')], { class: 'jello-eyebrow' }),
            element('h1', [slot('title')]),
            element('p', [slot('meta')], { class: 'jello-meta' }),
          ]),
          element('div', [slot('body')], { class: 'jello-body' }),
          element('a', [slot('back')], { class: 'jello-back', href: '/blog' }),
        ],
        { class: 'jello-shell jello-post' },
      ),
    ),
    blogError: layout(
      'blogError',
      element(
        'div',
        [
          element('p', [text('404')], { class: 'jello-eyebrow' }),
          element('h1', [slot('message')]),
          element('p', [text('That page could not be found.')]),
          element('a', [text('Back to the blog')], { class: 'jello-back', href: '/blog' }),
        ],
        { class: 'jello-shell jello-error' },
      ),
    ),
  },
} as const;

/** The Jello Elementor discovery entry, included in the built-in theme set. */
export const jelloElementorTheme = {
  path: 'jello-elementor',
  manifest: jelloElementorManifest,
};
