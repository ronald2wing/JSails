/**
 * Server-side theme-package filesystem loading (`@jsails/theme/server`):
 * reads a package's declared template, partial, and preview files without
 * executing package code. Server-only — `node:fs`/`node:path` are imported, so
 * this subpath must never be pulled into a client island.
 */

export {
  loadThemePreview,
  loadThemeTemplates,
  ThemeLoaderError,
  type LoadedThemePreview,
  type ThemeLoaderErrorCode,
  type ThemeLoaderIo,
  type ThemeLoaderOptions,
} from './loader.js';
