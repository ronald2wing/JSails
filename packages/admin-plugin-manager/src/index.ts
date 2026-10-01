/**
 * `@jsails/admin-plugin-manager`: the admin contribution that mounts the
 * plugin install/enable/disable/uninstall/rollback surface under an admin panel.
 *
 * `pluginManagerAdmin(options)` returns an {@link AdminPlugin} (id
 * `admin-plugin-manager`) whose `register` contributes two admin pages mounted
 * by `adminPlugin` like any other: `plugins` (the discovered plugin list plus,
 * when configured, the install form or curated directory and the per-row
 * actions; a `POST` is dispatched on the submitted `action` field) and
 * `plugin-settings` (per-plugin settings forms in managed mode). The admin has
 * already enforced the default-deny auth gate, a same-origin `Origin`, and a
 * constant-time `_csrf` check before the page's `handlePost` runs.
 *
 * The notice codes (`PLUGIN_NOTICE_*`) are the stable query values a successful
 * mutation redirects to; they are exported so callers and tests can recognize
 * them without string literals. The `PluginInstaller` and `PluginStateSource`
 * types are re-exported so an app can wire the built-in installer/store (or its
 * own implementations) into the pages without importing `jsails/plugins`
 * directly. `createPluginDirectory` builds the curated directory the
 * `directory` option takes, and `firstPartyPluginDirectory` is the shipped one.
 *
 * It depends on the admin foundation (`@jsails/admin`) and the plugin system;
 * it is server-only (it discovers plugins on the filesystem).
 */

export {
  pluginManagerAdmin,
  PluginManagerError,
  type PluginManagerAdminOptions,
  type PluginManagerErrorCode,
} from './plugin-manager.js';

export {
  PLUGIN_NOTICE_INSTALLED,
  PLUGIN_NOTICE_ENABLED,
  PLUGIN_NOTICE_DISABLED,
  PLUGIN_NOTICE_UNINSTALLED,
  PLUGIN_NOTICE_ROLLED_BACK,
  PLUGIN_NOTICE_SETTINGS_SAVED,
} from './plugin-notices.js';

export type { PluginInstaller, PluginStateSource } from 'jsails/plugins';

export {
  createPluginDirectory,
  DirectoryError,
  firstPartyPluginDirectory,
  type DirectoryErrorCode,
  type DirectoryListOptions,
  type DirectorySort,
  type PluginDirectory,
  type PluginDirectoryEntry,
} from './directory/index.js';
