/**
 * Public discovery routes rendered through the active blog theme.
 *
 * The plugin only opts into themed HTML when the app injects theme packages;
 * this keeps the bare plugin dependency-light and lets the generated blog use
 * Jello Elementor.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { builtinThemePackages, createThemeRegistry } from '@jsails/theme';

import { blogThemeAdmin } from '../src/admin/index.js';
import { createMemoryBlogRepository, type BlogRepository } from '../src/cms/index.js';
import { BlogSearchError } from '../src/search/http-driver.js';
import {
  capturePage,
  makeApp as mountPlugin,
  makeUrl,
  postContext,
  seedPost,
  type TestApp,
} from './fixtures.js';

/** The plugin with the builtin themes, one published post, and an optional active theme. */
async function makeApp(active?: string): Promise<TestApp> {
  const repository = createMemoryBlogRepository();
  if (active !== undefined) await repository.setSetting('theme.active', active);
  await seedPost(repository, { title: 'Jello <Post>', slug: 'jello-post', authorId: 'author' });
  return mountPlugin({ repository, themes: builtinThemePackages });
}

describe('themed blog discovery', () => {
  it('renders the default Jello Elementor shell and index layout', async () => {
    const { app, runtime } = await makeApp();
    const html = await (await app.request('/blog')).text();
    assert.match(html, /class="jello-header"/);
    assert.match(html, /class="jello-grid"/);
    assert.match(html, /Jello &lt;Post&gt;/);
    assert.match(html, /<style>/);
    await runtime.close();
  });

  it('escapes term names and descriptions in themed archive pages', async () => {
    const { app, runtime, repository } = await makeApp();
    await repository.createCategory({
      name: '<img src=x onerror=alert(1)>',
      slug: 'evil',
      description: '<script>alert(2)</script>',
    });
    const html = await (await app.request('/blog/category/evil')).text();
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    await runtime.close();
  });

  it('falls back to the plain discovery markup when the active theme has no layouts', async () => {
    const { app, runtime } = await makeApp('neutral');
    const html = await (await app.request('/blog')).text();
    assert.doesNotMatch(html, /class="jello-header"/);
    assert.match(html, /<ul>/);
    await runtime.close();
  });

  it('splices the search form without String#replace patterns, so $` cannot copy the document', async () => {
    const { app, runtime } = await makeApp();
    const html = await (await app.request(`/blog/search?q=${encodeURIComponent("$`$&$'")}`)).text();
    assert.equal(html.match(/<!doctype html>/g)?.length, 1);
    assert.equal(html.match(/<style>/g)?.length, 1);
    assert.match(html, /value="\$`\$&amp;\$&#39;"/);
    await runtime.close();
  });

  it('truncates an oversized search query before searching and echoing it', async () => {
    const { app, runtime } = await makeApp();
    const html = await (await app.request(`/blog/search?q=${'x'.repeat(5000)}`)).text();
    assert.match(html, new RegExp(`value="${'x'.repeat(200)}"`));
    assert.doesNotMatch(html, new RegExp('x'.repeat(201)));
    await runtime.close();
  });

  it('answers 503 with the form when the search engine is unavailable', async () => {
    const repository = createMemoryBlogRepository();
    const { app, runtime } = await mountPlugin({
      repository,
      themes: builtinThemePackages,
      search: {
        search: () => Promise.reject(new BlogSearchError('request_failed', 'down')),
        index: async () => {},
        remove: async () => {},
        reindex: async () => {},
      },
    });
    const response = await app.request('/blog/search?q=hello');
    assert.equal(response.status, 503);
    const html = await response.text();
    assert.match(html, /temporarily unavailable/);
    assert.match(html, /role="search"/);
    await runtime.close();
  });

  it('emits pagination links on the themed index', async () => {
    const repository = createMemoryBlogRepository();
    for (let i = 1; i <= 11; i += 1) {
      await seedPost(repository, { title: `Post ${i}`, slug: `post-${i}` });
    }
    const { app, runtime } = await mountPlugin({ repository, themes: builtinThemePackages });
    const html = await (await app.request('/blog')).text();
    assert.match(html, /class="jello-header"/);
    assert.match(html, /href="\/blog\?page=2" rel="next"/);
    await runtime.close();
  });

  it('renders the stored primary menu in the themed header, escaped', async () => {
    const repository = createMemoryBlogRepository();
    await repository.createMenu({
      name: 'Primary',
      location: 'primary',
      items: [
        { label: 'About <us>', href: '/about', sortOrder: 1, children: [] },
        { label: 'Docs', href: 'https://docs.example/a?b=1&c=2', sortOrder: 0, children: [] },
      ],
    });
    const { app, runtime } = await mountPlugin({ repository, themes: builtinThemePackages });
    const html = await (await app.request('/blog')).text();
    assert.match(
      html,
      /<a href="https:\/\/docs\.example\/a\?b=1&amp;c=2">Docs<\/a><a href="\/about">About &lt;us&gt;<\/a>/,
    );
    assert.doesNotMatch(html, /<a href="\/">Home<\/a>/);
    await runtime.close();
  });

  it('reads the active theme setting once per cache window, and a theme admin save shows at once', async () => {
    const backing = createMemoryBlogRepository();
    let reads = 0;
    const repository: BlogRepository = {
      ...backing,
      getSetting: (key) => {
        reads += 1;
        return backing.getSetting(key);
      },
    };
    await seedPost(backing, { title: 'Post', slug: 'post' });
    const { app, runtime } = await mountPlugin({ repository, themes: builtinThemePackages });

    await app.request('/blog');
    await app.request('/blog');
    assert.equal(reads, 1);

    const page = capturePage(
      blogThemeAdmin({
        registry: createThemeRegistry({ packages: builtinThemePackages }),
        repository,
      }),
      'themes',
    );
    const url = makeUrl('/admin/themes');
    await page.handlePost!(postContext('/admin', url, { action: 'activate', name: 'neutral' }));

    const html = await (await app.request('/blog')).text();
    assert.doesNotMatch(html, /class="jello-header"/);
    await runtime.close();
  });
});
