/**
 * Sitemap tests: one url per non-draft page, lastmod from date, and the
 * value-free error on a bad siteUrl.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ContentError, defineContentCollection, renderSitemap } from '../src/index.js';
import { tempRoot, writeFiles, postsCollection } from './fixtures.js';

describe('renderSitemap', () => {
  it('produces well-formed sitemap XML', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderSitemap(collection, {
      siteUrl: 'https://example.com',
    });

    assert.ok(xml.includes('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
    assert.ok(xml.includes('</urlset>'));
  });

  it('emits one <url> per non-draft page', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderSitemap(collection, {
      siteUrl: 'https://example.com',
    });

    const urlCount = (xml.match(/<url>/g) ?? []).length;
    assert.equal(urlCount, 3);

    // Draft must not appear.
    assert.ok(!xml.includes('draft-post'));
  });

  it('emits <lastmod> from page date', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderSitemap(collection, {
      siteUrl: 'https://example.com',
    });

    // Post B has date 2026-10-10.
    assert.ok(xml.includes('<lastmod>2026-10-10</lastmod>'));
  });

  it('does not emit lastmod for pages without a date', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderSitemap(collection, {
      siteUrl: 'https://example.com',
    });

    // Find the <url> block for the no-date page.
    const noDateIdx = xml.indexOf('<loc>https://example.com/no-date</loc>');
    assert.ok(noDateIdx >= 0, 'no-date page should have a <loc>');
    const nextCloseIdx = xml.indexOf('</url>', noDateIdx);
    assert.ok(nextCloseIdx >= 0);
    const urlBlock = xml.substring(noDateIdx, nextCloseIdx);

    assert.ok(!urlBlock.includes('<lastmod>'), 'no-date page must not emit <lastmod>');
  });

  it('uses urlFor override', async (t) => {
    const collection = await postsCollection(t);
    const xml = renderSitemap(collection, {
      siteUrl: 'https://example.com',
      urlFor: (p) => `https://example.com/posts/${p.slug}`,
    });

    assert.ok(xml.includes('<loc>https://example.com/posts/post-b</loc>'));
  });

  it('escapes XML special characters in loc', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, {
      'amp.md': `---
title: Ampersand &amp; Co
date: 2026-10-01
---
# Amp

Content.
`,
    });
    const collection = await defineContentCollection({
      dir: root,
      cacheDir: join(root, '.cache'),
    });

    // Exercise urlFor escaping via `&` in the URL query string.
    const xml2 = renderSitemap(collection, {
      siteUrl: 'https://example.com',
      urlFor: () => 'https://example.com/foo?bar=baz&qux=quux',
    });
    assert.ok(xml2.includes('foo?bar=baz&amp;qux=quux'));
  });

  it('throws value-free ContentError on missing siteUrl', () => {
    assert.throws(
      () =>
        renderSitemap(
          {
            pages: [],
            search: [],
            getEntry: () => undefined,
            getEntries: () => [],
            getStaticPaths: () => [],
            prevNext: () => undefined,
          },
          { siteUrl: '' },
        ),
      (e: unknown) => {
        assert.ok(e instanceof ContentError);
        assert.equal(e.code, 'invalid_site_url');
        return true;
      },
    );
  });
});
