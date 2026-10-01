/**
 * Theme packages: manifest validation, pure discovery, activation, and
 * declarative templates.
 *
 * This module is browser-safe: it imports nothing from `node:*` and performs
 * no I/O. Discovery receives manifest contents from a caller, so the
 * filesystem stays out of this graph.
 */

export {
  parseThemePackageManifest,
  ThemePackageError,
  type ThemePackageManifest,
  type ThemeLayoutName,
  type ThemePackageIssue,
  type ThemePackageErrorCode,
} from './manifest.js';

export {
  discoverThemePackages,
  type ThemePackage,
  type ThemePackageEntry,
  type DiscoverThemePackagesOptions,
} from './discovery.js';

export {
  createThemeRegistry,
  type ThemePackageRegistry,
  type ThemeRegistryOptions,
} from './registry.js';

export {
  ThemeTemplateError,
  parseThemeTemplate,
  renderThemeTemplate,
  type ThemeTemplate,
  type ThemeTemplateAttribute,
  type ThemeTemplateElement,
  type ThemeTemplateErrorCode,
  type ThemeTemplateNode,
  type ThemeTemplateSlot,
  type ThemeTemplateTag,
  type ThemeTemplateText,
} from './template.js';
