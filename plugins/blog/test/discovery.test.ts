import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Hono } from 'hono';

import { runExtensions, type ExtensionRuntime, type HttpExtensionHook } from 'jsails/extensions';
import {
  blogPlugin,
  blogRepositoryToken,
  createContentRepository,
  type ContentRepository,
  type PostCreateInput,
} from '@jsails/blog';

/**
 * Tests for the blog plugin's public discovery routes: the paginated index,
 * category/tag listings, RSS/Atom feeds, and the sitemap. The plugin runs
 * through the real extension runner and its HTTP hooks mount on a fresh Hono
 * app; requests are driven in-process against the injected in-memory
 * repository, so published-only filtering, escaping, and XML validity are all
 * exercised without a listener or database.
 */

type TestAppEnv = Parameters<HttpExtensionHook>[0] extends Hono<infer E> ? E : never;

interface TestApp {
  app: Hono<TestAppEnv>;
  runtime: ExtensionRuntime;
  repository: ContentRepository;
}

async function makeApp(repository?: ContentRepository): Promise<TestApp> {
  const plugin = blogPlugin(repository === undefined ? {} : { repository });
  const runtime = await runExtensions([plugin]);
  const app = new Hono<TestAppEnv>();
  for (const hook of runtime.httpHooks) {
    await hook(app);
  }
  return { app, runtime, repository: runtime.services.get(blogRepositoryToken) };
}

/** A valid post-create input the tests seed published posts with. */
function seedInput(input: Partial<PostCreateInput>): PostCreateInput {
  return {
    title: 'Seed',
    slug: 'seed',
    blocks: { version: 1, blocks: [] },
    status: 'published',
    authorId: 'test-author',
    ...input,
  };
}

/** Seed `count` published posts with distinct ascending slugs. */
async function seedPublished(repository: ContentRepository, count: number): Promise<void> {
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
function clockedRepository(): ContentRepository {
  let tick = 0;
  return createContentRepository({ now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
}

describe('blog discovery: paginated index', () => {
  it('falls back to page 1 for non-positive and non-numeric page values', async () => {
    const { app, runtime, repository } = await makeApp(clockedRepository());
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
    const { app, runtime, repository } = await makeApp(clockedRepository());
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
    const { app, runtime, repository } = await makeApp(clockedRepository());
    await seedPublished(repository, 11);

    const response = await app.request('/blog?page=999');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, />Post 1<\/a>/); // last page holds the oldest post
    assert.match(html, /rel="prev"/);

    await runtime.close();
  });

  it('links titles to /blog/<slug> and escapes both', async () => {
    const { app, runtime, repository } = await makeApp();
    await repository.createPost(seedInput({ title: '<b>Shout</b>', slug: '<i>shout</i>' }));

    const html = await (await app.request('/blog')).text();
    assert.match(html, /href="\/blog\/&lt;i&gt;shout&lt;\/i&gt;"/);
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
    const { app, runtime, repository } = await makeApp();
    await repository.createPost(
      seedInput({ title: 'A & B < C', slug: 'a-b', excerpt: 'x & y < z' }),
    );

    const response = await app.request('https://example.com/blog/rss.xml');
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
    const { app, runtime, repository } = await makeApp();
    await repository.createPost(seedInput({ title: 'Atom', slug: 'atom' }));

    const response = await app.request('https://example.com/blog/atom.xml');
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
    const { app, runtime, repository } = await makeApp();
    await repository.createPost(seedInput({ title: 'One', slug: 'one' }));
    await repository.createPost(seedInput({ title: 'Two', slug: 'two' }));
    await repository.createPost(seedInput({ title: 'Draft', slug: 'draft', status: 'draft' }));

    const response = await app.request('https://example.com/blog/sitemap.xml');
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

  it('escapes slugs in sitemap locations', async () => {
    const { app, runtime, repository } = await makeApp();
    await repository.createPost(seedInput({ title: 'Amp', slug: 'a&b' }));

    const xml = await (await app.request('/blog/sitemap.xml')).text();
    assert.match(xml, /<loc>http:\/\/localhost\/blog\/a&amp;b<\/loc>/);

    await runtime.close();
  });
});
