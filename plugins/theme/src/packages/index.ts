/**
 * Theme packages — public surface.
 *
 * This barrel re-exports the theme package contract from its three slices:
 *
 * - `manifest.ts` — the Zod {@link themePackageManifestSchema}, the typed
 *   manifest model (`ThemePackageManifest`, `ThemePackageIssue`), the
 *   value-free {@link ThemePackageError}, the name/pattern bounds, path
 *   safety (`isSafeRelativePath`), and `parseThemePackageManifest`.
 * - `discovery.ts` — pure discovery over a caller-supplied file listing
 *   (`discoverThemePackages`, `ThemePackage`, `ThemePackageEntry`).
 * - `registry.ts` — activation (`createThemeRegistry`, `ThemePackageRegistry`).
 *
 * This module is browser-safe: it imports nothing from `node:*` and performs
 * no I/O. Discovery receives file contents from a caller, so the filesystem
 * stays out of this graph.
 */

export {
  parseThemePackageManifest,
  themePackageManifestSchema,
  isSafeRelativePath,
  ThemePackageError,
  THEME_NAME_PATTERN,
  type ThemePackageManifest,
  type ThemeLayoutName,
  THEME_LAYOUT_NAMES,
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
  MAX_THEME_PARENT_DEPTH,
} from './registry.js';

export {
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
} from './template.js';

export type { ThemeTokenMap } from '../tokens.js';
