/**
 * Tests for the plugins page: the discovered plugin list, the raw install
 * form, and the per-row actions, driven through the real admin plugin.
 *
 * - installs are gated behind `resolveDownloadsCapability` (`downloads: false`
 *   disables them) and refuse code-enabled ids (409);
 * - mutating posts enforce same-origin `Origin` and a constant-time `_csrf`
 *   check, else a value-free 403;
 * - a successful install passes the submitted `id`/`version`/`url` (and an
 *   optional `sha256`, mapped to the artifact-name checksums key) to the
 *   installer, then 303-redirects with an `installed` notice;
 * - enable/disable flip the managed state source's `enabled` flag and redirect
 *   with the matching notice; non-managed panels and unknown/invalid ids are
 *   rejected with the documented status codes;
 * - uninstall/rollback delegate to the installer and redirect with their
 *   notices;
 * - the list renders a restart notice from the `notice` query param and an
 *   Actions column only when a row is manageable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import type { PluginInstaller } from 'jsails/plugins';
import { postForm } from 'jsails/testing';

import {
  PLUGIN_NOTICE_DISABLED,
  PLUGIN_NOTICE_ENABLED,
  PLUGIN_NOTICE_INSTALLED,
  PLUGIN_NOTICE_ROLLED_BACK,
  PLUGIN_NOTICE_UNINSTALLED,
} from '../src/index.js';
import {
  createInstaller,
  createPluginManagerApp,
  createStateSource,
  CSRF,
  pluginsRoot,
} from './fixtures.js';

describe('plugin manager install', () => {
  it('rejects an install when downloads are disabled', async () => {
    const inst = createInstaller();
    const app = await createPluginManagerApp({
      plugins: {
        downloads: false,
        installer: inst.installer,
        pluginsDir: join(pluginsRoot, 'plugins'),
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'install',
      id: 'acme',
      version: '2.0.0',
      url: 'https://example.com/acme.tgz',
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /disabled by configuration/);
    assert.equal(inst.installs.length, 0);

    await app.close();
  });

  it('rejects an install when no installer is configured', async () => {
    const app = await createPluginManagerApp({
      plugins: { pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'install',
      id: 'acme',
      version: '2.0.0',
      url: 'https://example.com/acme.tgz',
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /not configured/);

    await app.close();
  });

  it('rejects an install without a same-origin Origin or a valid CSRF token', async () => {
    const inst = createInstaller();
    const app = await createPluginManagerApp({
      plugins: { installer: inst.installer, pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const noOrigin = await app.request('/admin/plugins', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: CSRF,
        action: 'install',
        id: 'acme',
        version: '2.0.0',
        url: 'https://example.com/acme.tgz',
      }).toString(),
    });
    assert.equal(noOrigin.status, 403);

    const badCsrf = await postForm(app, '/admin/plugins', {
      _csrf: 'wrong-token',
      action: 'install',
      id: 'acme',
      version: '2.0.0',
      url: 'https://example.com/acme.tgz',
    });
    assert.equal(badCsrf.status, 403);

    assert.equal(inst.installs.length, 0);
    await app.close();
  });

  it('refuses to install a code-enabled plugin id with 409', async () => {
    const inst = createInstaller();
    const app = await createPluginManagerApp({
      plugins: {
        enabled: ['acme'],
        installer: inst.installer,
        pluginsDir: join(pluginsRoot, 'plugins'),
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'install',
      id: 'acme',
      version: '2.0.0',
      url: 'https://example.com/acme.tgz',
    });
    assert.equal(response.status, 409);
    assert.equal(inst.installs.length, 0);

    await app.close();
  });

  it('installs from form values and 303-redirects with an installed notice', async () => {
    const inst = createInstaller();
    const app = await createPluginManagerApp({
      plugins: { installer: inst.installer, pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'install',
      id: 'acme',
      version: '2.0.0',
      url: 'https://example.com/acme.tgz',
      sha256: 'abc123',
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      `/admin/plugins?notice=${PLUGIN_NOTICE_INSTALLED}`,
    );

    assert.equal(inst.installs.length, 1);
    const call = inst.installs[0]!;
    assert.equal(call.id, 'acme');
    assert.equal(call.version, '2.0.0');
    assert.equal(call.url, 'https://example.com/acme.tgz');
    // The checksum is keyed by the URL path basename, matching the installer's
    // artifact-name derivation.
    assert.deepEqual(call.checksums, { 'acme.tgz': 'abc123' });

    await app.close();
  });

  it('derives the checksum key from the URL path basename, ignoring query/fragment', async () => {
    const inst = createInstaller();
    const app = await createPluginManagerApp({
      plugins: { installer: inst.installer, pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'install',
      id: 'acme',
      version: '2.0.0',
      url: 'https://example.com/dl/acme-2.0.0.tgz?token=secret#frag',
      sha256: 'deadbeef',
    });
    assert.equal(response.status, 303);
    assert.deepEqual(inst.installs[0]!.checksums, { 'acme-2.0.0.tgz': 'deadbeef' });

    await app.close();
  });

  it('returns a value-free 400 when the install fails', async () => {
    const failing: PluginInstaller = {
      install: async () => {
        throw new Error('secret failure detail');
      },
      uninstall: async () => {},
      rollback: async () => {},
    };
    const app = await createPluginManagerApp({
      plugins: { installer: failing, pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'install',
      id: 'acme',
      version: '2.0.0',
      url: 'https://example.com/acme.tgz',
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /secret failure detail/);

    await app.close();
  });

  it('rejects an invalid install id with 400', async () => {
    const inst = createInstaller();
    const app = await createPluginManagerApp({
      plugins: { installer: inst.installer, pluginsDir: join(pluginsRoot, 'plugins') },
    });

    for (const id of ['', 'BAD ID', '__proto__']) {
      const response = await postForm(app, '/admin/plugins', {
        _csrf: CSRF,
        action: 'install',
        id,
        version: '1.0.0',
        url: 'https://example.com/a.tgz',
      });
      assert.equal(response.status, 400, `id ${JSON.stringify(id)}`);
    }
    assert.equal(inst.installs.length, 0);

    await app.close();
  });
});

describe('plugin manager enable/disable', () => {
  it('enables and disables a managed plugin, redirecting with the matching notice', async () => {
    const stateSource = createStateSource({ acme: { active: '1.2.3', enabled: false } });
    const app = await createPluginManagerApp({
      plugins: { managed: true, stateSource: stateSource.source },
    });

    const enable = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'enable',
      id: 'acme',
    });
    assert.equal(enable.status, 303);
    assert.equal(enable.headers.get('location'), `/admin/plugins?notice=${PLUGIN_NOTICE_ENABLED}`);
    assert.equal(stateSource.state.plugins['acme']?.enabled, true);

    const disable = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'disable',
      id: 'acme',
    });
    assert.equal(disable.status, 303);
    assert.equal(
      disable.headers.get('location'),
      `/admin/plugins?notice=${PLUGIN_NOTICE_DISABLED}`,
    );
    assert.equal(stateSource.state.plugins['acme']?.enabled, false);

    await app.close();
  });

  it('preserves the active version while toggling enabled', async () => {
    const stateSource = createStateSource({ acme: { active: '1.2.3', enabled: true } });
    const app = await createPluginManagerApp({
      plugins: { managed: true, stateSource: stateSource.source },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'disable',
      id: 'acme',
    });
    assert.equal(response.status, 303);
    assert.deepEqual(stateSource.state.plugins['acme'], { active: '1.2.3', enabled: false });

    await app.close();
  });

  it('rejects a toggle when the panel is not managed', async () => {
    const app = await createPluginManagerApp({
      plugins: { pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'enable',
      id: 'acme',
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /not managed/);

    await app.close();
  });

  it('rejects a toggle when managed is true but no state source is configured', async () => {
    const app = await createPluginManagerApp({
      plugins: { managed: true, pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'disable',
      id: 'acme',
    });
    assert.equal(response.status, 403);

    await app.close();
  });

  it('returns 404 for a toggle id that is not in the managed state', async () => {
    const stateSource = createStateSource({});
    const app = await createPluginManagerApp({
      plugins: { managed: true, stateSource: stateSource.source },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'enable',
      id: 'ghost',
    });
    assert.equal(response.status, 404);

    await app.close();
  });

  it('rejects an invalid toggle id with 400', async () => {
    const stateSource = createStateSource({});
    const app = await createPluginManagerApp({
      plugins: { managed: true, stateSource: stateSource.source },
    });

    for (const id of ['', 'BAD ID', '__proto__']) {
      const response = await postForm(app, '/admin/plugins', {
        _csrf: CSRF,
        action: 'enable',
        id,
      });
      assert.equal(response.status, 400, `id ${JSON.stringify(id)}`);
    }

    await app.close();
  });
});

describe('plugin manager uninstall/rollback', () => {
  it('uninstalls a plugin and redirects with an uninstalled notice', async () => {
    const inst = createInstaller();
    const app = await createPluginManagerApp({
      plugins: { installer: inst.installer, pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'uninstall',
      id: 'acme',
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      `/admin/plugins?notice=${PLUGIN_NOTICE_UNINSTALLED}`,
    );
    assert.deepEqual(inst.uninstalls, ['acme']);

    await app.close();
  });

  it('rejects an uninstall when no installer is configured', async () => {
    const app = await createPluginManagerApp({
      plugins: { pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'uninstall',
      id: 'acme',
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /not configured/);

    await app.close();
  });

  it('rolls back a plugin and redirects with a rolled-back notice', async () => {
    const inst = createInstaller();
    const app = await createPluginManagerApp({
      plugins: { installer: inst.installer, pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'rollback',
      id: 'acme',
      version: '1.0.0',
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      `/admin/plugins?notice=${PLUGIN_NOTICE_ROLLED_BACK}`,
    );
    assert.deepEqual(inst.rollbacks, [['acme', '1.0.0']]);

    await app.close();
  });
});

describe('plugin manager list notices and actions', () => {
  it('renders a restart notice from the notice query parameter', async () => {
    const app = await createPluginManagerApp({
      plugins: { pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await app.request(`/admin/plugins?notice=${PLUGIN_NOTICE_INSTALLED}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Restart the server/);

    await app.close();
  });

  it('ignores an unknown notice query parameter', async () => {
    const app = await createPluginManagerApp({
      plugins: { pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await app.request('/admin/plugins?notice=bogus');
    assert.doesNotMatch(await response.text(), /Restart the server/);

    await app.close();
  });

  it('renders toggle actions for a managed plugin row', async () => {
    const stateSource = createStateSource({ acme: { active: '1.2.3', enabled: true } });
    const app = await createPluginManagerApp({
      plugins: {
        managed: true,
        stateSource: stateSource.source,
        enabled: ['acme'],
        pluginsDir: join(pluginsRoot, 'plugins'),
      },
    });

    const response = await app.request('/admin/plugins');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Actions/);
    assert.match(body, /Disable/);
    assert.match(body, /name="_csrf"/);

    await app.close();
  });

  it('renders an Enable action for a disabled managed plugin row', async () => {
    const stateSource = createStateSource({ acme: { active: '1.2.3', enabled: false } });
    const app = await createPluginManagerApp({
      plugins: {
        managed: true,
        stateSource: stateSource.source,
        enabled: ['acme'],
        pluginsDir: join(pluginsRoot, 'plugins'),
      },
    });

    const response = await app.request('/admin/plugins');
    assert.match(await response.text(), /Enable/);

    await app.close();
  });

  it('omits the Actions column when no row is manageable', async () => {
    const app = await createPluginManagerApp({
      plugins: { enabled: ['acme'], pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await app.request('/admin/plugins');
    const body = await response.text();
    assert.doesNotMatch(body, /Actions/);
    assert.match(body, />enabled</);

    await app.close();
  });
});
