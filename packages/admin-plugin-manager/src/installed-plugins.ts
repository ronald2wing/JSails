/**
 * The installed plugins as the plugin manager pages see them: filesystem
 * discovery merged with the persisted state document, plus the downloads
 * capability that gates installs.
 *
 * Discovery (honoring the `enabled` allow-list and `pluginsDir`) and persisted
 * state are loaded together; either failing degrades to empty data rather than
 * a 500, so the pages always render.
 *
 * Discovery is a synchronous walk of the app's dependencies and bundle
 * directory, so its result is cached per plugin manager instance instead of
 * blocking the event loop on every page view. The pages drop the cache after
 * each POST that can change the plugin set, and an entry expires after
 * {@link DISCOVERY_CACHE_TTL_MS} so a change made outside the admin (the CLI,
 * an `npm install`) shows up without a restart. The state document is small and
 * read through its own async source, so it is loaded fresh every time.
 */

import {
  discoverPlugins,
  PLUGIN_STATE_VERSION,
  resolveDownloadsCapability,
  type DiscoverPluginsResult,
  type DownloadsCapability,
  type PluginState,
  type PluginStateEntry,
} from 'jsails/plugins';

import type { ResolvedPluginManagerOptions } from './plugin-manager.js';

/** The discovery result (absent when discovery failed) plus the persisted state. */
export interface InstalledPlugins {
  readonly discovered: DiscoverPluginsResult | undefined;
  readonly state: PluginState;
}

/** How long a cached discovery result serves page views, in milliseconds. */
export const DISCOVERY_CACHE_TTL_MS = 10_000;

/** A discovery result and when it was taken (`Date.now()`). */
interface CachedDiscovery {
  readonly result: DiscoverPluginsResult;
  readonly takenAt: number;
}

/** Keyed by the resolved options, which each plugin manager instance shares across its pages. */
const discoveryCache = new WeakMap<ResolvedPluginManagerOptions, CachedDiscovery>();

/** Drop the cached discovery so the next page view walks the filesystem again. */
export function invalidateInstalledPlugins(options: ResolvedPluginManagerOptions): void {
  discoveryCache.delete(options);
}

/**
 * The cached discovery result while it is fresh, else a new walk. A failed
 * walk is not cached, so the next view retries it.
 */
function discover(options: ResolvedPluginManagerOptions): DiscoverPluginsResult | undefined {
  const now = Date.now();
  const cached = discoveryCache.get(options);
  if (cached !== undefined && now - cached.takenAt < DISCOVERY_CACHE_TTL_MS) {
    return cached.result;
  }
  let result: DiscoverPluginsResult;
  try {
    result = discoverPlugins({
      rootDir: process.cwd(),
      pluginsDir: options.pluginsDir,
      enabled: options.enabled,
    });
  } catch {
    discoveryCache.delete(options);
    return undefined;
  }
  discoveryCache.set(options, { result, takenAt: now });
  return result;
}

/** Discover plugins and load persisted state, degrading failures to empty data. */
export async function loadInstalledPlugins(
  options: ResolvedPluginManagerOptions,
): Promise<InstalledPlugins> {
  const discovered = discover(options);

  let state: PluginState;
  try {
    state = await options.state.load();
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
export function downloadsCapability(options: ResolvedPluginManagerOptions): DownloadsCapability {
  return resolveDownloadsCapability({ configured: options.downloads, staticExport: false });
}
