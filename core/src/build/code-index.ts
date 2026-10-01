/**
 * The `.jsails/index.json` code index: one source-derived description of the
 * app, written by `jsails build:meta` and read by every introspection surface.
 *
 * Before this, three consumers each re-scanned the same tree: the MCP server
 * (`mcp/builtin-tools.ts`), the `describe` CLI command, and the compiler's
 * symbol plugin. They agreed only by accident — each had its own walk, its own
 * filters, and its own idea of what a route or a model is. The index makes the
 * scan happen once, at build time, and makes every consumer read the same
 * answer.
 *
 * ## What is in it
 *
 * Only facts derivable from source without importing a module: routes, models,
 * server components, and the autoload symbol table. Plugin enablement, command
 * descriptors, and config keys need the resolved app config (a module import),
 * so they are not here — a consumer that needs them still loads the config.
 *
 * ## Staleness
 *
 * The index carries the fingerprint from `manifest.json` (see
 * `meta-manifest.ts`). A consumer verifies the manifest before trusting the
 * index, so a stale index is a hard error rather than a silently wrong answer.
 * The index does not carry its own fingerprint: one authority, one check.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JsailsError } from '../errors/jsails-error.js';
import { META_MANIFEST_FILE, verifyMetaManifest } from './meta-manifest.js';

/** The artifact file name, relative to `.jsails/`. */
export const CODE_INDEX_FILE = 'index.json';

/** Schema version of the index. Bumping it invalidates every existing one. */
export const CODE_INDEX_VERSION = 1;

/** A page or API route, as the index records it. */
export interface IndexedRoute {
  readonly kind: 'page' | 'api';
  readonly route: string;
  readonly dynamic: boolean;
  readonly catchAll: boolean;
  readonly optionalCatchAll: boolean;
  readonly params: readonly string[];
  /** Project-relative source path. */
  readonly file: string;
  /** Number of layout modules wrapping the route. */
  readonly layoutCount: number;
}

/** A model, as the index records it. */
export interface IndexedModel {
  readonly className: string;
  readonly tableName: string;
  readonly renamedFrom?: string;
  readonly fields: readonly IndexedField[];
  readonly encrypted: readonly string[];
}

/** A model field: a column or a relation. */
export interface IndexedField {
  readonly field: 'column' | 'relation';
  readonly name: string;
  readonly kind: string;
  readonly nullable?: boolean;
  readonly unique?: boolean;
  readonly target?: string;
  readonly owning?: boolean;
}

/** A server component, as the index records it. */
export interface IndexedComponent {
  readonly exportName: string;
  /** Project-relative source path. */
  readonly relative: string;
}

/** A symbol a module exports for autoloading. */
export interface IndexedSymbol {
  readonly name: string;
  /** The injection namespace the symbol belongs to (`app` or `server`). */
  readonly context: string;
}

/** A module that contributes autoloadable symbols. */
export interface IndexedModule {
  readonly relative: string;
  readonly context: string;
  readonly autoloadable: boolean;
  readonly symbols: readonly IndexedSymbol[];
}

/** The parsed `.jsails/index.json`. */
export interface CodeIndex {
  readonly version: number;
  /** The manifest fingerprint this index was built against. */
  readonly fingerprint: string;
  readonly routes: readonly IndexedRoute[];
  readonly models: readonly IndexedModel[];
  readonly components: readonly IndexedComponent[];
  readonly modules: readonly IndexedModule[];
}

/** An index failure. Value-free: paths are project-relative. */
export class CodeIndexError extends JsailsError {
  constructor(
    readonly code: 'missing_index' | 'invalid_index' | 'stale_index',
    message: string,
    options?: { readonly suggestion?: string },
  ) {
    super(message, options);
  }
}

/** Serialize an index as the artifact's JSON text. */
export function emitCodeIndex(index: CodeIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/**
 * Parse the artifact text. A malformed document or a wrong version is
 * `invalid_index` — the file was written by something other than this build
 * step.
 */
export function parseCodeIndex(raw: string): CodeIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CodeIndexError('invalid_index', 'the .jsails code index is not valid JSON', {
      suggestion: 'run "jsails build:meta" to regenerate it',
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CodeIndexError('invalid_index', 'the .jsails code index is not an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== CODE_INDEX_VERSION) {
    throw new CodeIndexError(
      'invalid_index',
      `the .jsails code index has version ${String(record.version)}, expected ${CODE_INDEX_VERSION}`,
      { suggestion: 'run "jsails build:meta" to regenerate it' },
    );
  }
  if (
    typeof record.fingerprint !== 'string' ||
    !Array.isArray(record.routes) ||
    !Array.isArray(record.models) ||
    !Array.isArray(record.components) ||
    !Array.isArray(record.modules)
  ) {
    throw new CodeIndexError('invalid_index', 'the .jsails code index is missing a section');
  }
  return Object.freeze({
    version: CODE_INDEX_VERSION,
    fingerprint: record.fingerprint,
    routes: record.routes as readonly IndexedRoute[],
    models: record.models as readonly IndexedModel[],
    components: record.components as readonly IndexedComponent[],
    modules: record.modules as readonly IndexedModule[],
  });
}

/**
 * Read and verify the index for the tree under `rootDir`. The manifest is
 * checked first, so a stale index is reported as `stale_index` rather than
 * returned as a wrong answer.
 */
export function readCodeIndex(rootDir: string): CodeIndex {
  let raw: string;
  try {
    raw = readFileSync(join(rootDir, '.jsails', CODE_INDEX_FILE), 'utf8');
  } catch {
    throw new CodeIndexError('missing_index', 'the .jsails code index is missing', {
      suggestion: 'run "jsails build:meta" to generate it',
    });
  }
  const index = parseCodeIndex(raw);
  let manifestFingerprint: string;
  try {
    manifestFingerprint = verifyMetaManifest(rootDir).fingerprint;
  } catch {
    throw new CodeIndexError(
      'stale_index',
      'the .jsails code index no longer matches the source tree',
      {
        suggestion: 'run "jsails build:meta" to regenerate it',
      },
    );
  }
  if (index.fingerprint !== manifestFingerprint) {
    throw new CodeIndexError(
      'stale_index',
      'the .jsails code index no longer matches the source tree',
      {
        suggestion: 'run "jsails build:meta" to regenerate it',
      },
    );
  }
  return index;
}

/** Whether an index artifact exists for the tree under `rootDir`. */
export function hasCodeIndex(rootDir: string): boolean {
  try {
    readFileSync(join(rootDir, '.jsails', CODE_INDEX_FILE), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** The manifest file name, re-exported so a consumer need not import two modules. */
export { META_MANIFEST_FILE };
