/**
 * Public discovery routes rendered through the active blog theme.
 *
 * The plugin only opts into themed HTML when the app injects theme packages;
 * this keeps the bare plugin dependency-light and lets the generated blog use
 * Jello Elementor.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Hono } from 'hono';

import { runExtensions, type HttpExtensionHook } from 'jsails/extensions';
import { builtinThemePackages } from '@jsails/theme';
import { blogPlugin, createContentRepository } from '@jsails/blog';

type TestAppEnv = Parameters<HttpExtensionHook>[0] extends Hono<infer E> ? E : never;

async function makeApp(active?: string) {
  const repository = createContentRepository();
  if (active !== undefined) await repository.setSetting('theme.active', active);
  await repository.createPost({
    title: 'Jello <Post>',
    slug: 'jello-post',
    blocks: { version: 1, blocks: [] },
    status: 'published',
    authorId: 'author',
  });
  const runtime = await runExtensions([blogPlugin({ repository, themes: builtinThemePackages })]);
  const app = new Hono<TestAppEnv>();
  for (const hook of runtime.httpHooks) await hook(app);
  return { app, runtime, repository };
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

  it('falls back to the plain discovery markup when the active theme has no layouts', async () => {
    const { app, runtime } = await makeApp('neutral');
    const html = await (await app.request('/blog')).text();
    assert.doesNotMatch(html, /class="jello-header"/);
    assert.match(html, /<ul>/);
    await runtime.close();
  });
});
