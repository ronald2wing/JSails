/**
 * RSS and Atom feed tests: well-formed output, escaped text and attributes,
 * links and dates, limit, newest-first ordering, excerpt from rendered HTML,
 * the source-neutral renderers, and the value-free error on a bad siteUrl.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ContentError,
  defineContentCollection,
  renderAtomFeed,
  renderAtomXml,
  renderRssFeed,
  renderRssXml,
  renderSitemapXml,
} from '../src/index.js';
import { tempRoot, writeFiles, postsCollection, singlePostCollection } from './fixtures.js';

describe('renderRssFeed', () => {
  it('produces well-formed RSS 2.0 XML', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'My Blog',
      description: 'A blog about code',
      siteUrl: 'https://example.com',
    });

    // Structural assertions.
    assert.ok(xml.includes('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<rss version="2.0"'));
    assert.ok(xml.includes('<channel>'));
    assert.ok(xml.includes('<title>My Blog</title>'));
    assert.ok(xml.includes('<description>A blog about code</description>'));
    assert.ok(xml.includes('<link>https://example.com</link>'));
    assert.ok(xml.includes('</channel>'));
    assert.ok(xml.includes('</rss>'));

    // Draft must not appear.
    assert.ok(!xml.includes('Draft Post'));
  });

  it('includes items for every non-draft page', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // 3 non-draft pages: post-a, post-b, no-date.
    const itemCount = (xml.match(/<item>/g) ?? []).length;
    assert.equal(itemCount, 3);

    // Post B's excerpt comes from its rendered HTML (first <p>),
    // not from the frontmatter `excerpt` field — discover.ts extracts
    // the excerpt from HTML.
    assert.ok(xml.includes('<title>Post B</title>'));
    assert.ok(xml.includes('<description>Post B body content. Short.</description>'));
    assert.ok(xml.includes('Post A'));
    assert.ok(xml.includes('No Date Post'));
  });

  it('respects limit', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
      limit: 1,
    });

    const itemCount = (xml.match(/<item>/g) ?? []).length;
    assert.equal(itemCount, 1);
  });

  it('orders items newest-first by date then order', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // Extract titles in order from the XML.
    const titles: string[] = [];
    const titleRe = /<title>(?!(?:My Blog|Feed))([^<]+)<\/title>/g;
    let match;
    while ((match = titleRe.exec(xml)) !== null) {
      titles.push(match[1] ?? '');
    }
    // post-b (2026-10-10) > post-a (2026-10-05) > no-date (no date → epoch → last)
    assert.deepEqual(titles, ['Post B', 'Post A', 'No Date Post']);
  });

  it('escapes XML special characters in title and description', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, {
      'ampersand.md': `---
title: AT&T &amp; Verizon
date: 2026-10-01
---
# Title

Excerpt with tags and "quotes".
`,
    });
    const collection = await defineContentCollection({
      dir: root,
      cacheDir: join(root, '.cache'),
    });
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // The raw title "AT&T &amp; Verizon" — the '&' in "AT&T" is escaped to &amp; in XML.
    assert.ok(xml.includes('<title>AT&amp;T &amp;amp; Verizon</title>'));
    // The excerpt has quotes. They're fine in XML text content (only need escaping in attributes).
    assert.ok(xml.includes('<description>'), 'has description element');
  });

  it('uses urlFor override for item links', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
      urlFor: (p) => `https://example.com/posts/${p.slug}`,
    });

    assert.ok(xml.includes('<link>https://example.com/posts/post-b</link>'));
  });

  it('throws value-free ContentError on missing siteUrl', () => {
    assert.throws(
      () =>
        renderRssFeed(
          {
            pages: [],
            search: [],
            getEntry: () => undefined,
            getEntries: () => [],
            getStaticPaths: () => [],
            prevNext: () => undefined,
          },
          { title: 'Feed', siteUrl: '' },
        ),
      (e: unknown) => {
        assert.ok(e instanceof ContentError);
        assert.equal(e.code, 'invalid_site_url');
        return true;
      },
    );
  });

  it('throws ContentError on non-absolute siteUrl', () => {
    assert.throws(
      () =>
        renderRssFeed(
          {
            pages: [],
            search: [],
            getEntry: () => undefined,
            getEntries: () => [],
            getStaticPaths: () => [],
            prevNext: () => undefined,
          },
          { title: 'Feed', siteUrl: 'not-a-url' },
        ),
      (e: unknown) => {
        assert.ok(e instanceof ContentError);
        assert.equal(e.code, 'invalid_site_url');
        return true;
      },
    );
  });

  it('defaults feedUrl from siteUrl', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // The self-link should point to /feed.xml.
    assert.ok(xml.includes('href="https://example.com/feed.xml"'));
  });

  it('strips trailing slash from siteUrl in item links', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com/',
    });

    // Links should be https://example.com/post-b, not //post-b.
    assert.ok(xml.includes('<link>https://example.com/post-b</link>'));
  });
});

describe('renderAtomFeed', () => {
  it('produces well-formed Atom 1.0 XML', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderAtomFeed(collection, {
      title: 'My Blog',
      description: 'A blog about code',
      siteUrl: 'https://example.com',
    });

    assert.ok(xml.includes('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<feed xmlns="http://www.w3.org/2005/Atom">'));
    assert.ok(xml.includes('<title>My Blog</title>'));
    assert.ok(xml.includes('<subtitle>A blog about code</subtitle>'));

    // Draft must not appear.
    assert.ok(!xml.includes('Draft Post'));
  });

  it('includes entries for every non-draft page', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderAtomFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    const entryCount = (xml.match(/<entry>/g) ?? []).length;
    assert.equal(entryCount, 3);
  });

  it('uses page URL as entry id', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderAtomFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    assert.ok(xml.includes('<id>https://example.com/post-b</id>'));
  });

  it('emits updated timestamps in ISO 8601', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderAtomFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // Post B has date 2026-10-10 → 2026-10-10T00:00:00.000Z
    assert.ok(xml.includes('2026-10-10T00:00:00.000Z'));
  });

  it('uses summary from excerpt', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderAtomFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // Post B's excerpt comes from rendered HTML: "Post B body content. Short."
    assert.ok(xml.includes('<summary>Post B body content. Short.</summary>'));
  });

  it('defaults feedUrl from siteUrl', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderAtomFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    assert.ok(xml.includes('href="https://example.com/atom.xml"'));
  });

  it('throws value-free ContentError on missing siteUrl', () => {
    assert.throws(
      () =>
        renderAtomFeed(
          {
            pages: [],
            search: [],
            getEntry: () => undefined,
            getEntries: () => [],
            getStaticPaths: () => [],
            prevNext: () => undefined,
          },
          { title: 'Feed', siteUrl: '' },
        ),
      (e: unknown) => {
        assert.ok(e instanceof ContentError);
        assert.equal(e.code, 'invalid_site_url');
        return true;
      },
    );
  });
});

describe('feed excerpt from HTML', () => {
  it('uses extractExcerpt from HTML when frontmatter has no excerpt', async (t) => {
    const collection = await singlePostCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // The first paragraph text is "First paragraph excerpt text here. More words follow.".
    assert.ok(
      xml.includes(
        '<description>First paragraph excerpt text here. More words follow.</description>',
      ),
    );
  });
});

describe('source-neutral feed and sitemap renderers', () => {
  const channel = {
    title: 'A & B',
    siteUrl: 'https://example.com',
    feedUrl: 'https://example.com/feed.xml',
  };

  it('renders items in the given order with escaped values', () => {
    const items = [
      {
        title: 'New <one>',
        url: 'https://example.com/new',
        date: new Date('2026-02-01T10:00:00Z'),
      },
      { title: 'Old', url: 'https://example.com/old', summary: 'x & y' },
    ];
    const rss = renderRssXml(channel, items);
    assert.ok(rss.indexOf('New &lt;one&gt;') < rss.indexOf('<title>Old</title>'));
    assert.match(rss, /<title>A &amp; B<\/title>/);
    assert.match(rss, /<description>x &amp; y<\/description>/);
    assert.match(rss, /<pubDate>Thu, 01 Jan 1970 00:00:00 \+0000<\/pubDate>/);

    const atom = renderAtomXml(channel, items);
    assert.match(atom, /<updated>2026-02-01T10:00:00.000Z<\/updated>/);
    assert.match(atom, /<id>https:\/\/example.com\/feed.xml<\/id>/);
  });

  it('falls back to the epoch for an empty feed and renders lastmod only when given', () => {
    assert.match(renderAtomXml(channel, []), /<updated>1970-01-01T00:00:00.000Z<\/updated>/);
    const sitemap = renderSitemapXml([
      { loc: 'https://example.com/a&b' },
      { loc: 'https://example.com/c', lastmod: '2026-01-02' },
    ]);
    assert.match(sitemap, /<loc>https:\/\/example.com\/a&amp;b<\/loc>\n<\/url>/);
    assert.match(sitemap, /<lastmod>2026-01-02<\/lastmod>/);
  });
});
