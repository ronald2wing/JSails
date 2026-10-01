import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cachePlugin } from '@jsails/cache';
import { configPlugin, configToken } from '@jsails/config';

import { createMemoryBlogRepository, type BlogRepository } from '../src/cms/index.js';
import { calendarDay } from '../src/discovery.js';
import { blogPlugin } from '../src/plugin.js';
import { blogSiteConfig } from '../src/site-config.js';
import { makeApp, seedInput } from './fixtures.js';

/**
 * Tests for the blog plugin's public discovery routes: the paginated index,
 * category/tag listings, RSS/Atom feeds, and the sitemap. The plugin runs
 * in an in-process app, so its routes take the real request pipeline;
 * requests are driven in-process against the injected in-memory
 * repository, so published-only filtering, escaping, and XML validity are all
 * exercised without a listener or database.
 */

/** Seed `count` published posts with distinct ascending slugs. */
async function seedPublished(repository: BlogRepository, count: number): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    await repository.createPost(
      seedInput({ title: `Post ${i}`, slug: `post-${i}`, excerpt: `excerpt ${i}` }),
    );
  }
}

/**
 * A repository whose clock advances one second per call, so the newest-first
 * order of published posts is deterministic (`post-<count>` is newest).
 */
function clockedRepository(): BlogRepository {
  let tick = 0;
  return createMemoryBlogRepository({ now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
}

describe('blog discovery: paginated index', () => {
  it('falls back to page 1 for non-positive and non-numeric page values', async () => {
    const { app, runtime, repository } = await makeApp({ repository: clockedRepository() });
    await seedPublished(repository, 1);

    for (const page of ['0', '-1', 'abc', '1.5', '']) {
      const response = await app.request(page === '' ? '/blog' : `/blog?page=${page}`);
      assert.equal(response.status, 200, `page=${page} must not 500`);
      const html = await response.text();
      assert.match(html, /Post 1/);
    }

    await runtime.close();
  });

  it('paginates newest-first with a fixed page size and prev/next links', async () => {
    const { app, runtime, repository } = await makeApp({ repository: clockedRepository() });
    await seedPublished(repository, 11);

    const first = await (await app.request('/blog')).text();
    assert.match(first, /Post 11/); // newest first
    assert.match(first, /Post 2<\/a>/);
    assert.doesNotMatch(first, />Post 1<\/a>/);
    assert.match(first, /rel="next"/);
    assert.doesNotMatch(first, /rel="prev"/);

    const second = await (await app.request('/blog?page=2')).text();
    assert.match(second, />Post 1<\/a>/); // oldest on the last page
    assert.doesNotMatch(second, /Post 11/);
    assert.match(second, /rel="prev"/);
    assert.doesNotMatch(second, /rel="next"/);

    await runtime.close();
  });

  it('clamps an out-of-range page to the last page without a 500', async () => {
    const { app, runtime, repository } = await makeApp({ repository: clockedRepository() });
    await seedPublished(repository, 11);

    const response = await app.request('/blog?page=999');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, />Post 1<\/a>/); // last page holds the oldest post
    assert.match(html, /rel="prev"/);

    await runtime.close();
  });

  it('links titles to /blog/<slug> and escapes the title', async () => {
    const { app, runtime, repository } = await makeApp();
    await repository.createPost(seedInput({ title: '<b>Shout</b>', slug: 'shout' }));

    const html = await (await app.request('/blog')).text();
    assert.match(html, /href="\/blog\/shout"/);
    assert.match(html, /&lt;b&gt;Shout&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<b>Shout<\/b>/);

    await runtime.close();
  });
});

describe('blog discovery: category and tag listings', () => {
  it('lists published posts in the matching category with its name in the heading', async () => {
    const { app, runtime, repository } = await makeApp();
    const category = await repository.createCategory({ name: 'News', slug: 'news' });
    const other = await repository.createCategory({ name: 'Tech', slug: 'tech' });
    await repository.createPost(
      seedInput({ title: 'In News', slug: 'in-news', categoryIds: [category.id] }),
    );
    await repository.createPost(
      seedInput({ title: 'In Tech', slug: 'in-tech', categoryIds: [other.id] }),
    );
    await repository.createPost(seedInput({ title: 'Draft', slug: 'draft', status: 'draft' }));

    const html = await (await app.request('/blog/category/news')).text();
    assert.match(html, /<h1>News<\/h1>/);
    assert.match(html, /In News/);
    assert.doesNotMatch(html, /In Tech/);
    assert.doesNotMatch(html, /Draft/);

    await runtime.close();
  });

  it('lists published posts with the matching tag', async () => {
    const { app, runtime, repository } = await makeApp();
    const tag = await repository.createTag({ name: 'Tutorial', slug: 'tutorial' });
    await repository.createPost(seedInput({ title: 'How-to', slug: 'how-to', tagIds: [tag.id] }));
    await repository.createPost(seedInput({ title: 'Other', slug: 'other', tagIds: [] }));

    const html = await (await app.request('/blog/tag/tutorial')).text();
    assert.match(html, /<h1>Tutorial<\/h1>/);
    assert.match(html, /How-to/);
    assert.doesNotMatch(html, /Other/);

    await runtime.close();
  });

  it('returns 404 for an unknown category or tag slug', async () => {
    const { app, runtime } = await makeApp();

    assert.equal((await app.request('/blog/category/missing')).status, 404);
    assert.equal((await app.request('/blog/tag/missing')).status, 404);

    await runtime.close();
  });

  it('escapes category and tag headings', async () => {
    const { app, runtime, repository } = await makeApp();
    await repository.createCategory({ name: '<i>Hacks</i>', slug: 'hacks' });
    await repository.createTag({ name: '<b>Bold</b>', slug: 'bold' });

    const categoryHtml = await (await app.request('/blog/category/hacks')).text();
    assert.match(categoryHtml, /<h1>&lt;i&gt;Hacks&lt;\/i&gt;<\/h1>/);
    assert.doesNotMatch(categoryHtml, /<i>Hacks<\/i>/);

    const tagHtml = await (await app.request('/blog/tag/bold')).text();
    assert.match(tagHtml, /<h1>&lt;b&gt;Bold&lt;\/b&gt;<\/h1>/);
    assert.doesNotMatch(tagHtml, /<b>Bold<\/b>/);

    await runtime.close();
  });
});

describe('blog discovery: feeds', () => {
  it('renders a valid RSS feed with escaped title and description', async () => {
    const { app, runtime, repository } = await makeApp({}, { origin: 'https://example.com' });
    await repository.createPost(
      seedInput({ title: 'A & B < C', slug: 'a-b', excerpt: 'x & y < z' }),
    );

    const response = await app.request('/blog/rss.xml');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/rss\+xml/);
    const xml = await response.text();
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<rss version="2.0"/);
    assert.match(xml, /<title>A &amp; B &lt; C<\/title>/);
    assert.match(xml, /<description>x &amp; y &lt; z<\/description>/);
    assert.match(xml, /<link>https:\/\/example\.com\/blog\/a-b<\/link>/);
    assert.match(xml, /<pubDate>/);

    await runtime.close();
  });

  it('renders a valid Atom feed with an ISO updated timestamp', async () => {
    const { app, runtime, repository } = await makeApp({}, { origin: 'https://example.com' });
    await repository.createPost(seedInput({ title: 'Atom', slug: 'atom' }));

    const response = await app.request('/blog/atom.xml');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/atom\+xml/);
    const xml = await response.text();
    assert.match(xml, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
    assert.match(xml, /<title>Atom<\/title>/);
    assert.match(xml, /<id>https:\/\/example\.com\/blog\/atom<\/id>/);
    assert.match(xml, /<updated>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z<\/updated>/);

    await runtime.close();
  });

  it('excludes drafts from both feeds', async () => {
    const { app, runtime, repository } = await makeApp();
    await repository.createPost(seedInput({ title: 'Public', slug: 'public' }));
    await repository.createPost(seedInput({ title: 'Secret', slug: 'secret', status: 'draft' }));

    const rss = await (await app.request('/blog/rss.xml')).text();
    assert.doesNotMatch(rss, /Secret/);
    assert.match(rss, /Public/);

    const atom = await (await app.request('/blog/atom.xml')).text();
    assert.doesNotMatch(atom, /Secret/);
    assert.match(atom, /Public/);

    await runtime.close();
  });

  it('renders an empty feed without items when nothing is published', async () => {
    const { app, runtime, repository } = await makeApp();
    await repository.createPost(seedInput({ title: 'Draft', slug: 'draft', status: 'draft' }));

    const rss = await (await app.request('/blog/rss.xml')).text();
    assert.doesNotMatch(rss, /<item>/);
    assert.match(rss, /<channel>/);

    await runtime.close();
  });
});

describe('blog discovery: sitemap', () => {
  it('lists /blog plus every published post, excluding drafts', async () => {
    const { app, runtime, repository } = await makeApp({}, { origin: 'https://example.com' });
    await repository.createPost(seedInput({ title: 'One', slug: 'one' }));
    await repository.createPost(seedInput({ title: 'Two', slug: 'two' }));
    await repository.createPost(seedInput({ title: 'Draft', slug: 'draft', status: 'draft' }));

    const response = await app.request('/blog/sitemap.xml');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/xml/);
    const xml = await response.text();
    assert.match(xml, /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
    assert.match(xml, /<loc>https:\/\/example\.com\/blog<\/loc>/);
    assert.match(xml, /<loc>https:\/\/example\.com\/blog\/one<\/loc>/);
    assert.match(xml, /<loc>https:\/\/example\.com\/blog\/two<\/loc>/);
    assert.doesNotMatch(xml, /\/blog\/draft/);

    await runtime.close();
  });

  it('dates <lastmod> in the configured time zone', () => {
    // 23:30 UTC on Jan 1 is already Jan 2 at UTC+14.
    assert.equal(calendarDay('2026-01-01T23:30:00.000Z', 'Pacific/Kiritimati'), '2026-01-02');
    assert.equal(calendarDay('2026-01-01T23:30:00.000Z', 'UTC'), '2026-01-01');
    assert.equal(calendarDay('2026-01-01T23:30:00.000Z', 'Not/AZone'), '2026-01-01');
    assert.equal(calendarDay('not a date', 'UTC'), undefined);
  });
});

/**
 * A repository whose full-table read fails: the public routes must query only
 * the page they render, never `listPosts` (which loads every post's body).
 */
function pagedOnly(repository: BlogRepository): BlogRepository {
  return {
    ...repository,
    listPosts: () => Promise.reject(new Error('public routes must not load every post')),
  };
}

describe('blog discovery: bounded repository reads', () => {
  it('serves every public route without loading the whole posts table', async () => {
    const backing = createMemoryBlogRepository();
    const category = await backing.createCategory({ name: 'News', slug: 'news' });
    const tag = await backing.createTag({ name: 'How', slug: 'how' });
    await backing.createPost(
      seedInput({ title: 'One', slug: 'one', categoryIds: [category.id], tagIds: [tag.id] }),
    );
    const { app, runtime } = await makeApp({ repository: pagedOnly(backing) });

    for (const path of [
      '/blog',
      '/blog/category/news',
      '/blog/tag/how',
      '/blog/rss.xml',
      '/blog/atom.xml',
      '/blog/sitemap.xml',
    ]) {
      const response = await app.request(path);
      assert.equal(response.status, 200, `${path} must not read the full table`);
      assert.match(await response.text(), /one|One/);
    }

    await runtime.close();
  });

  it('paginates a term archive with links back to the archive path', async () => {
    const { app, runtime, repository } = await makeApp({ repository: clockedRepository() });
    const category = await repository.createCategory({ name: 'News', slug: 'news' });
    for (let i = 1; i <= 12; i += 1) {
      await repository.createPost(
        seedInput({ title: `News ${i}`, slug: `news-${i}`, categoryIds: [category.id] }),
      );
    }

    const first = await (await app.request('/blog/category/news')).text();
    assert.match(first, />News 12<\/a>/);
    assert.doesNotMatch(first, />News 2<\/a>/);
    assert.match(first, /href="\/blog\/category\/news\?page=2" rel="next"/);

    const second = await (await app.request('/blog/category/news?page=2')).text();
    assert.match(second, />News 1<\/a>/);
    assert.match(second, /href="\/blog\/category\/news\?page=1" rel="prev"/);

    await runtime.close();
  });

  it('caps the feeds at the configured item count, newest first', async () => {
    const { app, runtime, repository } = await makeApp({
      repository: clockedRepository(),
      feedLimit: 2,
    });
    await seedPublished(repository, 5);

    const rss = await (await app.request('/blog/rss.xml')).text();
    assert.equal(rss.match(/<item>/g)?.length, 2);
    assert.match(rss, /Post 5/);
    assert.doesNotMatch(rss, /Post 3/);

    await runtime.close();
  });
});

describe('blog discovery: configured public origin', () => {
  it('builds feed and sitemap links on siteUrl, whatever Host the request claims', async () => {
    const { app, runtime, repository } = await makeApp(
      { siteUrl: 'https://blog.example/' },
      { origin: 'http://attacker.example' },
    );
    await repository.createPost(seedInput({ title: 'One', slug: 'one' }));

    for (const path of ['/blog/rss.xml', '/blog/atom.xml', '/blog/sitemap.xml']) {
      const response = await app.request(path);
      const xml = await response.text();
      assert.match(xml, /https:\/\/blog\.example\/blog\/one/);
      assert.doesNotMatch(xml, /attacker\.example/);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
    }

    await runtime.close();
  });

  it('keeps request-origin feeds out of shared caches', async () => {
    const { app, runtime } = await makeApp({}, { origin: 'https://example.com' });

    const response = await app.request('/blog/rss.xml');

    assert.doesNotMatch(response.headers.get('cache-control') ?? '', /public/);
    await runtime.close();
  });

  it('rejects a siteUrl that is not an absolute http(s) origin', () => {
    for (const siteUrl of ['blog.example', 'javascript:alert(1)', 'https://u:p@blog.example']) {
      assert.throws(() => blogPlugin({ siteUrl }), TypeError);
    }
  });
});

describe('blog discovery: site settings from @jsails/config', () => {
  it('uses the blog.site title, tagline, and page size on the index and feeds', async () => {
    const repository = clockedRepository();
    const { app, runtime } = await makeApp(
      { repository },
      { before: [cachePlugin({ store: 'memory' }), configPlugin({ sets: [blogSiteConfig] })] },
    );
    await runtime.services.get(configToken).set(blogSiteConfig, {
      title: 'Field Notes',
      tagline: 'Short & sweet',
      postsPerPage: 2,
    });
    await seedPublished(repository, 3);

    const index = await (await app.request('/blog')).text();
    assert.equal(index.match(/<li>/g)?.length, 2);
    assert.match(index, /rel="next"/);

    const rss = await (await app.request('/blog/rss.xml')).text();
    assert.match(rss, /<title>Field Notes<\/title>/);
    assert.match(rss, /<description>Short &amp; sweet<\/description>/);

    await runtime.close();
  });

  it('falls back to the defaults when the set is not registered', async () => {
    const config = configPlugin({ sets: [] });
    const repository = clockedRepository();
    const { app, runtime } = await makeApp(
      { repository },
      { before: [cachePlugin({ store: 'memory' }), config] },
    );
    await seedPublished(repository, 11);

    const index = await (await app.request('/blog')).text();
    assert.equal(index.match(/<li>/g)?.length, 10);

    await runtime.close();
  });
});
