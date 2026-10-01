/**
 * Shared fixtures for the plugin manager test suite: a test app mounting the
 * plugin manager under an admin panel, real temp bundle trees, and in-memory
 * installer, state source, and directory fakes that record every call.
 *
 * Every app is a real in-process `Application`: the admin plugin registers
 * trusted Hono hook routes and every request is routed through the same
 * pipeline `serve` uses. No browser, database, Valkey, network, or listener is
 * involved, and nothing is mutated beyond the temp fixture.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import { adminPlugin, defineAdminPanel } from '@jsails/admin';
import type { Session } from 'jsails';
import {
  PLUGIN_STATE_VERSION,
  type InstallPluginInput,
  type PluginInstaller,
  type PluginState,
  type PluginStateEntry,
  type PluginStateSource,
} from 'jsails/plugins';
import { createTestApp, createTestSession, type TestApplication } from 'jsails/testing';

import {
  createPluginDirectory,
  pluginManagerAdmin,
  type PluginDirectory,
  type PluginManagerAdminOptions,
} from '../src/index.js';

/** The authorized admin session every fixture app resolves. */
export const SESSION = createTestSession();

/** The CSRF token mutating posts must carry as `_csrf`. */
export const CSRF = SESSION.csrfToken;

/** A v1 bundle `manifest.json` with the descriptive fields every manifest needs. */
export function bundleManifest(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    manifestVersion: 1,
    name: 'Fixture plugin',
    summary: 'A plugin the tests build.',
    publisher: 'acme',
    apiTier: 'stable',
    marketplace: true,
    ...fields,
  };
}

/**
 * A real temp tree with one storage-backed plugin bundle (`acme`). A missing
 * `state.json` means the plugin has no persisted state.
 */
export const pluginsRoot = mkdtempSync(join(tmpdir(), 'jsails-admin-plugin-manager-'));
mkdirSync(join(pluginsRoot, 'plugins', 'acme', '1.2.3'), { recursive: true });
writeFileSync(
  join(pluginsRoot, 'plugins', 'acme', '1.2.3', 'manifest.json'),
  JSON.stringify(
    bundleManifest({
      id: 'acme',
      version: '1.2.3',
      jsailsCompat: '^0.1.0',
      entry: './index.js',
    }),
  ),
);

/**
 * A bundle (`settings-demo`) whose manifest declares a mixed settings schema:
 * interpretable string/number/boolean fields plus an unknown-shaped entry that
 * must render read-only.
 */
export const settingsRoot = mkdtempSync(join(tmpdir(), 'jsails-plugin-settings-'));
mkdirSync(join(settingsRoot, 'plugins', 'settings-demo', '1.0.0'), { recursive: true });
writeFileSync(
  join(settingsRoot, 'plugins', 'settings-demo', '1.0.0', 'manifest.json'),
  JSON.stringify(
    bundleManifest({
      id: 'settings-demo',
      version: '1.0.0',
      jsailsCompat: '^0.1.0',
      entry: './index.js',
      settings: {
        type: 'object',
        properties: {
          retries: { type: 'number', title: 'Retries', default: 3 },
          timeout: { type: 'number' },
          verbose: { type: 'boolean', title: 'Verbose' },
          name: { type: 'string' },
          opaque: { type: 'array', items: { type: 'string' } },
        },
      },
    }),
  ),
);

/**
 * A second bundle (`settings-other`) sharing the `name` key with
 * `settings-demo`, plus a key named `id` that must not shadow the form's own
 * hidden plugin id.
 */
mkdirSync(join(settingsRoot, 'plugins', 'settings-other', '1.0.0'), { recursive: true });
writeFileSync(
  join(settingsRoot, 'plugins', 'settings-other', '1.0.0', 'manifest.json'),
  JSON.stringify(
    bundleManifest({
      id: 'settings-other',
      version: '1.0.0',
      jsailsCompat: '^0.1.0',
      entry: './index.js',
      settings: {
        type: 'object',
        properties: { name: { type: 'string' }, id: { type: 'string' } },
      },
    }),
  ),
);

after(() => {
  rmSync(pluginsRoot, { recursive: true, force: true });
  rmSync(settingsRoot, { recursive: true, force: true });
});

export interface PluginManagerAppOptions {
  readonly plugins?: PluginManagerAdminOptions;
  readonly authorize?: (session: Session | null) => boolean | Promise<boolean>;
  /**
   * Pass `plugins` unchanged. Otherwise the fixture grants both plugin manager
   * gates (`authorize`, `authorizeInstall`) unless `plugins` sets its own.
   */
  readonly bare?: boolean;
}

/** A valid hex SHA-256 the fake installers accept (never checked against bytes). */
export const SHA256 = 'a'.repeat(64);

/** Create a test app mounting the plugin manager under the default admin panel. */
export function createPluginManagerApp(
  options: PluginManagerAppOptions = {},
): Promise<TestApplication> {
  return createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: options.authorize ?? (() => true),
            adminPlugins: [
              pluginManagerAdmin(
                options.bare === true
                  ? (options.plugins ?? {})
                  : { authorize: () => true, authorizeInstall: () => true, ...options.plugins },
              ),
            ],
          }),
        ),
      ],
    },
  });
}

/** An in-memory installer that records every call and returns `warnings` from installs. */
export function createInstaller(warnings: readonly string[] = []): {
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
        return { id: input.id, version: input.version, warnings };
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

/**
 * An in-memory state source that records every write and exposes its state.
 * It follows the store contract: no write drops an entry it was not given.
 */
export function createStateSource(initial: PluginState['plugins'] = {}) {
  let state: PluginState = { version: PLUGIN_STATE_VERSION, plugins: initial };
  const saves: PluginState[] = [];
  const source: PluginStateSource = {
    async load() {
      return state;
    },
    async save(next: PluginState) {
      saves.push(next);
      state = { ...state, plugins: { ...state.plugins, ...next.plugins } };
    },
    async putEntry(id: string, entry: PluginStateEntry) {
      const next = { ...state, plugins: { ...state.plugins, [id]: entry } };
      saves.push(next);
      state = next;
    },
    async removeEntry(id: string) {
      const next = {
        ...state,
        plugins: Object.fromEntries(Object.entries(state.plugins).filter(([key]) => key !== id)),
      };
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

/**
 * A deterministic in-memory directory of three entries (no I/O). `acme-notes`
 * carries no `sha256`, so it is installable only with `allowUnverified`.
 */
export function createDirectory(): PluginDirectory {
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
      specifier: 'https://registry.example/acme-tasks/-/acme-tasks-1.2.3.tgz',
      sha256: SHA256,
    },
    {
      id: 'acme-notes',
      name: 'Acme Notes',
      description: 'Lightweight note taking.',
      categories: ['productivity', 'writing'],
      featured: false,
      latestVersion: '0.9.0',
      frameworkRange: '>=1.0.0 <2.0.0',
      specifier: 'https://registry.example/acme-notes/-/acme-notes-0.9.0.tgz',
    },
    {
      id: 'acme-metrics',
      name: 'Acme Metrics',
      description: 'Server metrics dashboard.',
      categories: ['observability'],
      featured: false,
      latestVersion: '2.0.0',
      frameworkRange: '>=1.0.0 <2.0.0',
      specifier: 'https://registry.example/acme-metrics/-/acme-metrics-2.0.0.tgz',
      sha256: SHA256,
    },
  ]);
}

/** The framework version every {@link createDirectory} entry is compatible with. */
export const DIRECTORY_FRAMEWORK = '1.5.0';
