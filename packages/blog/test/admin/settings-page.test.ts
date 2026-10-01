import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AdminPage } from '@jsails/admin';
import { blogAdmin } from '../../src/admin/index.js';
import { createMemoryBlogRepository, type BlogRepository } from '../../src/cms/index.js';
import { capturePage, makeUrl, postContext, renderContext } from '../fixtures.js';

/**
 * Tests for the blog admin settings page. The page is exercised through its
 * descriptor (registered by `blogAdmin`): `render` and `handlePost` are
 * invoked directly with hand-built contexts (a fixed `Session`, a stub
 * `Request`, and a `URL`), so the page contract is covered without a live
 * panel, database, or HTTP server.
 */

/** Build the plugin and its repository, returning the settings page. */
function makePage(): { repository: BlogRepository; page: AdminPage } {
  const repository = createMemoryBlogRepository();
  return { repository, page: capturePage(blogAdmin({ repository }), 'settings') };
}

/** The default `site.*` settings submitted by a canonical settings save. */
const SITE_VALUES: Record<string, string> = {
  action: 'save',
  'site.title': 'My Blog',
  'site.tagline': 'Thoughts about things',
  'site.postsPerPage': '12',
  'site.timezone': 'Europe/London',
  'site.social': '{"twitter":"https://twitter.com/me","github":"https://github.com/me"}',
};

describe('blog admin settings page', () => {
  it('registers a settings page with slug, label, and group', () => {
    const { page } = makePage();
    assert.equal(page.slug, 'settings');
    assert.equal(page.label, 'Settings');
    assert.equal(page.group, 'Content');
    assert.equal(typeof page.render, 'function');
    assert.equal(typeof page.handlePost, 'function');
  });

  it('renders the curated fields with sensible defaults when nothing is stored', async () => {
    const { page } = makePage();
    const html = await page.render(renderContext('/admin', makeUrl('/admin/settings')));

    assert.match(html, /Site title/);
    assert.match(html, /Tagline/);
    assert.match(html, /Posts per page/);
    assert.match(html, /Timezone/);
    assert.match(html, /Social/);
    assert.match(html, /name="site\.postsPerPage"/);
    assert.match(html, /value="10"/); // default posts per page
  });

  it('renders persisted values back into the form', async () => {
    const { repository, page } = makePage();
    await repository.setSetting('site.title', 'Stored Title');
    await repository.setSetting('site.postsPerPage', 25);
    await repository.setSetting('site.social', { github: 'https://github.com/x' });

    const html = await page.render(renderContext('/admin', makeUrl('/admin/settings')));

    assert.match(html, /Stored Title/);
    assert.match(html, /value="25"/);
    assert.match(html, /https:\/\/github\.com\/x/);
  });

  it('persists the five curated keys and redirects with a notice', async () => {
    const { repository, page } = makePage();

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/settings'), SITE_VALUES),
    );

    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/admin/settings?notice=saved');

    assert.equal((await repository.getSetting('site.title'))?.value, 'My Blog');
    assert.equal((await repository.getSetting('site.tagline'))?.value, 'Thoughts about things');
    assert.equal((await repository.getSetting('site.postsPerPage'))?.value, 12);
    assert.equal((await repository.getSetting('site.timezone'))?.value, 'Europe/London');
    assert.deepEqual((await repository.getSetting('site.social'))?.value, {
      twitter: 'https://twitter.com/me',
      github: 'https://github.com/me',
    });
  });

  it('renders the save notice on a subsequent GET', async () => {
    const { page } = makePage();
    const html = await page.render(
      renderContext('/admin', makeUrl('/admin/settings?notice=saved')),
    );
    assert.match(html, /Settings saved\./);
  });

  it('rejects an invalid posts-per-page with a value-free 400', async () => {
    const { repository, page } = makePage();

    for (const value of ['0', '-3', '12.5', 'SECRET<INJECT>', '999']) {
      const response = await page.handlePost!(
        postContext('/admin', makeUrl('/admin/settings'), {
          ...SITE_VALUES,
          'site.postsPerPage': value,
        }),
      );
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), /SECRET/);
    }
    assert.equal((await repository.listSettings()).length, 0);
  });

  it('rejects a non-JSON-safe social value with a value-free 400', async () => {
    const { repository, page } = makePage();

    for (const social of ['{"twitter": 42}', '[1,2,3]', '"SECRET_NOT_JSON"']) {
      const response = await page.handlePost!(
        postContext('/admin', makeUrl('/admin/settings'), {
          ...SITE_VALUES,
          'site.social': social,
        }),
      );
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), /SECRET/);
    }
    assert.equal((await repository.listSettings()).length, 0);
  });

  it('rejects an empty title or timezone with a value-free 400', async () => {
    const { page } = makePage();

    for (const body of [
      { ...SITE_VALUES, 'site.title': '   ' },
      { ...SITE_VALUES, 'site.timezone': '' },
    ]) {
      const response = await page.handlePost!(
        postContext('/admin', makeUrl('/admin/settings'), body),
      );
      assert.equal(response.status, 400);
    }
  });

  it('rejects an unknown action with a value-free 400', async () => {
    const { page } = makePage();

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/settings'), { ...SITE_VALUES, action: 'delete' }),
    );
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /delete/);
  });
});
