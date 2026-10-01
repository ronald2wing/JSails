/**
 * The `jsails/build` bundler-integration surface: the Vite plugins a starter
 * wires into `vite.config`, plus the guards and transforms they enforce.
 *
 * - `cleanBundlePlugin` — a `generateBundle` hook asserting no server-only
 *   module reached the browser bundle.
 * - `serverDirectivePlugin` — a `transform` hook stubbing `'use server'`
 *   functions in a client chunk.
 * - `autoloadPlugin` — the compiler's auto-import Vite plugin, re-exported
 *   here so a `vite.config` imports the whole plugin set from one subpath.
 *
 * Importing this barrel is inert — nothing is bundled and no bundler code is
 * loaded; the plugins only run when a build tool invokes their hooks.
 */

export {
  CleanBundleError,
  assertCleanClientBundle,
  cleanBundlePlugin,
  findServerOnlyModules,
  isServerOnlyModuleId,
  type CleanBundleErrorCode,
  type CleanBundlePluginOptions,
  type CleanBundleViolation,
  type ClientBundleChunk,
} from './clean-bundle-check.js';

export {
  ServerDirectiveError,
  stripServerDirectives,
  stubServerOnlyModule,
  type ServerDirectiveErrorCode,
  type ServerDirectiveResult,
  type ServerDirectiveSourceMap,
} from './server-directive.js';

export {
  serverDirectivePlugin,
  type ServerDirectiveOutputOptions,
  type ServerDirectivePluginOptions,
} from './server-directive-plugin.js';

export { autoloadPlugin, type AutoloadPluginOptions } from '../compiler/project-symbols-plugin.js';

export {
  DEFAULT_SCOPED_AUTO_IMPORTS,
  ScopedAutoImportError,
  assertNoOutOfScopeAutoImports,
  generateScopedAutoImportsDts,
  injectScopedAutoImports,
  injectScopedAutoImportsInDirectory,
  type InjectScopedAutoImportsOptions,
  type ScopedAutoImportInjection,
  type ScopedAutoImportRule,
} from '../compiler/scoped-auto-imports.js';

export {
  MetaScanError,
  assertNoMetaErrors,
  formatMetaDiagnostic,
  scanProjectMeta,
  type ComponentModule,
  type ProjectMeta,
  type ProjectMetaDiagnostic,
  type ScanProjectMetaOptions,
} from './meta-scan.js';

export {
  META_DIR,
  buildMetaArtifacts,
  emitAutoloadJson,
  emitComponentsRegistry,
  emitModelsRegistry,
  writeMetaArtifacts,
  type MetaArtifacts,
} from './generate-meta.js';
