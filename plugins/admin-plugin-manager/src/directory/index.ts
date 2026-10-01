/**
 * Plugin directory barrel: the curated catalog model, the pure install/update/
 * rollback planners, the settings-schema projection, and the shared version
 * comparison helper.
 *
 * Nothing here performs network, filesystem, or subprocess work, and nothing is
 * re-exported from the package entry (`src/index.ts`) — the admin plugin
 * manager imports these modules directly to build its install/settings surface.
 */

export {
  assertCompatible,
  createPluginDirectory,
  DirectoryError,
  parsePluginDirectoryEntry,
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

export {
  projectSettingsSchema,
  SettingsProjectionError,
  type SettingsFieldDescriptor,
  type SettingsFieldType,
} from './settings.js';

export { compareVersions } from './versions.js';

export { firstPartyPluginDirectory } from './first-party-catalog.js';
