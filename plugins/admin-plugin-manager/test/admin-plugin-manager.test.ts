/**
 * Plugin manager tests.
 *
 * These drive the first-party plugin manager (`pluginManagerPlugin`) through a
 * real in-process `Application`: the admin plugin registers trusted Hono hook
 * routes and every request is routed through the same pipeline `serve` uses. No
 * browser, database, Valkey, or listener is involved. Fixtures inject an
 * in-memory installer and state source plus a real temp bundle tree, so the
 * manager's gates and side effects are asserted without any network or
 * filesystem mutation beyond the temp fixture:
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
 * - the plugins list renders a restart notice from the `notice` query param and
 *   an Actions column only when a row is manageable, keeping non-managed output
 *   otherwise identical.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { adminPlugin, defineAdminPanel } from '@jsails/admin';
import type { Session } from 'jsails';
import type { InstallPluginInput, PluginInstaller } from 'jsails/plugins';
import { PLUGIN_STATE_VERSION, type PluginState, type PluginStateSource } from 'jsails/plugins';
import {
  PLUGIN_NOTICE_DISABLED,
  PLUGIN_NOTICE_ENABLED,
  PLUGIN_NOTICE_INSTALLED,
  PLUGIN_NOTICE_ROLLED_BACK,
  PLUGIN_NOTICE_SETTINGS_SAVED,
  PLUGIN_NOTICE_UNINSTALLED,
  PluginManagerError,
  createPluginDirectory,
  pluginManagerPlugin,
  type PluginDirectory,
} from '../src/index.js';
import { createTestApp, type TestApplication } from 'jsails/testing';

const SESSION: Session = {
  id: 'admin-session-1',
  csrfToken: 'csrf-secret-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};
const CSRF = SESSION.csrfToken;

// A real temp tree with one storage-backed plugin bundle, used by the plugins
// route tests. A missing `state.json` means the plugin has no persisted state.
const pluginsRoot = mkdtempSync(join(tmpdir(), 'jsails-admin-plugin-manager-'));
mkdirSync(join(pluginsRoot, 'plugins', 'acme'), { recursive: true });
writeFileSync(
  join(pluginsRoot, 'plugins', 'acme', 'manifest.json'),
  JSON.stringify({
    id: 'acme',
    version: '1.2.3',
    jsailsCompat: '^0.1.0',
    entry: './index.js',
  }),
);

// A bundle whose manifest declares a mixed settings schema, used by the
// plugin-settings route tests: interpretable string/number/boolean fields plus
// an unknown-shaped entry that must render read-only.
const settingsRoot = mkdtempSync(join(tmpdir(), 'jsails-plugin-settings-'));
mkdirSync(join(settingsRoot, 'plugins', 'settings-demo'), { recursive: true });
writeFileSync(
  join(settingsRoot, 'plugins', 'settings-demo', 'manifest.json'),
  JSON.stringify({
    id: 'settings-demo',
    version: '1.0.0',
    jsailsCompat: '^0.1.0',
    entry: './index.js',
    settingsSchema: {
      retries: { type: 'number', label: 'Retries', default: 3 },
      verbose: { type: 'boolean', label: 'Verbose' },
      name: 'string',
      opaque: { nested: true },
    },
  }),
);

after(() => {
  rmSync(pluginsRoot, { recursive: true, force: true });
  rmSync(settingsRoot, { recursive: true, force: true });
});

interface PluginManagerOptions {
  readonly enabled?: readonly string[];
  readonly pluginsDir?: string;
  readonly managed?: boolean;
  readonly downloads?: boolean | null;
  readonly stateSource?: PluginStateSource;
  readonly installer?: PluginInstaller;
  readonly directory?: PluginDirectory;
  readonly frameworkVersion?: string;
}

interface AppOptions {
  readonly plugins?: PluginManagerOptions;
  readonly authorize?: (session: Session | null) => boolean | Promise<boolean>;
}

function makeApp(options: AppOptions = {}): Promise<TestApplication> {
  return createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: options.authorize ?? (() => true),
            adminPlugins: [pluginManagerPlugin(options.plugins ?? {})],
          }),
        ),
      ],
    },
  });
}

/** POST an application/x-www-form-urlencoded body with a same-origin header. */
function postForm(
  app: TestApplication,
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      origin: app.origin,
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** An in-memory installer that records every call. */
function makeInstaller(): {
  installer: PluginInstaller;
  installs: InstallPluginInput[];
  uninstalls: string[];
  rollbacks: Array<[string, string]>;
} {
  const installs: InstallPluginInput[] = [];
  const uninstalls: string[] = [];
  const rollbacks: Array<[string, string]> = [];
  return {
    installs,
    uninstalls,
    rollbacks,
    installer: {
      install: async (input) => {
        installs.push(input);
        return { id: input.id, version: input.version, warnings: [] };
      },
      uninstall: async (id) => {
        uninstalls.push(id);
      },
      rollback: async (id, version) => {
        rollbacks.push([id, version]);
      },
    },
  };
}

/** An in-memory state source that records every `save` and exposes its state. */
function makeStateSource(initial: PluginState['plugins'] = {}) {
  let state: PluginState = { version: PLUGIN_STATE_VERSION, plugins: initial };
  const saves: PluginState[] = [];
  const source: PluginStateSource = {
    async load() {
      return state;
    },
    async save(next: PluginState) {
      saves.push(next);
      state = next;
    },
  };
  return {
    source,
    saves,
    get state() {
      return state;
    },
  };
}

/** A deterministic in-repo directory used by the directory tests (no I/O). */
function makeDirectory(): PluginDirectory {
  return createPluginDirectory([
    {
      id: 'acme-tasks',
      name: 'Acme Tasks',
      description: 'Task management for teams.',
      summary: 'Team task management.',
      categories: ['productivity'],
      featured: true,
      latestVersion: '1.2.3',
      frameworkRange: '>=1.0.0 <2.0.0',
      specifier: 'acme-tasks@1.2.3',
    },
    {
      id: 'acme-notes',
      name: 'Acme Notes',
      description: 'Lightweight note taking.',
      categories: ['productivity', 'writing'],
      featured: false,
      latestVersion: '0.9.0',
      frameworkRange: '>=1.0.0 <2.0.0',
      specifier: 'acme-notes@0.9.0',
    },
    {
      id: 'acme-metrics',
      name: 'Acme Metrics',
      description: 'Server metrics dashboard.',
      categories: ['observability'],
      featured: false,
      latestVersion: '2.0.0',
      frameworkRange: '>=1.0.0 <2.0.0',
      specifier: 'acme-metrics@2.0.0',
    },
  ]);
}

/** The framework version every directory entry is compatible with. */
const DIRECTORY_FRAMEWORK = '1.5.0';

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

describe('plugin manager install', () => {
  it('rejects an install when downloads are disabled', async () => {
    const inst = makeInstaller();
    const app = await makeApp({
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
    const app = await makeApp({ plugins: { pluginsDir: join(pluginsRoot, 'plugins') } });

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
    const inst = makeInstaller();
    const app = await makeApp({
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
    const inst = makeInstaller();
    const app = await makeApp({
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
    const inst = makeInstaller();
    const app = await makeApp({
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
    const inst = makeInstaller();
    const app = await makeApp({
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
    const app = await makeApp({
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
    const inst = makeInstaller();
    const app = await makeApp({
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

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

describe('plugin manager enable/disable', () => {
  it('enables and disables a managed plugin, redirecting with the matching notice', async () => {
    const stateSource = makeStateSource({ acme: { active: '1.2.3', enabled: false } });
    const app = await makeApp({
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
    const stateSource = makeStateSource({ acme: { active: '1.2.3', enabled: true } });
    const app = await makeApp({
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
    const app = await makeApp({ plugins: { pluginsDir: join(pluginsRoot, 'plugins') } });

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
    const app = await makeApp({
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
    const stateSource = makeStateSource({});
    const app = await makeApp({ plugins: { managed: true, stateSource: stateSource.source } });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'enable',
      id: 'ghost',
    });
    assert.equal(response.status, 404);

    await app.close();
  });

  it('rejects an invalid toggle id with 400', async () => {
    const stateSource = makeStateSource({});
    const app = await makeApp({ plugins: { managed: true, stateSource: stateSource.source } });

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

// ---------------------------------------------------------------------------
// Uninstall / rollback
// ---------------------------------------------------------------------------

describe('plugin manager uninstall/rollback', () => {
  it('uninstalls a plugin and redirects with an uninstalled notice', async () => {
    const inst = makeInstaller();
    const app = await makeApp({
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
    const app = await makeApp({ plugins: { pluginsDir: join(pluginsRoot, 'plugins') } });

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
    const inst = makeInstaller();
    const app = await makeApp({
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

// ---------------------------------------------------------------------------
// Plugins list: notices and toggle actions
// ---------------------------------------------------------------------------

describe('plugin manager list notices and actions', () => {
  it('renders a restart notice from the notice query parameter', async () => {
    const app = await makeApp({ plugins: { pluginsDir: join(pluginsRoot, 'plugins') } });

    const response = await app.request(`/admin/plugins?notice=${PLUGIN_NOTICE_INSTALLED}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Restart the server/);

    await app.close();
  });

  it('ignores an unknown notice query parameter', async () => {
    const app = await makeApp({ plugins: { pluginsDir: join(pluginsRoot, 'plugins') } });

    const response = await app.request('/admin/plugins?notice=bogus');
    assert.doesNotMatch(await response.text(), /Restart the server/);

    await app.close();
  });

  it('renders toggle actions for a managed plugin row', async () => {
    const stateSource = makeStateSource({ acme: { active: '1.2.3', enabled: true } });
    const app = await makeApp({
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
    const stateSource = makeStateSource({ acme: { active: '1.2.3', enabled: false } });
    const app = await makeApp({
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
    const app = await makeApp({
      plugins: { enabled: ['acme'], pluginsDir: join(pluginsRoot, 'plugins') },
    });

    const response = await app.request('/admin/plugins');
    const body = await response.text();
    assert.doesNotMatch(body, /Actions/);
    assert.match(body, />enabled</);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Plugin settings
// ---------------------------------------------------------------------------

describe('plugin manager settings', () => {
  it('renders editable fields for an interpretable schema and read-only for unknown', async () => {
    const stateSource = makeStateSource({ 'settings-demo': { active: '1.0.0', enabled: true } });
    const app = await makeApp({
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
    const stateSource = makeStateSource({
      'settings-demo': {
        active: '1.0.0',
        enabled: true,
        settings: { opaque: { keep: true }, name: 'old' },
      },
    });
    const app = await makeApp({
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
    const stateSource = makeStateSource({ 'settings-demo': { active: '1.0.0', enabled: true } });
    const app = await makeApp({
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
    const app = await makeApp({ plugins: { pluginsDir: join(settingsRoot, 'plugins') } });

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
    const stateSource = makeStateSource({});
    const app = await makeApp({
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
    const app = await makeApp({ plugins: { pluginsDir: join(settingsRoot, 'plugins') } });

    const response = await app.request('/admin/plugin-settings');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /require a managed plugin state source/);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Directory surface
// ---------------------------------------------------------------------------

describe('plugin manager directory', () => {
  it('renders the directory with search, category filter, and a featured marker', async () => {
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: makeInstaller().installer,
        stateSource: makeStateSource().source,
      },
    });

    const response = await app.request('/admin/plugins');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Plugin directory/);
    // Search input and category select.
    assert.match(body, /name="q"/);
    assert.match(body, /name="category"/);
    assert.match(body, />observability</);
    // A featured entry carries the marker.
    assert.match(body, /Featured/);
    assert.match(body, /Acme Tasks/);
    assert.match(body, /Acme Notes/);
    assert.match(body, /Acme Metrics/);
    // Not-installed entries render an Install action.
    assert.match(body, /Install/);
    // The raw id/version/url/checksum install form is entirely absent.
    assert.doesNotMatch(body, /name="url"/);
    assert.doesNotMatch(body, /name="sha256"/);

    await app.close();
  });

  it('searches directory entries by the q parameter', async () => {
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: makeInstaller().installer,
        stateSource: makeStateSource().source,
      },
    });

    const response = await app.request('/admin/plugins?q=metrics');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Acme Metrics/);
    assert.doesNotMatch(body, /Acme Tasks/);
    assert.doesNotMatch(body, /Acme Notes/);

    await app.close();
  });

  it('filters directory entries by category', async () => {
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: makeInstaller().installer,
        stateSource: makeStateSource().source,
      },
    });

    const response = await app.request('/admin/plugins?category=writing');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Acme Notes/);
    assert.doesNotMatch(body, /Acme Tasks/);
    assert.doesNotMatch(body, /Acme Metrics/);

    await app.close();
  });

  it('degrades an unknown category to an empty state without echoing it', async () => {
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: makeInstaller().installer,
        stateSource: makeStateSource().source,
      },
    });

    const response = await app.request('/admin/plugins?category=SECRET-CATEGORY');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /No plugins match/);
    assert.doesNotMatch(body, /SECRET-CATEGORY/);

    await app.close();
  });

  it('renders the directory read-only when no framework version is configured', async () => {
    const app = await makeApp({ plugins: { directory: makeDirectory() } });

    const response = await app.request('/admin/plugins');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /framework version is not configured/);
    // No actionable install button without a framework version.
    assert.match(body, /Available/);
    assert.doesNotMatch(body, /name="url"/);

    await app.close();
  });

  it('installs a directory entry at the planned version and specifier', async () => {
    const inst = makeInstaller();
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: inst.installer,
        stateSource: makeStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      `/admin/plugins?notice=${PLUGIN_NOTICE_INSTALLED}`,
    );
    assert.equal(inst.installs.length, 1);
    assert.equal(inst.installs[0]!.id, 'acme-tasks');
    assert.equal(inst.installs[0]!.version, '1.2.3');
    assert.equal(inst.installs[0]!.url, 'acme-tasks@1.2.3');

    await app.close();
  });

  it('updates an installed directory entry to the latest version', async () => {
    const inst = makeInstaller();
    const stateSource = makeStateSource({ 'acme-tasks': { active: '1.0.0', enabled: true } });
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: inst.installer,
        stateSource: stateSource.source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-update',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      `/admin/plugins?notice=${PLUGIN_NOTICE_INSTALLED}`,
    );
    assert.equal(inst.installs.length, 1);
    assert.equal(inst.installs[0]!.version, '1.2.3');
    assert.equal(inst.installs[0]!.url, 'acme-tasks@1.2.3');

    await app.close();
  });

  it('rolls a directory entry back to the curated latest version', async () => {
    const inst = makeInstaller();
    const stateSource = makeStateSource({ 'acme-tasks': { active: '2.0.0', enabled: true } });
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: inst.installer,
        stateSource: stateSource.source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-rollback',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      `/admin/plugins?notice=${PLUGIN_NOTICE_ROLLED_BACK}`,
    );
    assert.deepEqual(inst.rollbacks, [['acme-tasks', '1.2.3']]);

    await app.close();
  });

  it('returns 404 for an unknown directory id without echoing it', async () => {
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: makeInstaller().installer,
        stateSource: makeStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'ghost-plugin',
    });
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /ghost-plugin/);

    await app.close();
  });

  it('refuses a directory action when the framework version is incompatible', async () => {
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        frameworkVersion: '2.0.0',
        installer: makeInstaller().installer,
        stateSource: makeStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 403);
    const body = await response.text();
    assert.match(body, /not compatible/);
    assert.doesNotMatch(body, /acme-tasks/);
    assert.doesNotMatch(body, /2\.0\.0/);

    await app.close();
  });

  it('refuses a directory action without an installer', async () => {
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        stateSource: makeStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /not configured/);

    await app.close();
  });

  it('refuses a directory action without a framework version', async () => {
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        installer: makeInstaller().installer,
        stateSource: makeStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /framework version is not configured/);

    await app.close();
  });

  it('refuses a directory action when downloads are disabled', async () => {
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        downloads: false,
        installer: makeInstaller().installer,
        stateSource: makeStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /disabled by configuration/);

    await app.close();
  });

  it('refuses to install a code-enabled directory id with 409', async () => {
    const inst = makeInstaller();
    const app = await makeApp({
      plugins: {
        directory: makeDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        enabled: ['acme-tasks'],
        installer: inst.installer,
        stateSource: makeStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 409);
    assert.equal(inst.installs.length, 0);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Plugin option validation
// ---------------------------------------------------------------------------

describe('pluginManagerPlugin option validation', () => {
  it('rejects a non-boolean managed or downloads flag', () => {
    assert.throws(() => pluginManagerPlugin({ managed: 'yes' as never }), PluginManagerError);
    assert.throws(() => pluginManagerPlugin({ downloads: 1 as never }), PluginManagerError);
  });

  it('rejects a state source that is not a plugin state source', () => {
    assert.throws(() => pluginManagerPlugin({ stateSource: {} as never }), PluginManagerError);
  });

  it('rejects an installer that is not a plugin installer', () => {
    assert.throws(() => pluginManagerPlugin({ installer: {} as never }), PluginManagerError);
  });

  it('rejects an invalid enabled list', () => {
    assert.throws(() => pluginManagerPlugin({ enabled: 'acme' as never }), PluginManagerError);
    assert.throws(() => pluginManagerPlugin({ enabled: [42 as never] }), PluginManagerError);
  });

  it('rejects an invalid pluginsDir', () => {
    assert.throws(() => pluginManagerPlugin({ pluginsDir: '' }), PluginManagerError);
  });

  it('rejects an invalid directory option', () => {
    assert.throws(() => pluginManagerPlugin({ directory: {} as never }), PluginManagerError);
    assert.throws(() => pluginManagerPlugin({ directory: null as never }), PluginManagerError);
  });

  it('rejects an invalid frameworkVersion option', () => {
    assert.throws(
      () => pluginManagerPlugin({ frameworkVersion: 'not-a-version' }),
      PluginManagerError,
    );
  });

  it('accepts a directory and framework version, freezing the options', () => {
    const directory = makeDirectory();
    const plugin = pluginManagerPlugin({ directory, frameworkVersion: DIRECTORY_FRAMEWORK });
    assert.equal(Object.isFrozen(plugin), true);
    assert.equal(plugin.id, 'admin-plugin-manager');
  });

  it('accepts a fully configured plugin and freezes its options', () => {
    const installer = makeInstaller().installer;
    const stateSource = makeStateSource().source;
    const plugin = pluginManagerPlugin({
      managed: true,
      downloads: true,
      installer,
      stateSource,
      enabled: ['acme'],
    });
    assert.equal(Object.isFrozen(plugin), true);
    assert.equal(plugin.id, 'admin-plugin-manager');
  });
});
