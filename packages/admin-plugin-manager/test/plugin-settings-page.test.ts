/**
 * Tests for the plugin settings page: one form per installed plugin rendered
 * from its projected `settingsSchema` (editable string/number/boolean fields,
 * read-only unknown entries), the save that preserves unknown keys and
 * redirects with a notice, and the origin/CSRF, managed-mode, and unknown-id
 * gates.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import { postForm } from 'jsails/testing';

import { PLUGIN_NOTICE_SETTINGS_SAVED } from '../src/index.js';
import { createPluginManagerApp, createStateSource, CSRF, settingsRoot } from './fixtures.js';

describe('plugin manager settings', () => {
  it('renders editable fields for an interpretable schema and read-only for unknown', async () => {
    const stateSource = createStateSource({ 'settings-demo': { active: '1.0.0', enabled: true } });
    const app = await createPluginManagerApp({
      plugins: {
        managed: true,
        stateSource: stateSource.source,
        pluginsDir: join(settingsRoot, 'plugins'),
      },
    });

    const response = await app.request('/admin/plugin-settings');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Plugin Settings/);
    // Number field with its label and default value.
    assert.match(body, /name="retries"/);
    assert.match(body, /type="number"/);
    assert.match(body, /value="3"/);
    // Boolean field rendered as a checkbox.
    assert.match(body, /name="verbose"/);
    assert.match(body, /type="checkbox"/);
    // String shorthand field.
    assert.match(body, /name="name"/);
    // Unknown-shaped entry renders read-only and is never a submitted control.
    assert.match(body, /readonly/);
    assert.doesNotMatch(body, /name="opaque"/);
    // The settings form always carries the CSRF token and action.
    assert.match(body, /name="_csrf"/);
    assert.match(body, /value="save-settings"/);

    await app.close();
  });

  it('saves settings, preserving unknown keys, and redirects with a notice', async () => {
    const stateSource = createStateSource({
      'settings-demo': {
        active: '1.0.0',
        enabled: true,
        settings: { opaque: { keep: true }, name: 'old' },
      },
    });
    const app = await createPluginManagerApp({
      plugins: {
        managed: true,
        stateSource: stateSource.source,
        pluginsDir: join(settingsRoot, 'plugins'),
      },
    });

    const response = await postForm(app, '/admin/plugin-settings', {
      _csrf: CSRF,
      action: 'save-settings',
      id: 'settings-demo',
      retries: '5',
      verbose: 'on',
      name: 'hello',
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      `/admin/plugin-settings?notice=${PLUGIN_NOTICE_SETTINGS_SAVED}`,
    );
    assert.deepEqual(stateSource.state.plugins['settings-demo']?.settings, {
      opaque: { keep: true },
      retries: 5,
      verbose: true,
      name: 'hello',
    });

    await app.close();
  });

  it('rejects a save without a same-origin Origin or a valid CSRF token', async () => {
    const stateSource = createStateSource({ 'settings-demo': { active: '1.0.0', enabled: true } });
    const app = await createPluginManagerApp({
      plugins: {
        managed: true,
        stateSource: stateSource.source,
        pluginsDir: join(settingsRoot, 'plugins'),
      },
    });

    const fields = { action: 'save-settings', id: 'settings-demo', name: 'hello' };

    const noOrigin = await app.request('/admin/plugin-settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: CSRF, ...fields }).toString(),
    });
    assert.equal(noOrigin.status, 403);

    const badCsrf = await postForm(app, '/admin/plugin-settings', {
      _csrf: 'wrong-token',
      ...fields,
    });
    assert.equal(badCsrf.status, 403);

    assert.deepEqual(stateSource.saves, []);
    await app.close();
  });

  it('rejects a save when the panel is not managed', async () => {
    const app = await createPluginManagerApp({
      plugins: { pluginsDir: join(settingsRoot, 'plugins') },
    });

    const response = await postForm(app, '/admin/plugin-settings', {
      _csrf: CSRF,
      action: 'save-settings',
      id: 'settings-demo',
      name: 'hello',
    });
    assert.equal(response.status, 403);

    await app.close();
  });

  it('rejects a save for an id that is not in the managed state with 404', async () => {
    const stateSource = createStateSource({});
    const app = await createPluginManagerApp({
      plugins: {
        managed: true,
        stateSource: stateSource.source,
        pluginsDir: join(settingsRoot, 'plugins'),
      },
    });

    const response = await postForm(app, '/admin/plugin-settings', {
      _csrf: CSRF,
      action: 'save-settings',
      id: 'settings-demo',
      name: 'hello',
    });
    assert.equal(response.status, 404);

    await app.close();
  });

  it('renders a managed-required message when the panel is not managed', async () => {
    const app = await createPluginManagerApp({
      plugins: { pluginsDir: join(settingsRoot, 'plugins') },
    });

    const response = await app.request('/admin/plugin-settings');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /require a managed plugin state source/);

    await app.close();
  });
});
