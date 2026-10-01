/**
 * Feature-flags admin page tests.
 *
 * These drive the flags admin page through a real in-process `Application`: the
 * admin plugin is mounted as an extension, the flags page is passed as a panel
 * page, and every request is routed through the same pipeline `serve` uses. No
 * browser, database, Valkey, or listener is involved.
 *
 * The page reads the same `FeatureStore` the app hands `flagsPlugin`, so tests
 * seed an in-memory store with known flags.
 *
 * Coverage:
 * - Empty listing: no global flags → "No global flags configured."
 * - Flag listing: active/inactive badges and toggle buttons in the table.
 * - Toggle: POST to activate an inactive flag, POST to deactivate an active flag.
 * - Invalid POST: missing key/active fields → 400; unknown flag → 404.
 * - Auth gate: the default-deny auth still applies (403 when unauthorized).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adminPlugin, defineAdminPanel } from '@jsails/admin';
import type { Session } from 'jsails';
import { createTestApp, createTestSession, postForm, type TestApplication } from 'jsails/testing';
import { createMemoryFlagStore } from '../src/flags.js';
import { defineFlagsAdminPage, flagsAdmin } from '../src/admin/index.js';

const SESSION = createTestSession({ id: 'admin-session-1' });

/** A test app with the flags admin page wired directly over a seeded store. */
async function makeApp(
  flagsSeeds: Record<string, boolean>,
  authorize?: (session: Session | null) => boolean | Promise<boolean>,
): Promise<TestApplication> {
  const store = createMemoryFlagStore();
  for (const [key, value] of Object.entries(flagsSeeds)) {
    await store.set(key, value);
  }

  return createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: authorize ?? (() => true),
            pages: [defineFlagsAdminPage({ store })],
          }),
        ),
      ],
    },
  });
}

describe('flagsAdmin', { concurrency: 1 }, () => {
  it('contributes the flags page through the panel adminPlugins list', async () => {
    const store = createMemoryFlagStore();
    await store.set('experiment', true);
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [
          adminPlugin(
            defineAdminPanel({
              resolveSession: () => SESSION,
              authorize: () => true,
              adminPlugins: [flagsAdmin({ store })],
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

  it('rejects a missing store', () => {
    assert.throws(() => flagsAdmin({} as never), TypeError);
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
      _csrf: SESSION.csrfToken,
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

  it('deactivates an active flag via POST', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      _csrf: SESSION.csrfToken,
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
      _csrf: SESSION.csrfToken,
      flag_active: 'false',
    });
    assert.equal(response.status, 400);
    await app.close();
  });

  it('returns 400 when flag_active is missing', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      _csrf: SESSION.csrfToken,
      flag_key: 'experiment',
    });
    assert.equal(response.status, 400);
    await app.close();
  });

  it('returns 400 for an invalid flag_active value', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      _csrf: SESSION.csrfToken,
      flag_key: 'experiment',
      flag_active: 'invalid',
    });
    assert.equal(response.status, 400);
    await app.close();
  });

  it('returns 404 when the flag key is unknown', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      _csrf: SESSION.csrfToken,
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
});
