import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AdminPage } from '@jsails/admin';
import { createThemeRegistry, type ThemePackage, type ThemePackageRegistry } from '@jsails/theme';
import { blogThemeAdmin, THEME_ACTIVATED_NOTICE } from '../../src/admin/index.js';
import { createMemoryBlogRepository, type BlogRepository } from '../../src/cms/index.js';
import { capturePage, makeUrl, postContext, renderContext } from '../fixtures.js';

/**
 * Tests for the blog theme admin surface. The page is exercised through its
 * descriptor: `render` and `handlePost` are invoked directly with hand-built
 * contexts (a fixed `Session`, a stub `Request`, and a `URL`), so the page
 * contract is covered without a live panel, database, or HTTP server.
 */

/** Build a minimal valid theme package, matching `ThemePackage`'s frozen shape. */
function makePackage(name: string, description?: string): ThemePackage {
  return {
    name,
    version: '1.0.0',
    tokens: {},
    templates: [],
    partials: [],
    contentTypes: [],
    layouts: {},
    css: '',
    path: name,
    ...(description === undefined ? {} : { description }),
  };
}

/** Build the plugin plus its registry and repository. */
function makeAdmin(
  packages: readonly ThemePackage[],
  active?: string,
): {
  repository: BlogRepository;
  registry: ThemePackageRegistry;
  page: AdminPage;
} {
  const registry = createThemeRegistry({ packages, ...(active === undefined ? {} : { active }) });
  const repository = createMemoryBlogRepository();
  return {
    repository,
    registry,
    page: capturePage(blogThemeAdmin({ registry, repository }), 'themes'),
  };
}

describe('blog theme admin', () => {
  it('registers one page with slug themes, label Themes, group Content', () => {
    const { page } = makeAdmin([makePackage('aurora'), makePackage('zephyr')]);
    assert.equal(page.slug, 'themes');
    assert.equal(page.label, 'Themes');
    assert.equal(page.group, 'Content');
    assert.equal(typeof page.render, 'function');
    assert.equal(typeof page.handlePost, 'function');
  });

  it('renders theme names, versions, descriptions, and the active badge', async () => {
    const { repository, page } = makeAdmin([
      makePackage('aurora', 'Aurora theme'),
      makePackage('zephyr', 'Zephyr theme'),
    ]);
    await repository.setSetting('theme.active', 'zephyr');

    const html = await page.render(renderContext('/admin', makeUrl('/admin/themes')));

    assert.match(html, /aurora/);
    assert.match(html, /zephyr/);
    assert.match(html, /1\.0\.0/);
    assert.match(html, /Aurora theme/);
    assert.match(html, /Zephyr theme/);
    // zephyr is the active theme → a single Active badge and no Activate form for it.
    assert.match(html, /admin-badge/);
    assert.equal(html.match(/Active/g)?.length, 1);
  });

  it('falls back to the registry active theme when the setting is absent, invalid, or unknown', async () => {
    const { repository, page } = makeAdmin([makePackage('aurora'), makePackage('zephyr')]);

    // Absent setting → aurora (the first package, sorted by name) is active.
    const absentHtml = await page.render(renderContext('/admin', makeUrl('/admin/themes')));

    // Non-string value → fallback.
    await repository.setSetting('theme.active', { name: 'zephyr' });
    const invalidHtml = await page.render(renderContext('/admin', makeUrl('/admin/themes')));

    // Unknown name → fallback (the unknown name is never rendered as active).
    await repository.setSetting('theme.active', 'ghost');
    const unknownHtml = await page.render(renderContext('/admin', makeUrl('/admin/themes')));

    // Exactly one theme is active and exactly one (the other) offers an Activate
    // form in every fallback; the unknown name never leaks into the document.
    for (const html of [absentHtml, invalidHtml, unknownHtml]) {
      assert.equal(html.match(/Active/g)?.length, 1);
      assert.equal(html.match(/Activate/g)?.length, 1);
    }
    assert.doesNotMatch(unknownHtml, /ghost/);
  });

  it('activates a theme: persists the name and redirects with the notice', async () => {
    const { repository, page } = makeAdmin([makePackage('aurora'), makePackage('zephyr')]);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/themes'), {
        action: 'activate',
        name: 'zephyr',
      }),
    );

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      `/admin/themes?notice=${THEME_ACTIVATED_NOTICE}`,
    );

    const setting = await repository.getSetting('theme.active');
    assert.ok(setting);
    assert.equal(setting.value, 'zephyr');

    // The notice renders on a subsequent GET.
    const html = await page.render(
      renderContext('/admin', makeUrl(`/admin/themes?notice=${THEME_ACTIVATED_NOTICE}`)),
    );
    assert.match(html, /Theme activated\./);
  });

  it('returns a value-free 400 for an unknown or malformed name', async () => {
    const { page } = makeAdmin([makePackage('aurora')]);

    for (const name of ['ghost', 'SECRET<INJECT>']) {
      const response = await page.handlePost!(
        postContext('/admin', makeUrl('/admin/themes'), {
          action: 'activate',
          name,
        }),
      );
      assert.equal(response.status, 400);
      const body = await response.text();
      assert.doesNotMatch(body, /ghost/);
      assert.doesNotMatch(body, /SECRET/);
    }
  });

  it('returns a 400 for an unknown action without echoing input', async () => {
    const { page } = makeAdmin([makePackage('aurora')]);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/themes'), {
        action: 'delete',
        name: 'aurora',
      }),
    );

    assert.equal(response.status, 400);
    const body = await response.text();
    assert.doesNotMatch(body, /delete/);
    assert.doesNotMatch(body, /aurora/);
  });

  it('renders an empty state when no packages are registered', async () => {
    const { page } = makeAdmin([]);
    const html = await page.render(renderContext('/admin', makeUrl('/admin/themes')));
    assert.match(html, /No themes are registered\./);
  });
});
