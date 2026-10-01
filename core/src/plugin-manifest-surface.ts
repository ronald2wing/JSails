/**
 * `jsails/internal/plugin-manifest`: the static plugin contract (manifest v1,
 * the closed permission registry, the settings-schema subset) for first-party
 * packages that read manifests without loading the plugin runtime: the
 * marketplace's bundle intake and release verification today, the pack tool
 * and the plugin manager next. `jsails/plugins` exports the same contract to
 * applications, together with package discovery and its framework-version
 * check, the capability gate, plugin schema collection and `plugins.use`
 * resolution, which this surface leaves out so that importing it loads the
 * parser and nothing that touches the filesystem or loads a plugin.
 *
 * Like `jsails/internal`, it carries no compatibility promise between versions:
 * a package that imports it pins `jsails` to the exact lockstep version (the
 * declared-deps gate enforces that). Applications never import it.
 */

export {
  checkPluginManifest,
  isValidSemverRange,
  isValidSemverVersion,
  parseBundleManifest,
  parsePackageManifest,
  PLUGIN_ID_PATTERN,
  PLUGIN_MANIFEST_FILENAME,
  PLUGIN_MANIFEST_VERSION,
  PluginManifestError,
  type PluginAdminNavItem,
  type PluginApiTier,
  type PluginDependency,
  type PluginEnvDeclaration,
  type PluginEnvKind,
  type PluginManifestCheck,
  type PluginManifestIssue,
  type PluginManifestSource,
  type PluginManifestV1,
  type PluginSchemaDeclaration,
  type PluginToolDeclaration,
} from './plugins/manifest/index.js';

export {
  describePermission,
  getPermission,
  parsePermission,
  PERMISSIONS,
  type ParsedPermission,
  type PermissionDefinition,
  type PermissionDescription,
  type PermissionIssueCode,
  type PermissionParseResult,
  type PermissionRisk,
  type PermissionScopeKind,
} from './plugins/permissions/index.js';

export {
  describeSettings,
  parseSettingsSchema,
  validateSettings,
  type BooleanSettingsField,
  type NumberSettingsField,
  type SettingsField,
  type SettingsFieldControl,
  type SettingsFieldDescriptor,
  type SettingsIssue,
  type SettingsSchema,
  type SettingsSchemaParseResult,
  type SettingsStringFormat,
  type SettingsValidationResult,
  type StringListItems,
  type StringListSettingsField,
  type StringSettingsField,
} from './plugins/settings-schema/index.js';
