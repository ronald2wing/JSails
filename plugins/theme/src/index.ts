/**
 * Theme subpath: the cross-surface CSS-custom-property contract shared by the
 * admin renderer, the generated starter, and plugin authors.
 *
 * Import from `jsails/theme` for a browser-safe entry — no `node:*`
 * imports, no ORM, no HTTP. The admin renderer reads the resolved tokens
 * through {@link themeToken} (an optional service), the starter layout emits
 * them through {@link ThemeTokens.toCss} (which includes per-theme
 * `[data-theme]` blocks), and plugins contribute through
 * {@link PluginDescription.theme}.
 */

export {
  coreThemeTokenNames,
  createThemeTokens,
  deriveThemeTokens,
  resolveThemeTokens,
  themeTokensToCss,
  ThemeError,
  type ThemeContribution,
  type ThemeResolution,
  type ThemeSeed,
  type ThemeTokenMap,
  type ThemeTokens,
} from './tokens.js';

export { themePlugin, themeToken, type ThemePluginOptions } from './plugin.js';

// Theme packages: manifest validation, pure discovery, and activation. The
// token map type is already exported from ./tokens.js above.
export {
  createThemeRegistry,
  discoverThemePackages,
  isSafeRelativePath,
  parseThemePackageManifest,
  themePackageManifestSchema,
  ThemePackageError,
  THEME_NAME_PATTERN,
  type DiscoverThemePackagesOptions,
  type ThemePackage,
  type ThemePackageEntry,
  type ThemePackageErrorCode,
  type ThemePackageIssue,
  type ThemePackageManifest,
  type ThemePackageRegistry,
  type ThemeRegistryOptions,
  type ThemeLayoutName,
  THEME_LAYOUT_NAMES,
  MAX_THEME_PARENT_DEPTH,
  MAX_TEMPLATE_DEPTH,
  MAX_TEMPLATE_NODES,
  MAX_TEMPLATE_TEXT,
  THEME_TEMPLATE_ATTRIBUTES,
  THEME_TEMPLATE_TAGS,
  ThemeTemplateError,
  parseThemeTemplate,
  renderThemeTemplate,
  type ThemeTemplate,
  type ThemeTemplateAttribute,
  type ThemeTemplateElement,
  type ThemeTemplateNode,
  type ThemeTemplateSlot,
  type ThemeTemplateTag,
  type ThemeTemplateText,
} from './packages/index.js';

// First-party, built-in theme packages. Validated through discovery at module
// load; these are starter themes shipped in-package, not filesystem-discovered.
export { builtinThemePackages } from './builtin.js';
