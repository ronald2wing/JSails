/**
 * Build the `.jsails/index.json` code index from the authoring tree.
 *
 * The scan reuses the existing discovery functions rather than reimplementing
 * them: `discoverRoutes` for routes, `scanProjectMeta` for models and
 * components, and `scanAutoload` for the symbol table. The index is a
 * projection of their output, so it cannot drift from what the runtime sees.
 *
 * Routes are discovered from the **source** tree (`pages/`, `api/`), not the
 * compiled one. `discoverRoutes` is lexical — it maps file paths to route
 * patterns without importing — so the same function serves both, and the
 * source tree is the one that exists at `build:meta` time.
 */

import { relative } from 'node:path';

import { discoverRoutes } from '../routing/routes.js';
import { SOURCE_EXTENSIONS } from '../compiler/conventions.js';
import { scanProjectMeta, type ProjectMeta } from './meta-scan.js';
import {
  scanAutoload,
  type AutoloadEntry,
  type AutoloadRegistry,
} from '../compiler/project-symbols-scan.js';
import { buildMetaManifest } from './meta-manifest.js';
import {
  CODE_INDEX_VERSION,
  type CodeIndex,
  type IndexedComponent,
  type IndexedField,
  type IndexedModel,
  type IndexedModule,
  type IndexedRoute,
} from './code-index.js';
import type { ExtractedField } from '../compiler/model-extract.js';

/** Options for {@link buildCodeIndex}. */
export interface BuildCodeIndexOptions {
  /** The pages directory, relative to the root. Defaults to `pages`. */
  readonly pagesDir?: string;
  /** The API directory, relative to the root. Defaults to `api`. */
  readonly apiDir?: string;
}

/**
 * Build the index for the tree under `rootDir`. The fingerprint comes from the
 * manifest built over the same tree, so the two always agree.
 */
export async function buildCodeIndex(
  rootDir: string,
  options: BuildCodeIndexOptions = {},
): Promise<CodeIndex> {
  const meta = await scanProjectMeta(rootDir);
  const autoload = await scanAutoload(rootDir);
  return buildCodeIndexFromMeta(meta, rootDir, { ...options, autoload });
}

/**
 * Project an already-completed scan into the index. `buildMetaArtifacts` has
 * the scan result in hand, so it uses this rather than scanning a second time.
 * The autoload table is part of `ProjectMeta`, so it is read from there unless
 * a caller passes a different one.
 */
export function buildCodeIndexFromMeta(
  meta: ProjectMeta,
  rootDir: string,
  options: BuildCodeIndexOptions & { readonly autoload?: AutoloadRegistry } = {},
): CodeIndex {
  const manifest = buildMetaManifest(rootDir);
  const autoload = options.autoload ?? meta.autoload;
  const routes = discoverRoutes(rootDir, {
    pagesDir: options.pagesDir,
    apiDir: options.apiDir,
    extensions: SOURCE_EXTENSIONS,
  });

  return Object.freeze({
    version: CODE_INDEX_VERSION,
    fingerprint: manifest.fingerprint,
    routes: routes.entries.map((entry) => indexRoute(entry, rootDir)),
    models: meta.models.map(indexModel),
    components: meta.components.map(indexComponent),
    modules: autoload.entries.map(indexModule),
  });
}

function indexRoute(
  entry: ReturnType<typeof discoverRoutes>['entries'][number],
  rootDir: string,
): IndexedRoute {
  return {
    kind: entry.kind,
    route: entry.route,
    dynamic: entry.dynamic,
    catchAll: entry.catchAll,
    optionalCatchAll: entry.optionalCatchAll === true,
    params: entry.params,
    file: toPosix(relative(rootDir, entry.file)),
    layoutCount: entry.layouts?.length ?? 0,
  };
}

function indexModel(
  model: ReturnType<typeof scanProjectMeta> extends Promise<infer M>
    ? M extends { models: readonly (infer X)[] }
      ? X
      : never
    : never,
): IndexedModel {
  return {
    className: model.className,
    tableName: model.tableName,
    ...(model.renamedFrom === undefined ? {} : { renamedFrom: model.renamedFrom }),
    fields: model.fields.map(indexField),
    encrypted: model.encrypted,
  };
}

function indexField(field: ExtractedField): IndexedField {
  if (field.field === 'column') {
    return {
      field: 'column',
      name: field.name,
      kind: field.kind,
      ...(field.nullable === undefined ? {} : { nullable: field.nullable }),
      ...(field.unique === undefined ? {} : { unique: field.unique }),
    };
  }
  return {
    field: 'relation',
    name: field.name,
    kind: field.kind,
    target: field.target,
    owning: field.owning,
  };
}

function indexComponent(component: { exportName: string; relative: string }): IndexedComponent {
  return { exportName: component.exportName, relative: toPosix(component.relative) };
}

function indexModule(entry: AutoloadEntry): IndexedModule {
  return {
    relative: toPosix(entry.relative),
    context: entry.context,
    autoloadable: entry.autoloadable,
    symbols: entry.symbols.map((symbol) => ({ name: symbol.name, context: symbol.context })),
  };
}

/** Normalize a path to forward slashes so the index is portable. */
function toPosix(path: string): string {
  return path.split('\\').join('/');
}
