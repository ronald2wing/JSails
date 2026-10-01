/**
 * Theme package (`@jsails/theme`): the cross-surface CSS-custom-property
 * contract shared by the admin renderer, the generated starter, and plugin
 * authors.
 *
 * Import from `@jsails/theme` for a browser-safe entry: no `node:*` imports,
 * no ORM, no HTTP. The admin renderer reads the resolved tokens through
 * {@link themeToken} (an optional service), the starter layout emits them
 * through {@link themeTokensToCss} (which includes per-theme `[data-theme]`
 * blocks), and plugins contribute through {@link PluginDescription.theme}.
 */

export {
  coreThemeTokenNames,
  deriveThemeTokens,
  resolveThemeTokens,
  themeTokensToCss,
  ThemeTokenError,
  type ThemeContribution,
  type ThemeResolution,
  type ThemeSeed,
  type ThemeTokenErrorCode,
  type ThemeTokenMap,
} from './tokens.js';

export { themePlugin, themeToken, type ThemePluginOptions } from './plugin.js';

// `plugins.use` resolves a specifier by importing the default export and
// calling it with the options tuple.
export { themePlugin as default } from './plugin.js';

export {
  createThemeRegistry,
  discoverThemePackages,
  parseThemePackageManifest,
  ThemePackageError,
  ThemeTemplateError,
  parseThemeTemplate,
  renderThemeTemplate,
  type DiscoverThemePackagesOptions,
  type ThemeLayoutName,
  type ThemePackage,
  type ThemePackageEntry,
  type ThemePackageErrorCode,
  type ThemePackageIssue,
  type ThemePackageManifest,
  type ThemePackageRegistry,
  type ThemeRegistryOptions,
  type ThemeTemplate,
  type ThemeTemplateAttribute,
  type ThemeTemplateElement,
  type ThemeTemplateErrorCode,
  type ThemeTemplateNode,
  type ThemeTemplateSlot,
  type ThemeTemplateTag,
  type ThemeTemplateText,
} from './packages/index.js';

export { builtinThemePackages, DEFAULT_BUILTIN_THEME_NAME } from './builtin.js';
