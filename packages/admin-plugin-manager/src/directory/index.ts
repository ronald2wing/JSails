/**
 * Plugin directory barrel: the curated catalog model, the pure install/update/
 * rollback planners, the settings-schema projection, and the shared version
 * comparison helper, as the plugin manager pages consume them.
 *
 * Nothing here performs network, filesystem, or subprocess work. The package
 * entry re-exports the catalog constructor and `firstPartyPluginDirectory` so
 * an app can build or reuse a curated directory; the planners and the
 * projection stay internal.
 */

export {
  createPluginDirectory,
  DirectoryError,
  type DirectoryErrorCode,
  type DirectoryListOptions,
  type DirectorySort,
  type PluginDirectory,
  type PluginDirectoryEntry,
} from './catalog.js';

export {
  InstallPlanError,
  planPluginInstall,
  planPluginRollback,
  planPluginUpdate,
  type InstallPlan,
  type InstallPlanErrorCode,
  type InstalledPlugin,
} from './install-plan.js';

export { compareVersions } from './versions.js';

export { firstPartyPluginDirectory } from './first-party-catalog.js';
