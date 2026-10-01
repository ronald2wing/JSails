/**
 * Markdown rendering tests: leading-H1 stripping from html and toc, and the
 * reading-time estimate (minimum 1, scales with length).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readingTime, type ContentPage } from '../src/index.js';
import { renderMarkdown } from '../src/render.js';
import { postsCollection } from './fixtures.js';

describe('renderMarkdown H1 stripping', () => {
  it('strips the leading H1 heading from html and toc', async () => {
    // `renderMarkdown` receives the markdown body without frontmatter.
    const body = `# My Title

First paragraph.

## A section

Section content.
`;

    const { html, toc } = await renderMarkdown(body);

    // The leading H1 is stripped so it never duplicates the page's <h1> title.
    assert.ok(!html.includes('<h1'), 'rendered html must not contain <h1');

    // The first rendered content should be the paragraph or the ## section.
    assert.ok(html.includes('First paragraph'), 'rendered html must contain the first paragraph');
    assert.ok(html.includes('A section'), 'rendered html must contain the ## section');

    // TOC must have no depth-1 entry from the stripped H1.
    const depth1 = toc.filter((h) => h.depth === 1);
    assert.equal(depth1.length, 0, 'toc must not contain a depth-1 entry');

    // TOC must still contain the ## section.
    const sectionEntry = toc.find((h) => h.text === 'A section');
    assert.ok(sectionEntry, 'toc must contain the ## section');
    assert.equal(sectionEntry.depth, 2);
  });

  it('leaves a doc with no leading H1 unchanged', async () => {
    // Doc starts at ##, so the first heading is depth 2 — no strip.
    const body = `## First section

Content.

### Nested

More content.
`;

    const { html, toc } = await renderMarkdown(body);

    // The ## heading is preserved in both html and toc.
    assert.ok(html.includes('<h2'), 'rendered html must contain <h2');
    assert.ok(html.includes('First section'), 'rendered html must contain the heading');

    const depth2 = toc.filter((h) => h.depth === 2);
    assert.equal(depth2.length, 1, 'toc must contain the ## section');
    assert.equal(depth2[0]?.text, 'First section');

    const depth3 = toc.filter((h) => h.depth === 3);
    assert.equal(depth3.length, 1, 'toc must contain the ### subsection');
    assert.equal(depth3[0]?.text, 'Nested');
  });

  it('leaves a non-leading H1 later in the body intact', async () => {
    // H1 is NOT the first heading — it appears after a paragraph.
    const body = `Intro paragraph.

# A later H1

Body after.
`;

    const { html, toc } = await renderMarkdown(body);

    // The paragraph is the leading content, not the H1.
    assert.ok(html.includes('Intro paragraph'), 'rendered html must contain intro');

    // The H1 appears later and is NOT stripped.
    assert.ok(html.includes('<h1'), 'rendered html must contain <h1');
    assert.ok(html.includes('A later H1'), 'rendered html must contain the later H1');

    const depth1 = toc.filter((h) => h.depth === 1);
    assert.equal(depth1.length, 1, 'toc must contain the later H1');
    assert.equal(depth1[0]?.text, 'A later H1');
  });
});

describe('readingTime', () => {
  it('returns at least 1 minute', () => {
    const page: ContentPage = {
      slug: 'empty',
      section: '',
      title: 'Empty',
      order: 1,
      html: '',
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    assert.equal(readingTime(page), 1);
  });

  it('scales with word count (~200 wpm)', () => {
    // Build a page with ~400 words → 2 minutes.
    const words = Array.from({ length: 400 }, () => 'word').join(' ');
    const html = `<p>${words}</p>`;
    const page: ContentPage = {
      slug: 'long',
      section: '',
      title: 'Long',
      order: 1,
      html,
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    assert.equal(readingTime(page), 2);
  });

  it('rounds up fractional minutes', () => {
    // 201 words → ceil(201/200) = ceil(1.005) = 2.
    const words = Array.from({ length: 201 }, () => 'word').join(' ');
    const html = `<p>${words}</p>`;
    const page: ContentPage = {
      slug: 'frac',
      section: '',
      title: 'Fractional',
      order: 1,
      html,
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    assert.equal(readingTime(page), 2);
  });

  it('handles real rendered HTML', async (t) => {
    const collection = await postsCollection(t);
    const postA = collection.getEntry('post-a');
    assert.ok(postA);
    const rt = readingTime(postA);

    // The fixture has ~30 words → ceil(30/200) = 1.
    assert.ok(rt >= 1);
    assert.ok(rt <= 5, 'reading time should be small for a short post');
  });

  it('strips HTML tags before counting', () => {
    const html = '<p>Hello <strong>world</strong> from <em>space</em>.</p>';
    const page: ContentPage = {
      slug: 'tagged',
      section: '',
      title: 'Tagged',
      order: 1,
      html,
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    // "Hello world from space." → 4 words → 1 min.
    assert.equal(readingTime(page), 1);
  });
});
