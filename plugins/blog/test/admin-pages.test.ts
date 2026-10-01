import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Session } from 'jsails';
import {
  type AdminPage,
  type AdminPagePostContext,
  type AdminPageRenderContext,
  type AdminPlugin,
} from '@jsails/admin';
import { blogAdmin, createContentRepository, type ContentRepository } from '@jsails/blog';

/**
 * Tests for the blog admin settings and menus pages. Each page is exercised
 * through its descriptor (registered by `blogAdmin`): `render` and `handlePost`
 * are invoked directly with hand-built contexts (a fixed `Session`, a stub
 * `Request`, and a `URL`), so the page contract is covered without a live
 * panel, database, or HTTP server.
 */

const session: Session = { id: 's', csrfToken: 't', data: {}, expiresAt: 0 };

/** Build a `URL` for the given pathname (base path is ignored by the pages). */
function makeUrl(pathname: string): URL {
  return new URL(pathname, 'http://localhost');
}

/** Build a `GET` render context with the given base path and query URL. */
function renderContext(path: string, url: URL): AdminPageRenderContext {
  return {
    session,
    path,
    request: new Request(url),
    url,
  };
}

/** Build a `POST` context with a string-only form body. */
function postContext(path: string, url: URL, body: Record<string, string>): AdminPagePostContext {
  return { ...renderContext(path, url), body };
}

/** Capture the page with the given slug from the plugin's contributions. */
function capturePage(plugin: AdminPlugin, slug: string): AdminPage {
  let captured: AdminPage | undefined;
  plugin.register({
    addPage(page) {
      if (page.slug === slug) {
        captured = page;
      }
    },
    addNavigationItem() {},
    addResource() {},
  });
  assert.ok(captured, `blog must register the ${slug} page`);
  return captured;
}

/** Build the plugin and its repository, returning the requested page. */
function makePage(slug: 'settings' | 'menus'): {
  repository: ContentRepository;
  page: AdminPage;
} {
  const repository = createContentRepository();
  return { repository, page: capturePage(blogAdmin({ repository }), slug) };
}

/** The default `site.*` settings submitted by a canonical settings save. */
const SITE_VALUES: Record<string, string> = {
  action: 'save',
  'site.title': 'My Blog',
  'site.tagline': 'Thoughts about things',
  'site.postsPerPage': '12',
  'site.timezone': 'Europe/London',
  'site.social': '{"twitter":"https://twitter.com/me","github":"https://github.com/me"}',
  _csrf: 't',
};

describe('blog admin settings page', () => {
  it('registers a settings page with slug, label, and group', () => {
    const { page } = makePage('settings');
    assert.equal(page.slug, 'settings');
    assert.equal(page.label, 'Settings');
    assert.equal(page.group, 'Content');
    assert.equal(typeof page.render, 'function');
    assert.equal(typeof page.handlePost, 'function');
  });

  it('renders the curated fields with sensible defaults when nothing is stored', async () => {
    const { page } = makePage('settings');
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
    const { repository, page } = makePage('settings');
    await repository.setSetting('site.title', 'Stored Title');
    await repository.setSetting('site.postsPerPage', 25);
    await repository.setSetting('site.social', { github: 'https://github.com/x' });

    const html = await page.render(renderContext('/admin', makeUrl('/admin/settings')));

    assert.match(html, /Stored Title/);
    assert.match(html, /value="25"/);
    assert.match(html, /https:\/\/github\.com\/x/);
  });

  it('persists the five curated keys and redirects with a notice', async () => {
    const { repository, page } = makePage('settings');

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
    const { page } = makePage('settings');
    const html = await page.render(
      renderContext('/admin', makeUrl('/admin/settings?notice=saved')),
    );
    assert.match(html, /Settings saved\./);
  });

  it('rejects an invalid posts-per-page with a value-free 400', async () => {
    const { repository, page } = makePage('settings');

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
    const { repository, page } = makePage('settings');

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
    const { page } = makePage('settings');

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
    const { page } = makePage('settings');

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/settings'), { ...SITE_VALUES, action: 'delete' }),
    );
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /delete/);
  });
});

describe('blog admin menus page', () => {
  /** Add two ordered items to the primary menu and return its repository. */
  function seedMenu(repository: ContentRepository): Promise<void> {
    return repository
      .createMenu({
        name: 'Primary',
        location: 'primary',
        items: [
          { label: 'Home', href: '/', sortOrder: 0, children: [] },
          { label: 'About', href: '/about', sortOrder: 1, children: [] },
        ],
      })
      .then(() => undefined);
  }

  it('registers a menus page with slug, label, and group', () => {
    const { page } = makePage('menus');
    assert.equal(page.slug, 'menus');
    assert.equal(page.label, 'Menus');
    assert.equal(page.group, 'Content');
    assert.equal(typeof page.render, 'function');
    assert.equal(typeof page.handlePost, 'function');
  });

  it('renders an empty state when no primary menu exists', async () => {
    const { page } = makePage('menus');
    const html = await page.render(renderContext('/admin', makeUrl('/admin/menus')));
    assert.match(html, /No menu items yet\./);
  });

  it('renders each item with its label, href, and actions', async () => {
    const { repository, page } = makePage('menus');
    await seedMenu(repository);

    const html = await page.render(renderContext('/admin', makeUrl('/admin/menus')));

    assert.match(html, /Home/);
    assert.match(html, /About/);
    assert.match(html, /value="\/"/);
    assert.match(html, /value="\/about"/);
    assert.match(html, /Move up/);
    assert.match(html, /Move down/);
    assert.match(html, /Delete/);
  });

  it('adds an item, appending it with a contiguous sort order', async () => {
    const { repository, page } = makePage('menus');
    await seedMenu(repository);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/menus'), {
        action: 'add',
        label: 'Contact',
        href: '/contact',
        _csrf: 't',
      }),
    );

    assert.equal(response.status, 303);
    const menu = (await repository.listMenus()).find((entry) => entry.location === 'primary');
    assert.ok(menu);
    assert.deepEqual(
      menu.items.map((item) => ({
        label: item.label,
        href: item.href,
        sortOrder: item.sortOrder,
      })),
      [
        { label: 'Home', href: '/', sortOrder: 0 },
        { label: 'About', href: '/about', sortOrder: 1 },
        { label: 'Contact', href: '/contact', sortOrder: 2 },
      ],
    );
    assert.ok(menu.items.every((item) => item.children.length === 0));
  });

  it('updates an item in place, preserving order', async () => {
    const { repository, page } = makePage('menus');
    await seedMenu(repository);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/menus'), {
        action: 'update',
        index: '1',
        label: 'About Us',
        href: '/about-us',
        _csrf: 't',
      }),
    );

    assert.equal(response.status, 303);
    const menu = (await repository.listMenus()).find((entry) => entry.location === 'primary');
    assert.ok(menu);
    assert.deepEqual(
      menu.items.map((item) => [item.label, item.href, item.sortOrder]),
      [
        ['Home', '/', 0],
        ['About Us', '/about-us', 1],
      ],
    );
  });

  it('deletes an item and re-normalizes sort order', async () => {
    const { repository, page } = makePage('menus');
    await seedMenu(repository);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/menus'), { action: 'delete', index: '0', _csrf: 't' }),
    );

    assert.equal(response.status, 303);
    const menu = (await repository.listMenus()).find((entry) => entry.location === 'primary');
    assert.ok(menu);
    assert.deepEqual(
      menu.items.map((item) => [item.label, item.sortOrder]),
      [['About', 0]],
    );
  });

  it('moves an item up and down, keeping the order contiguous', async () => {
    const { repository, page } = makePage('menus');
    await seedMenu(repository);

    // move-up on the second of two items swaps them.
    await page.handlePost!(
      postContext('/admin', makeUrl('/admin/menus'), { action: 'move-up', index: '1', _csrf: 't' }),
    );
    // move-down restores the original order.
    await page.handlePost!(
      postContext('/admin', makeUrl('/admin/menus'), {
        action: 'move-down',
        index: '0',
        _csrf: 't',
      }),
    );

    const menu = (await repository.listMenus()).find((entry) => entry.location === 'primary');
    assert.ok(menu);
    assert.deepEqual(
      menu.items.map((item) => [item.label, item.sortOrder]),
      [
        ['Home', 0],
        ['About', 1],
      ],
    );
  });

  it('rejects an off-site URL scheme with a value-free 400', async () => {
    const { page } = makePage('menus');

    for (const href of ['javascript:alert(1)', 'data:text/html,SECRET', 'vbscript:msgbox']) {
      const response = await page.handlePost!(
        postContext('/admin', makeUrl('/admin/menus'), {
          action: 'add',
          label: 'X',
          href,
          _csrf: 't',
        }),
      );
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), /SECRET/);
    }
  });

  it('rejects an empty label or href with a value-free 400', async () => {
    const { page } = makePage('menus');

    for (const body of [
      { action: 'add', label: '', href: '/x', _csrf: 't' },
      { action: 'add', label: 'X', href: '   ', _csrf: 't' },
    ]) {
      const response = await page.handlePost!(postContext('/admin', makeUrl('/admin/menus'), body));
      assert.equal(response.status, 400);
    }
  });

  it('rejects an out-of-range index and an unknown action with a value-free 400', async () => {
    const { repository, page } = makePage('menus');
    await seedMenu(repository);

    const bodies: Record<string, string>[] = [
      { action: 'delete', index: '5', _csrf: 't' },
      { action: 'update', index: 'NaN', label: 'X', href: '/x', _csrf: 't' },
      { action: 'explode', index: '0', _csrf: 't' },
    ];
    for (const body of bodies) {
      const response = await page.handlePost!(postContext('/admin', makeUrl('/admin/menus'), body));
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), /explode/);
    }

    const menu = (await repository.listMenus()).find((entry) => entry.location === 'primary');
    assert.ok(menu);
    assert.equal(menu.items.length, 2);
  });
});
