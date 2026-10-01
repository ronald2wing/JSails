/**
 * Plugin system: manifest v1, the permission registry, the settings schema,
 * plugin package discovery and its framework-version check, the capability
 * gate, plugin schema collection, and `plugins.use` resolution.
 *
 * This subpath is server-side (discovery reads the filesystem) and imports no
 * HTTP, queue, database, or Socket.IO runtime. Discovery and the check read
 * `package.json` manifests only and activate nothing: a plugin runs when the
 * app config lists it in `plugins.use`, which {@link resolvePluginUse} loads.
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

export {
  discoverPlugins,
  PluginDiscoveryError,
  type DiscoverPluginsOptions,
  type DiscoverPluginsResult,
  type DiscoveredPlugin,
  type PluginIssue,
  type PluginDiscoveryErrorCode,
  type PluginFs,
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
  gatePluginCapabilities,
  PluginPermissionError,
  PLUGIN_CAPABILITY_PERMISSIONS,
  type PluginPermissionErrorCode,
} from './capability-gate.js';

export { collectPluginSchema, PluginSchemaError, type PluginSchemaCollection } from './schema.js';

export {
  resolvePluginUse,
  extractPluginFromUse,
  type ResolvePluginUseInput,
  type ResolvePluginUseResult,
} from './use.js';
