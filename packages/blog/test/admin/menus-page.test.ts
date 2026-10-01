import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AdminPage } from '@jsails/admin';
import { blogAdmin } from '../../src/admin/index.js';
import { createMemoryBlogRepository, type BlogRepository } from '../../src/cms/index.js';
import { capturePage, makeUrl, postContext, renderContext } from '../fixtures.js';

/**
 * Tests for the blog admin menus page, exercised through its descriptor the
 * same way as the settings page: hand-built render/post contexts, no panel.
 */

/** Build the plugin and its repository, returning the menus page. */
function makePage(): { repository: BlogRepository; page: AdminPage } {
  const repository = createMemoryBlogRepository();
  return { repository, page: capturePage(blogAdmin({ repository }), 'menus') };
}

describe('blog admin menus page', () => {
  /** Add two ordered items to the primary menu and return its repository. */
  function seedMenu(repository: BlogRepository): Promise<void> {
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
    const { page } = makePage();
    assert.equal(page.slug, 'menus');
    assert.equal(page.label, 'Menus');
    assert.equal(page.group, 'Content');
    assert.equal(typeof page.render, 'function');
    assert.equal(typeof page.handlePost, 'function');
  });

  it('renders an empty state when no primary menu exists', async () => {
    const { page } = makePage();
    const html = await page.render(renderContext('/admin', makeUrl('/admin/menus')));
    assert.match(html, /No menu items yet\./);
  });

  it('renders each item with its label, href, and actions', async () => {
    const { repository, page } = makePage();
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
    const { repository, page } = makePage();
    await seedMenu(repository);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/menus'), {
        action: 'add',
        label: 'Contact',
        href: '/contact',
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
    const { repository, page } = makePage();
    await seedMenu(repository);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/menus'), {
        action: 'update',
        index: '1',
        label: 'About Us',
        href: '/about-us',
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
    const { repository, page } = makePage();
    await seedMenu(repository);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/menus'), { action: 'delete', index: '0' }),
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
    const { repository, page } = makePage();
    await seedMenu(repository);

    // move-up on the second of two items swaps them.
    await page.handlePost!(
      postContext('/admin', makeUrl('/admin/menus'), { action: 'move-up', index: '1' }),
    );
    // move-down restores the original order.
    await page.handlePost!(
      postContext('/admin', makeUrl('/admin/menus'), {
        action: 'move-down',
        index: '0',
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
    const { page } = makePage();

    for (const href of ['javascript:alert(1)', 'data:text/html,SECRET', 'vbscript:msgbox']) {
      const response = await page.handlePost!(
        postContext('/admin', makeUrl('/admin/menus'), {
          action: 'add',
          label: 'X',
          href,
        }),
      );
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), /SECRET/);
    }
  });

  it('rejects an empty label or href with a value-free 400', async () => {
    const { page } = makePage();

    for (const body of [
      { action: 'add', label: '', href: '/x' },
      { action: 'add', label: 'X', href: '   ' },
    ]) {
      const response = await page.handlePost!(postContext('/admin', makeUrl('/admin/menus'), body));
      assert.equal(response.status, 400);
    }
  });

  it('rejects an out-of-range index and an unknown action with a value-free 400', async () => {
    const { repository, page } = makePage();
    await seedMenu(repository);

    const bodies: Record<string, string>[] = [
      { action: 'delete', index: '5' },
      { action: 'update', index: 'NaN', label: 'X', href: '/x' },
      { action: 'explode', index: '0' },
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
