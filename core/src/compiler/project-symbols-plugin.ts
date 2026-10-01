/**
 * The jsails-autoload Vite/Rolldown plugin: a `buildStart` / `transform`
 * pipeline that injects import declarations into transformed modules from a
 * precomputed autoload registry.
 *
 * The registry is produced by the standalone `jsails build:meta` step, which
 * walks the authoring tree once and writes `.jsails/autoload.json` (alongside
 * the ambient `.jsails/project-symbols.*.d.ts` declarations that feed `tsc`). This
 * plugin is a **consumer** of that artifact: `buildStart` reads and parses the
 * JSON once, and `transform` only consults the cached symbol index.
 *
 * Standalone fallback: when the artifact is absent — a bare Vite build with no
 * preceding `build:meta` — `buildStart` falls back to a source-level
 * {@link scanAutoload} so the exported plugin still works on its own. A present
 * but malformed artifact is **not** silently ignored; it throws a value-free
 * {@link AutoloadError}, because a corrupt generated file is a build bug.
 *
 * Watch mode: `jsails dev` runs `build:meta` once and then `vite build
 * --watch`, so the first source edit leaves `.jsails/` describing the old
 * tree. In watch mode (`this.meta.watchMode`) a stale artifact is regenerated
 * in place — the same scan and write `build:meta` performs — instead of failing
 * the rebuild. A one-shot build keeps the strict check.
 *
 * Construction is inert: no files are read and no directories are walked until
 * the build hooks fire.
 *
 * Each module is parsed at most once: a cheap text test against the symbol
 * index skips modules that name no candidate, and the one parse feeds both the
 * registry and the scoped auto-import passes. Imports are appended after the
 * last line, so no original line moves and the returned map is exact.
 *
 * Mirror {@link serverDirectivePlugin} in shape (enforce: 'pre', CSS_QUERY
 * guard, applies() gating, null-on-skip) so the two transforms compose safely.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';

import { relativePathInside } from '../support/path-containment.server.js';
import { AUTOLOAD_DIRECTORIES } from './conventions.js';

import {
  AutoloadError,
  parseAutoloadJson,
  scanAutoload,
  type AutoloadContext,
  type AutoloadSymbolIndex,
} from './project-symbols-scan.js';
import {
  injectAutoloadImports,
  parseForInjection,
  type AutoloadInjectionResult,
  type AutoloadInjectionSourceMap,
} from './project-symbols-imports.js';
import { collectUnmatchedIdentifiers } from './scope-walker.js';
import {
  DEFAULT_SCOPED_AUTO_IMPORTS,
  assertNoOutOfScopeAutoImports,
  injectScopedAutoImports,
  type ScopedAutoImportRule,
} from './scoped-auto-imports.js';
import { isErrno } from '../errors/inspect.js';
import { MetaManifestError, verifyMetaManifest } from '../build/meta-manifest.js';
import { scanProjectMeta } from '../build/meta-scan.js';
import { writeMetaArtifacts } from '../build/generate-meta.js';
import { toPosixId } from '../support/project-paths.server.js';

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

export interface AutoloadPluginOptions {
  /** Project root directory. Defaults to `process.cwd()`. */
  readonly rootDir?: string;
  /**
   * Extensions the transform applies to. Defaults to the TypeScript/JSX set
   * the authoring surface uses (`.ts`, `.tsx`, `.mts`, `.mtsx`, `.jsx`, `.js`).
   */
  readonly include?: readonly string[];
  /**
   * When `true`, every module is server-context (seeing `server` symbols, and
   * `app` symbols where no server symbol has the name). Defaults to `false`,
   * which selects the context from the module's first path segment *relative to
   * `rootDir`*, using the autoload directory table (`server/`, `models/`,
   * `jobs/`, … are `'server'`; `app/`, `ui/`, `shared/` and anything else are
   * `'app'`). Where the checkout itself lives never matters.
   */
  readonly server?: boolean;
  /**
   * Directory-scoped auto-import rules. Defaults to the built-in UI rule:
   * `ui/**` and `client/**` receive Preact hooks/signals. Pass an empty array
   * to disable scoped injection in this plugin.
   */
  readonly scopedAutoImports?: readonly ScopedAutoImportRule[];
}

const DEFAULT_INCLUDE = Object.freeze(['.ts', '.tsx', '.mts', '.mtsx', '.jsx', '.js']);

/** The synthetic id Vite passes for CSS/asset requests that must never be parsed. */
const CSS_QUERY = /\.(css|scss|sass|less|styl)(\?|$)/i;

/** True when `id` (a Vite module id, possibly with a query) matches one of the extensions. */
function applies(id: string, include: readonly string[]): boolean {
  if (CSS_QUERY.test(id)) {
    return false;
  }
  const clean = id.split('?')[0] ?? id;
  return include.some((extension) => clean.endsWith(extension));
}

/* ------------------------------------------------------------------ */
/*  Plugin                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the autoload plugin. `buildStart` reads the precomputed registry once
 * (falling back to a source scan) and caches the symbol index; `transform`
 * injects imports from it.
 */
export function autoloadPlugin(options: AutoloadPluginOptions = {}): {
  name: string;
  enforce: 'pre';
  buildStart(this: unknown): Promise<void>;
  transform(
    code: string,
    id: string,
  ): { code: string; map: AutoloadInjectionSourceMap | null } | null;
} {
  const include = options.include ?? DEFAULT_INCLUDE;
  const rootDir = options.rootDir ?? cwd();
  const forcedServer = options.server === true;
  const scopedRules = options.scopedAutoImports ?? undefined;

  let symbols: AutoloadSymbolIndex | null = null;
  let candidates: RegExp | null = null;
  const scopedNames = (scopedRules ?? DEFAULT_SCOPED_AUTO_IMPORTS).flatMap((rule) =>
    Object.keys(rule.imports),
  );

  return {
    name: 'jsails-autoload',
    enforce: 'pre',

    async buildStart() {
      symbols = await loadAutoloadRegistry(rootDir, { regenerateStale: isWatchMode(this) });
      candidates = null;
    },

    transform(code, id) {
      if (!applies(id, include)) {
        return null;
      }

      const cleanId = id.split('?')[0] ?? id;
      if (cleanId.includes('node_modules') || cleanId.includes('/.jsails/')) {
        return null;
      }

      // A module that names no registry symbol and no scoped name has nothing
      // to inject and nothing to refuse, so it is never parsed.
      candidates ??= candidatePattern([...(symbols?.keys() ?? []), ...scopedNames]);
      if (candidates === null || !candidates.test(code)) {
        return null;
      }

      const program = parseForInjection(cleanId, code);
      const unmatched = collectUnmatchedIdentifiers(program);
      let next = code;
      let map: AutoloadInjectionSourceMap | null = null;
      let remaining: ReadonlySet<string> = unmatched;

      if (symbols !== null) {
        const context: AutoloadContext = forcedServer ? 'server' : contextFor(rootDir, cleanId);
        const result: AutoloadInjectionResult | null = injectAutoloadImports(next, {
          fileName: cleanId,
          symbols,
          context,
          program,
          unmatched,
          placement: 'append',
        });
        if (result !== null) {
          next = result.code;
          map = result.map;
          const injected = new Set(result.injected.map((entry) => entry.symbol));
          remaining = new Set([...unmatched].filter((name) => !injected.has(name)));
        }
      }
      const changed = next !== code;

      const scopedOptions = {
        fileName: cleanId,
        rootDir,
        unmatched: remaining,
        ...(scopedRules === undefined ? {} : { rules: scopedRules }),
      };
      const scoped = injectScopedAutoImports(next, { ...scopedOptions, placement: 'append' });
      if (scoped !== null) {
        // Appended after the last line: the autoload map (or identity) still
        // describes every original line.
        return { code: scoped.code, map };
      }
      // A scoped name used outside its directory would compile but fail at
      // runtime; refuse it before the bundle is emitted.
      assertNoOutOfScopeAutoImports(next, scopedOptions);

      return changed ? { code: next, map } : null;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Context selection                                                  */
/* ------------------------------------------------------------------ */

/**
 * The injection context of a module: the autoload directory table's context
 * for its first path segment relative to `rootDir`, `'app'` for anything else
 * (including a module outside the root).
 */
function contextFor(rootDir: string, fileName: string): AutoloadContext {
  const relative = relativePathInside(rootDir, fileName);
  if (relative === undefined || relative === '') {
    return 'app';
  }
  const first = toPosixId(relative).split('/')[0];
  return AUTOLOAD_DIRECTORIES.find(([directory]) => directory === first)?.[1] ?? 'app';
}

/** Escape a name for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A pattern matching any of `names` as a whole identifier, or `null` when there
 * are no names (nothing can ever be injected).
 */
function candidatePattern(names: readonly string[]): RegExp | null {
  if (names.length === 0) {
    return null;
  }
  const alternatives = [...new Set(names)].map(escapeRegExp).join('|');
  return new RegExp(`(?<![\\w$])(?:${alternatives})(?![\\w$])`);
}

/* ------------------------------------------------------------------ */
/*  Registry loading                                                   */
/* ------------------------------------------------------------------ */

const JSAILS_DIR = '.jsails';
const AUTOLOAD_JSON = 'autoload.json';

/** Options for {@link loadAutoloadRegistry}. */
interface LoadAutoloadRegistryOptions {
  /**
   * Regenerate a stale `.jsails/` in place instead of throwing `stale_meta`.
   * Set in watch mode only, where a source edit after `build:meta` is the
   * normal case; a one-shot build must keep failing on a stale artifact.
   */
  readonly regenerateStale?: boolean;
}

/**
 * True when the bundler context reports a watch build. Rolldown (under Vite's
 * `build --watch` too) sets `this.meta.watchMode`; a context without it is a
 * one-shot build.
 */
function isWatchMode(context: unknown): boolean {
  if (typeof context !== 'object' || context === null) {
    return false;
  }
  const meta = (context as { readonly meta?: unknown }).meta;
  return (
    typeof meta === 'object' &&
    meta !== null &&
    (meta as { readonly watchMode?: unknown }).watchMode === true
  );
}

/**
 * Resolve the symbol index `transform` consumes. The precomputed
 * `.jsails/autoload.json` from `jsails build:meta` is preferred; when it is
 * absent, fall back to a standalone source scan (a bare Vite build).
 *
 * A present artifact is verified against `.jsails/manifest.json` first. A
 * stale artifact is a hard error, never a silent fallback: the transform would
 * otherwise resolve symbols from a tree that no longer exists, and the failure
 * would surface later as a confusing missing-export. With `regenerateStale`
 * (watch mode) the artifacts are rewritten from the current tree instead, so
 * the ambient declarations `tsc --watch` reads follow the edit too.
 */
async function loadAutoloadRegistry(
  rootDir: string,
  options: LoadAutoloadRegistryOptions = {},
): Promise<AutoloadSymbolIndex> {
  const document = readAutoloadDocument(rootDir);
  if (document === null) {
    return (await scanAutoload(rootDir)).byName;
  }
  try {
    verifyMetaManifest(rootDir);
  } catch (error) {
    if (
      options.regenerateStale === true &&
      error instanceof MetaManifestError &&
      error.code === 'stale_meta'
    ) {
      return regenerateMeta(rootDir);
    }
    throw error;
  }
  return parseAutoloadJson(document, rootDir).byName;
}

/**
 * Regenerations in flight, by project root. The compiler and autoload plugins
 * both start a watch rebuild by loading the registry; sharing one regeneration
 * keeps them from scanning and writing `.jsails/` twice, or concurrently.
 */
const regenerating = new Map<string, Promise<AutoloadSymbolIndex>>();

/** Rewrite `.jsails/` from the current tree, as `build:meta` does, and return its registry. */
function regenerateMeta(rootDir: string): Promise<AutoloadSymbolIndex> {
  const pending = regenerating.get(rootDir);
  if (pending !== undefined) {
    return pending;
  }
  const run = (async () => {
    try {
      const meta = await scanProjectMeta(rootDir);
      writeMetaArtifacts(meta, rootDir);
      return meta.autoload.byName;
    } finally {
      regenerating.delete(rootDir);
    }
  })();
  regenerating.set(rootDir, run);
  return run;
}

/**
 * Read and parse `.jsails/autoload.json`, returning the raw document for
 * {@link parseAutoloadJson} to validate. Returns `null` only when the artifact
 * does not exist; a corrupt artifact throws rather than degrading silently.
 */
function readAutoloadDocument(rootDir: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(join(rootDir, JSAILS_DIR, AUTOLOAD_JSON), 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return null; // no `build:meta` ran — the caller falls back to a scan.
    }
    throw new AutoloadError('invalid_registry', `could not read "${AUTOLOAD_JSON}"`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new AutoloadError('invalid_registry', `invalid autoload registry "${AUTOLOAD_JSON}"`);
  }
}

/** True for a filesystem error reporting the file does not exist. */
