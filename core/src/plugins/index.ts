/**
 * Plugin system — manifest v1, the permission registry, the settings schema,
 * two-source discovery, validation, and the installer foundations.
 *
 * This subpath is server-side (it reads the filesystem) and, apart from the
 * TypeORM entity backing database-managed plugin state
 * (`DatabasePluginState`), imports no HTTP, queue, or Socket.IO runtime: it
 * carries the manifest contract, the provenance labels, the two-source
 * discovery walk, the framework-version check, the `.tgz` bundle extractor, the
 * persisted plugin-state store, the two-source enablement merge, and
 * download-capability resolution, and activation. Everything here reads and
 * validates manifests and installer inputs only except {@link activatePlugins},
 * which dynamically imports plugin entry modules (executing trusted plugin
 * code at import time, though never calling a plugin's `setup` — the extension
 * runner does that).
 */

export {
  checkPluginManifest,
  parsePluginManifest,
  parsePackageManifest,
  parseBundleManifest,
  parseSemver,
  isValidSemverVersion,
  isValidSemverRange,
  satisfiesRange,
  PluginManifestError,
  PLUGIN_ID_PATTERN,
  PLUGIN_MANIFEST_FILENAME,
  PLUGIN_MANIFEST_VERSION,
  type PluginManifestV1,
  type PluginManifestSource,
  type PluginManifestCheck,
  type PluginManifestIssue,
  type PluginApiTier,
  type PluginDependency,
  type PluginSchemaDeclaration,
  type PluginAdminNavItem,
  type PluginToolDeclaration,
  type PluginEnvKind,
  type PluginEnvDeclaration,
  type SemverVersion,
} from './manifest/index.js';

export {
  PERMISSIONS,
  getPermission,
  parsePermission,
  describePermission,
  type PermissionDefinition,
  type PermissionRisk,
  type PermissionScopeKind,
  type ParsedPermission,
  type PermissionIssueCode,
  type PermissionParseResult,
  type PermissionDescription,
} from './permissions/index.js';

export {
  parseSettingsSchema,
  validateSettings,
  describeSettings,
  type SettingsSchema,
  type SettingsField,
  type StringSettingsField,
  type NumberSettingsField,
  type BooleanSettingsField,
  type StringListSettingsField,
  type StringListItems,
  type SettingsStringFormat,
  type SettingsSchemaParseResult,
  type SettingsIssue,
  type SettingsValidationResult,
  type SettingsFieldControl,
  type SettingsFieldDescriptor,
} from './settings-schema/index.js';

export { PLUGIN_SOURCES, pluginSourceLabel, type PluginSource } from './provenance.js';

export {
  discoverPlugins,
  PluginDiscoveryError,
  DEFAULT_PLUGINS_DIR,
  type DiscoverPluginsOptions,
  type DiscoverPluginsResult,
  type DiscoveredPlugin,
  type PluginIssue,
  type PluginDiscoveryErrorCode,
  type SkippedPlugin,
  type SkippedPluginReason,
  type PluginFs,
  type PluginDirent,
} from './discovery/index.js';

export {
  checkPlugins,
  readFrameworkVersion,
  PluginCheckError,
  type CheckPluginsResult,
  type CheckFinding,
  type CheckFindingKind,
} from './check.js';

export {
  extractTarGz,
  ArchiveError,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_TOTAL_BYTES,
  type ExtractTarGzOptions,
  type ArchiveErrorCode,
} from './archive.js';

export {
  PluginStateStore,
  PluginStateError,
  pluginStateSchema,
  PLUGIN_STATE_FILENAME,
  PLUGIN_STATE_VERSION,
  type PluginState,
  type PluginStateEntry,
  type PluginStateSource,
  type PluginStateStoreOptions,
  type PluginStateFs,
} from './state-store.js';

export {
  DatabasePluginState,
  pluginStateEntities,
  PLUGIN_STATE_TABLE,
} from './database-state-entity.js';

export {
  createDatabasePluginStateStore,
  type DatabasePluginStateStoreOptions,
} from './database-state-store.js';

export {
  resolveDownloadsCapability,
  type ResolveDownloadsCapabilityInput,
  type DownloadsCapability,
} from './download-capability.js';

export {
  createPluginInstaller,
  PluginInstallerError,
  DEFAULT_MAX_BYTES,
  type PluginInstaller,
  type PluginInstallerErrorCode,
  type PluginInstallerOptions,
  type InstallPluginInput,
  type PluginInstallResult,
  type VerifySignature,
  type PluginInstallerFs,
  type PluginInstallerStat,
} from './installer.js';

export {
  resolvePluginEnablement,
  loadPluginEnablement,
  loadPluginEnablementState,
  PluginEnablementError,
  type ResolvePluginEnablementInput,
  type PluginEnablement,
  type LoadPluginEnablementInput,
  type LoadedPluginEnablement,
} from './enablement.js';

export {
  activatePlugins,
  isBareSpecifier,
  type ActivatePluginsInput,
  type ActivatePluginsResult,
} from './activation.js';

export {
  gatePluginCapabilities,
  PluginPermissionError,
  PLUGIN_CAPABILITY_PERMISSIONS,
  type PluginPermissionErrorCode,
} from './capability-gate.js';

export { UNVERIFIED_BUNDLE_WARNING } from './bundle-intake.js';

export { collectPluginSchemaEntities, PluginSchemaError } from './schema.js';

export {
  parsePluginSnapshot,
  exportPluginSnapshot,
  importPluginSnapshot,
  PluginSnapshotError,
  PLUGIN_SNAPSHOT_FORMAT,
  PLUGIN_SNAPSHOT_VERSION,
  type PluginSnapshot,
  type PluginSnapshotEntry,
  type RejectedSnapshotEntry,
  type ImportSnapshotResult,
  type SnapshotFs,
  type ImportPluginSnapshotOptions,
} from './snapshot.js';

export {
  resolvePluginUse,
  normalizeUseEntry,
  extractPluginFromUse,
  type ResolvePluginUseInput,
  type ResolvePluginUseResult,
} from './use.js';
