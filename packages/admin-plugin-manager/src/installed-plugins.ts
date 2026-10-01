/**
 * The installed plugins as the plugin manager pages see them: filesystem
 * discovery merged with the persisted state document, plus the downloads
 * capability that gates installs.
 *
 * Discovery (honoring the `enabled` allow-list and `pluginsDir`) and persisted
 * state are loaded together; either failing degrades to empty data rather than
 * a 500, so the pages always render.
 */

import { join } from 'node:path';

import {
  DEFAULT_PLUGINS_DIR,
  discoverPlugins,
  PLUGIN_STATE_VERSION,
  PluginStateStore,
  resolveDownloadsCapability,
  type DiscoverPluginsResult,
  type DownloadsCapability,
  type PluginState,
  type PluginStateEntry,
} from 'jsails/plugins';

import type { PluginManagerAdminOptions } from './plugin-manager.js';

/** The discovery result (absent when discovery failed) plus the persisted state. */
export interface InstalledPlugins {
  readonly discovered: DiscoverPluginsResult | undefined;
  readonly state: PluginState;
}

/** Discover plugins and load persisted state, degrading failures to empty data. */
export async function loadInstalledPlugins(
  options: PluginManagerAdminOptions,
): Promise<InstalledPlugins> {
  const pluginsDir = options.pluginsDir ?? join(process.cwd(), DEFAULT_PLUGINS_DIR);

  let discovered: DiscoverPluginsResult | undefined;
  try {
    discovered = discoverPlugins({
      rootDir: process.cwd(),
      pluginsDir: options.pluginsDir,
      enabled: options.enabled,
    });
  } catch {
    discovered = undefined;
  }

  let state: PluginState;
  try {
    if (options.stateSource !== undefined) {
      state = await options.stateSource.load();
    } else {
      state = new PluginStateStore({ pluginsDir }).load();
    }
  } catch {
    state = { version: PLUGIN_STATE_VERSION, plugins: {} };
  }

  return { discovered, state };
}

/** Read a plugin's state entry without ever touching the prototype chain. */
export function stateEntry(state: PluginState, id: string): PluginStateEntry | undefined {
  return Object.hasOwn(state.plugins, id) ? state.plugins[id] : undefined;
}

/**
 * Whether installs may download bundles. The admin surface is a live server,
 * never a static export, so only the configured `downloads` option decides.
 */
export function downloadsCapability(options: PluginManagerAdminOptions): DownloadsCapability {
  return resolveDownloadsCapability({ configured: options.downloads, staticExport: false });
}
