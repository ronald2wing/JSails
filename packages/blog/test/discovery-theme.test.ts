/**
 * Public discovery routes rendered through the active blog theme.
 *
 * The plugin only opts into themed HTML when the app injects theme packages;
 * this keeps the bare plugin dependency-light and lets the generated blog use
 * Jello Elementor.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { builtinThemePackages } from '@jsails/theme';
import { createMemoryBlogRepository } from '../src/cms/index.js';
import { makeApp as mountPlugin, seedPost, type TestApp } from './fixtures.js';

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
});
