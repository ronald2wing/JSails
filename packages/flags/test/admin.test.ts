/**
 * Feature-flags admin page tests.
 *
 * These drive the flags admin page through a real in-process `Application`: the
 * admin plugin is mounted as an extension, the flags page is passed as a panel
 * page, and every request is routed through the same pipeline `serve` uses. No
 * browser, database, Valkey, or listener is involved.
 *
 * The page reads and writes through the app's `FeatureFlags` service (the
 * one `flagsPlugin` provides under `flagsToken`, resolved from the request's
 * application scope), so a toggle invalidates the cached flag set the runtime
 * checks read.
 * Tests seed an in-memory store with known flags.
 *
 * Coverage:
 * - Empty listing: no global flags → "No global flags configured."
 * - Flag listing: active/inactive badges and toggle buttons in the table.
 * - Toggle: POST to activate an inactive flag, POST to deactivate an active flag.
 * - Invalid POST: missing key/active fields → 400; unknown flag → 404.
 * - Auth gate: the panel gate and the page's own default-deny `authorize`
 *   both apply (403 when either refuses or the page has no `authorize`).
 * - Cache: an admin toggle is seen by the next runtime check.
 * - Boot: a panel with the flags page and no flags service fails at boot, and
 *   one declared before the flags plugin still runs after it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adminPlugin, defineAdminPanel } from '@jsails/admin';
import { cachePlugin } from '@jsails/cache';
import type { Session } from 'jsails';
import { ExtensionErrors } from 'jsails/extensions';
import { createTestApp, createTestSession, postForm, type TestApplication } from 'jsails/testing';
import { definePlugin, fn } from 'jsails/kernel';
import { z } from 'jsails/zod';
import { createMemoryFlagStore, type FeatureFlags, type FeatureStore } from '../src/flags.js';
import { featureStoreToken, flagsPlugin, flagsToken } from '../src/index.js';
import {
  defineFlagsAdminPage,
  flagsAdmin,
  type FlagsAdminPageOptions,
} from '../src/admin/index.js';

const SESSION = createTestSession({ id: 'admin-session-1' });

/** A plugin providing a seeded flag store under `featureStoreToken`, as an application would. */
const featureStorePlugin = definePlugin({
  name: 'test-feature-store',
  options: z.object({ store: fn<() => FeatureStore>() }).strict(),
  provides: [featureStoreToken],
  setup({ options, services }) {
    services.provide(featureStoreToken, options.store());
  },
});

/** A test app with the flags plugin and its admin page over a seeded store. */
async function makeApp(
  flagsSeeds: Record<string, boolean>,
  authorize?: (session: Session | null) => boolean | Promise<boolean>,
  pageAuthorize: FlagsAdminPageOptions['authorize'] | null = () => true,
): Promise<TestApplication & { readonly flags: FeatureFlags }> {
  const store = createMemoryFlagStore();
  for (const [key, value] of Object.entries(flagsSeeds)) {
    await store.set(key, value);
  }

  const app = await createTestApp({
    config: {
      port: 0,
      // The app's own sessions, which the panel reads too.
      resolveSession: () => SESSION,
      extensions: [
        cachePlugin({ store: 'memory' }),
        featureStorePlugin({ store: () => store }),
        flagsPlugin({ store: featureStoreToken }),
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: authorize ?? (() => true),
            pages: [
              defineFlagsAdminPage({
                ...(pageAuthorize === null ? {} : { authorize: pageAuthorize }),
              }),
            ],
          }),
        ),
      ],
    },
  });
  return Object.assign(app, { flags: app.application.services.get(flagsToken) });
}

describe('flagsAdmin', { concurrency: 1 }, () => {
  it('contributes the flags page through the panel adminPlugins list', async () => {
    const store = createMemoryFlagStore();
    await store.set('experiment', true);
    const app = await createTestApp({
      config: {
        port: 0,
        // The app's own sessions, which the panel reads too.
        resolveSession: () => SESSION,
        extensions: [
          cachePlugin({ store: 'memory' }),
          featureStorePlugin({ store: () => store }),
          flagsPlugin({ store: featureStoreToken }),
          adminPlugin(
            defineAdminPanel({
              resolveSession: () => SESSION,
              authorize: () => true,
              adminPlugins: [flagsAdmin({ authorize: () => true })],
            }),
          ),
        ],
      },
    });
    const response = await app.request('/admin/flags');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<code>experiment<\/code>/);
    await app.close();
  });

  it('fails at boot, not on the first request, when no flags service is configured', async () => {
    for (const panel of [
      { adminPlugins: [flagsAdmin({ authorize: () => true })] },
      { pages: [defineFlagsAdminPage({ authorize: () => true })] },
    ]) {
      await assert.rejects(
        createTestApp({
          config: {
            port: 0,
            // The app's own sessions, which the panel reads too.
            resolveSession: () => SESSION,
            extensions: [
              adminPlugin(
                defineAdminPanel({
                  resolveSession: () => SESSION,
                  authorize: () => true,
                  ...panel,
                }),
              ),
            ],
          },
        }),
        (error: unknown) =>
          ExtensionErrors.is(error, 'missing_service') && error.context['token'] === 'flags',
      );
    }
  });

  it('runs after the flags plugin wherever the panel is declared', async () => {
    const store = createMemoryFlagStore();
    await store.set('experiment', true);
    const app = await createTestApp({
      config: {
        port: 0,
        // The app's own sessions, which the panel reads too.
        resolveSession: () => SESSION,
        extensions: [
          adminPlugin(
            defineAdminPanel({
              resolveSession: () => SESSION,
              authorize: () => true,
              adminPlugins: [flagsAdmin({ authorize: () => true })],
            }),
          ),
          cachePlugin({ store: 'memory' }),
          featureStorePlugin({ store: () => store }),
          flagsPlugin({ store: featureStoreToken }),
        ],
      },
    });
    try {
      assert.equal((await app.request('/admin/flags')).status, 200);
    } finally {
      await app.close();
    }
  });

  it('rejects options that are not an object', () => {
    assert.throws(() => flagsAdmin(null as never), TypeError);
    assert.throws(() => flagsAdmin([] as never), TypeError);
  });
});

describe('flags admin page empty', { concurrency: 1 }, () => {
  it('renders no-flags message when the store is empty', async () => {
    const app = await makeApp({});
    const response = await app.request('/admin/flags');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /No global flags configured/);
    assert.match(html, /Feature Flags/);
    await app.close();
  });
});

describe('flags admin page listing', { concurrency: 1 }, () => {
  it('lists flags with active/inactive badges and toggle buttons', async () => {
    const app = await makeApp({
      'new-checkout': true,
      'dark-mode': false,
      'beta-feature': true,
    });
    const response = await app.request('/admin/flags');
    assert.equal(response.status, 200);
    const html = await response.text();

    // All three flags appear as code elements.
    assert.match(html, /<code>beta-feature<\/code>/);
    assert.match(html, /<code>dark-mode<\/code>/);
    assert.match(html, /<code>new-checkout<\/code>/);

    // Active flags show the "active" badge and a Deactivate button.
    // Use more specific patterns to avoid matching "active" in the CSS.
    assert.match(
      html,
      /<code>new-checkout<\/code>[\s\S]*?<span class="admin-badge">active<\/span>[\s\S]*?>Deactivate</,
    );
    assert.match(
      html,
      /<code>beta-feature<\/code>[\s\S]*?<span class="admin-badge">active<\/span>[\s\S]*?>Deactivate</,
    );

    // The inactive flag shows the "inactive" badge and an Activate button.
    assert.match(
      html,
      /<code>dark-mode<\/code>[\s\S]*?<span class="admin-badge admin-badge-inactive">inactive<\/span>[\s\S]*?>Activate</,
    );

    // The scope note is rendered.
    assert.match(html, /global only/);

    // The back link is rendered.
    assert.match(html, /Back to dashboard/);

    await app.close();
  });
});

describe('flags admin page toggle', { concurrency: 1 }, () => {
  it('activates an inactive flag via POST', async () => {
    const app = await makeApp({ experiment: false });
    const response = await postForm(app, '/admin/flags', {
      flag_key: 'experiment',
      flag_active: 'true',
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /notice=flag_activated/);

    // Verify the flag was actually toggled. The notice is a redirect-time query
    // (read from the 303 Location), not persisted state — a fresh GET shows the
    // toggled state, not the notice.
    const getResp = await app.request('/admin/flags');
    const html = await getResp.text();
    assert.match(html, /<span class="admin-badge">active<\/span>/);
    await app.close();
  });

  it('a toggle is seen by the next runtime check, through the cache', async () => {
    const app = await makeApp({ experiment: false });
    assert.equal(await app.flags.isActive('experiment'), false);
    const response = await postForm(app, '/admin/flags', {
      flag_key: 'experiment',
      flag_active: 'true',
    });
    assert.equal(response.status, 303);
    assert.equal(await app.flags.isActive('experiment'), true);
    await app.close();
  });

  it('deactivates an active flag via POST', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      flag_key: 'experiment',
      flag_active: 'false',
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /notice=flag_deactivated/);

    const getResp = await app.request('/admin/flags');
    const html = await getResp.text();
    assert.match(html, /<span class="admin-badge admin-badge-inactive">inactive<\/span>/);
    await app.close();
  });

  it('returns 400 when flag_key is missing', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      flag_active: 'false',
    });
    assert.equal(response.status, 400);
    await app.close();
  });

  it('returns 400 when flag_active is missing', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      flag_key: 'experiment',
    });
    assert.equal(response.status, 400);
    await app.close();
  });

  it('returns 400 for an invalid flag_active value', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      flag_key: 'experiment',
      flag_active: 'invalid',
    });
    assert.equal(response.status, 400);
    await app.close();
  });

  it('returns 404 when the flag key is unknown', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      flag_key: 'nonexistent',
      flag_active: 'true',
    });
    assert.equal(response.status, 404);
    await app.close();
  });
});

describe('flags admin page auth gate', { concurrency: 1 }, () => {
  it('returns 403 when the admin authorize rejects', async () => {
    const app = await makeApp({ experiment: true }, () => false);
    const response = await app.request('/admin/flags');
    assert.equal(response.status, 403);
    await app.close();
  });

  it('serves the page to no one without an authorize option', async () => {
    const app = await makeApp({ experiment: false }, undefined, null);
    assert.equal((await app.request('/admin/flags')).status, 403);
    const response = await postForm(app, '/admin/flags', {
      flag_key: 'experiment',
      flag_active: 'true',
    });
    assert.equal(response.status, 403);
    await app.close();
  });

  it('forwards authorize to the page with the session and slug', async () => {
    const seen: string[] = [];
    const app = await makeApp({ experiment: true }, undefined, ({ session, slug }) => {
      seen.push(`${session.id}:${slug}`);
      return false;
    });
    assert.equal((await app.request('/admin/flags')).status, 403);
    assert.deepEqual(seen, [`${SESSION.id}:flags`]);
    await app.close();
  });

  it('forwards authorize from flagsAdmin to its page', async () => {
    const plugin = flagsPlugin();
    const app = await createTestApp({
      config: {
        port: 0,
        // The app's own sessions, which the panel reads too.
        resolveSession: () => SESSION,
        extensions: [
          cachePlugin({ store: 'memory' }),
          plugin,
          adminPlugin(
            defineAdminPanel({
              resolveSession: () => SESSION,
              authorize: () => true,
              adminPlugins: [flagsAdmin({ authorize: () => false })],
            }),
          ),
        ],
      },
    });
    assert.equal((await app.request('/admin/flags')).status, 403);
    await app.close();
  });
});
