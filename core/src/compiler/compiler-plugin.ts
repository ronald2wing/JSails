/**
 * The component-source Vite/Rolldown plugin: a thin `transform` wrapper over the
 * pure region extractor and shape-aware emitter.
 *
 * Two authoring hosts are supported:
 * - `.tsx` / `.mtsx` with `// #region` markers (the region dialect), lowered by
 *   `extractRegions` + `emitComponent`.
 * - `.jsails` single-file components (`<template>`/`<script>`/`<style>`/
 *   `<server>`), lowered by `emitSfc`. The `<style>` body is served as a
 *   virtual CSS module (`<file>.jsails?jsails&type=style&lang.css`) that the
 *   emitted module imports, so the bundler's own CSS pipeline (and Tailwind)
 *   processes it. The `<server>` block is stubbed in a client build.
 *
 * Construction is inert and bundler-agnostic: the returned object is
 * structurally compatible with any bundler exposing an `enforce`/`transform`
 * hook pair, and imports no bundler code. It runs `enforce: 'pre'` so component
 * syntax is lowered before any other transform sees the source.
 *
 * Composition order: `compilerPlugin` → `serverDirectivePlugin` →
 * `cleanBundlePlugin`. The compiler runs first so it lowers `js-*` directives
 * and reassembles regions before `serverDirectivePlugin` strips `'use server'`
 * bodies; `cleanBundlePlugin` is the final assertion that a `*.server.ts` module
 * never reaches a client chunk.
 *
 * The plugin is OFF by default — it is not wired into `createApplication` or any
 * default build. A project opts in by adding it to its bundler config.
 */

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';

import { emitComponent } from './emit.js';
import { CompilerBuildError, CompilerError, type CompileDiagnostic } from './errors.js';
import { loadAutoloadRegistry } from './project-symbols-plugin.js';
import { extractRegions } from './regions.js';
import { parseSfc } from './sfc.js';
import { emitSfc } from './sfc-emit.js';

/** Options for {@link compilerPlugin}. */
export interface CompilerPluginOptions {
  /**
   * Extensions the transform applies to. Defaults to the region component
   * extensions (`.tsx`, `.mtsx`); single-file components (`.jsails`) are always
   * handled. A plain `.ts`/`.js` module is never a component source and is
   * passed through untouched.
   */
  readonly include?: readonly string[];
  /**
   * Project root, used to resolve capitalized template tags to
   * `app/components/` modules. Defaults to `process.cwd()`.
   */
  readonly rootDir?: string;
  /**
   * When `true`, this is a server build: a `.jsails` `<server>` block is kept
   * verbatim. Defaults to `false`, so a client build stubs the block (a Vite SSR
   * transform, `options.ssr`, also keeps it).
   */
  readonly server?: boolean;
}

/** The subset of the bundler's output options the source-map guard reads. */
export interface CompilerOutputOptions {
  readonly sourcemap?: boolean | 'inline' | 'hidden' | null;
  readonly sourcemapExcludeSources?: boolean | null;
}

/** The plugin-context members the hooks use when a bundler supplies them. */
interface PluginContextLike {
  readonly warn?: (message: string) => void;
  readonly addWatchFile?: (id: string) => void;
  readonly resolve?: (
    source: string,
    importer?: string,
    options?: { readonly skipSelf?: boolean },
  ) => Promise<{ readonly id: string } | null>;
}

const DEFAULT_INCLUDE = Object.freeze(['.tsx', '.mtsx']);

/** The extension that marks a single-file component. */
const SFC_EXTENSION = '.jsails';

/**
 * The virtual extension a `.jsails` file is published under. Rolldown/Vite pick
 * their parser language from the module id extension, so an id that still ends
 * in `.jsails` is parsed as plain JS and the emitted TSX fails with a JSX parse
 * error. Renaming to `.jsails.tsx` makes the emitted TSX parse correctly while
 * keeping the component's own identity (`sfcSourceId` strips the suffix).
 */
const SFC_VIRTUAL_EXTENSION = '.jsails.tsx';

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

/**
 * The query that marks a `.jsails` file's `<style>` block as a virtual CSS
 * module. It ends in `lang.css` so the bundler's CSS request test matches it.
 */
const SFC_STYLE_QUERY = '?jsails&type=style&lang.css';

/** True when `id` is the virtual id our `.jsails` resolver publishes. */
function isSfc(id: string): boolean {
  return (id.split('?')[0] ?? id).endsWith(SFC_VIRTUAL_EXTENSION);
}

/** True when `id` is the virtual CSS module of a `.jsails` `<style>` block. */
function isSfcStyle(id: string): boolean {
  return (
    id.endsWith(SFC_STYLE_QUERY) && id.slice(0, -SFC_STYLE_QUERY.length).endsWith(SFC_EXTENSION)
  );
}

/** A specifier written relative to (or absolute on) the filesystem, not a package. */
function isPathSpecifier(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../') || isAbsolute(source);
}

/** The bundler plugin context, when the hook was invoked with one. */
function contextOf(self: unknown): PluginContextLike | undefined {
  return typeof self === 'object' && self !== null ? self : undefined;
}

/** The real `.jsails` path behind a virtual `.jsails.tsx` id. */
function sfcSourceId(id: string): string {
  return (id.split('?')[0] ?? id).slice(0, -'.tsx'.length);
}

/** The component name derived from a module id: the basename without its extensions. */
function componentName(id: string): string {
  const clean = id.split('?')[0] ?? id;
  const base = clean.split('/').pop() ?? clean;
  if (base.endsWith(SFC_VIRTUAL_EXTENSION)) {
    return base.slice(0, -SFC_VIRTUAL_EXTENSION.length);
  }
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** The directory of a module id, for relative component import specifiers. */
function moduleDir(id: string): string {
  const clean = id.split('?')[0] ?? id;
  const slash = clean.lastIndexOf('/');
  return slash > 0 ? clean.slice(0, slash) : '.';
}

/**
 * Whether the view region has anything the compiler must lower: a `<template>`
 * block (the Vue-like dialect), a `js-*` directive, or a capitalized JSX tag (a
 * component reference). A view with none of these is already valid TSX and is
 * passed through untouched.
 *
 * The tag check requires the `<` to be preceded by a non-identifier character
 * so a generic type argument (`defineComponent<TaskListState>`) is not mistaken
 * for a JSX tag.
 */
function needsLowering(view: string): boolean {
  // A `<template>` block is the Vue-like dialect: never valid TSX on its own, so
  // it must always be lowered even when it carries no `js-*` directive and no
  // capitalized tag. Detection is a leading check (the block is the dialect only
  // as the first non-whitespace content), matching `lowerTemplateRegion`.
  if (view.replace(/^\s+/, '').startsWith('<template>')) {
    return true;
  }
  return view.includes('js-') || /(?:^|[^A-Za-z0-9_$])<[A-Z]/.test(view);
}

/**
 * Render a diagnostic list into a value-free build-log string.
 *
 * `message` and `code` are compiler-authored (never source text); `frame` is the
 * one sanctioned source-text exception, rendered from the author's in-memory
 * source at compile time (see {@link CompileDiagnostic}). `id` is the module id,
 * a path, not source.
 */
export function formatDiagnostics(id: string, diagnostics: readonly CompileDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const { line, column } = diagnostic.range.start;
      const head = `${id}:${line}:${column}: ${diagnostic.severity}[${diagnostic.code}]: ${diagnostic.message}`;
      return diagnostic.frame.length > 0 ? `${head}\n${diagnostic.frame}` : head;
    })
    .join('\n\n');
}

/**
 * Decide what a bundler should do with a component's diagnostics.
 *
 * Error-severity diagnostics abort the build: throw a {@link CompilerBuildError}
 * carrying the first error's `.loc`, a message with every rendered frame, and the
 * structured `.diagnostics` list. Warnings-only return normally, surfaced through
 * the bundler's own `warn` hook when it exposes one. Returns `void` — callers
 * proceed to emit only when this does not throw.
 */
export function surfaceDiagnostics(
  id: string,
  diagnostics: readonly CompileDiagnostic[],
  warn?: (message: string) => void,
): void {
  if (diagnostics.length === 0) {
    return;
  }
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new CompilerBuildError(id, errors, formatDiagnostics(id, errors));
  }
  warn?.(formatDiagnostics(id, diagnostics));
}

/**
 * Build the plugin.
 *
 * `.jsails` resolution: `resolveId` rewrites a `*.jsails` specifier to an
 * absolute virtual `*.jsails.tsx` id (resolved against the importer, so two
 * same-named components in different directories stay distinct), and `load`
 * reads the real file for it and registers that file for watching. This is
 * required because Rolldown/Vite choose the parser language from the module id
 * extension — a module that still ends in `.jsails` is parsed as plain JS and
 * the emitted TSX fails with a JSX parse error. The `transform` hook then
 * compiles that virtual module.
 *
 * The region dialect always emits the single-module shape: splitting a
 * component into files is the `convert` command's job, and a bundler transform
 * returns exactly one module.
 *
 * `transform` returns `null` when the file is not a component source or when the
 * emitted entry is byte-identical to the input, so the bundler skips its own
 * re-parse; otherwise it returns the rewritten code. Error-severity diagnostics
 * abort the build with a positioned {@link CompilerBuildError}; warnings ride the
 * bundler's `warn` hook when available.
 *
 * `renderStart` refuses a client build that emits source maps with embedded
 * sources after compiling a `.jsails` file with a `<server>` block: the bundler
 * embeds each module's loaded text, which is the whole `.jsails` file. That
 * set of files survives `buildStart`, because a watch rebuild reuses the cached
 * transform of an unchanged component; a file leaves it only when a client
 * transform of it finds no `<server>` block.
 */
export function compilerPlugin(options: CompilerPluginOptions = {}): {
  name: string;
  enforce: 'pre';
  buildStart(): Promise<void>;
  resolveId(source: string, importer?: string): Promise<string | null>;
  load(id: string): Promise<string | null>;
  transform(
    code: string,
    id: string,
    transformOptions?: { readonly ssr?: boolean },
  ): { code: string; map: object | null } | null;
  renderStart(outputOptions: CompilerOutputOptions): void;
} {
  const include = options.include ?? DEFAULT_INCLUDE;
  const rootDir = options.rootDir ?? process.cwd();
  const serverBuild = options.server === true;
  const serverBlocks = new Set<string>();
  let autoloaded: ReadonlySet<string> | undefined;
  const isProvided = (tag: string): boolean => autoloaded?.has(tag) === true;

  return {
    name: 'jsails-component-compiler',
    enforce: 'pre',

    async buildStart() {
      // A tag the autoload pass injects (a `ui/` component) is not an
      // `app/components/` module; knowing the registry keeps it from being
      // reported as unresolved.
      const registry = await loadAutoloadRegistry(rootDir);
      autoloaded = new Set(
        [...registry].filter(([, contexts]) => contexts.has('app')).map(([name]) => name),
      );
    },

    async resolveId(source, importer) {
      if (isSfcStyle(source)) {
        return source;
      }
      const query = source.includes('?') ? source.slice(source.indexOf('?')) : '';
      const clean = source.slice(0, source.length - query.length);
      if (!clean.endsWith(SFC_EXTENSION)) {
        return null;
      }
      if (isPathSpecifier(clean)) {
        const base = importer === undefined ? rootDir : dirname(importer.split('?')[0] ?? importer);
        return `${resolvePath(base, clean)}${'.tsx'}${query}`;
      }
      // A package specifier: let the bundler's resolver find the real file.
      const resolved = await contextOf(this)?.resolve?.(source, importer, { skipSelf: true });
      if (resolved === null || resolved === undefined) {
        return null;
      }
      const resolvedClean = resolved.id.split('?')[0] ?? resolved.id;
      return resolvedClean.endsWith(SFC_EXTENSION) ? `${resolvedClean}${'.tsx'}${query}` : null;
    },

    async load(id) {
      if (isSfcStyle(id)) {
        const file = id.slice(0, -SFC_STYLE_QUERY.length);
        contextOf(this)?.addWatchFile?.(file);
        return parseSfc(await readFile(file, 'utf-8'), file).style;
      }
      if (!isSfc(id)) {
        return null;
      }
      const file = sfcSourceId(id);
      contextOf(this)?.addWatchFile?.(file);
      return readFile(file, 'utf-8');
    },

    transform(code, id, transformOptions) {
      // A bundler invokes `transform` with a plugin context as `this`; a test
      // may call it unbound. Read `warn` defensively rather than require it.
      const context = contextOf(this);
      const warn = typeof context?.warn === 'function' ? context.warn.bind(context) : undefined;

      if (isSfc(id)) {
        const keepServer = serverBuild || transformOptions?.ssr === true;
        const file = sfcSourceId(id);
        const result = transformSfc(code, file, rootDir, keepServer, isProvided, warn);
        if (!keepServer) {
          if (result.hadServerBlock) {
            serverBlocks.add(file);
          } else {
            serverBlocks.delete(file);
          }
        }
        return { code: result.code, map: result.map };
      }

      if (!applies(id, include)) {
        return null;
      }

      // Region dialect. Cheap prefilter: a component source always carries
      // region markers, so a file without the substring skips the parse.
      if (!code.includes('#region')) {
        return null;
      }

      let regions;
      try {
        regions = extractRegions(code, id);
      } catch (error) {
        // A `.tsx` file that is not a component is passed through untouched; a
        // malformed component (any other CompilerError) is a build error.
        if (error instanceof CompilerError && error.code === 'missing_region') {
          return null;
        }
        throw error;
      }

      // Nothing to lower: the region markers are plain comments, so a component
      // with no `js-*` directive and no capitalized tag is already valid TSX.
      // Reassembling it would only normalize whitespace, so pass it through.
      if (!needsLowering(regions.view)) {
        return null;
      }

      const emitted = emitComponent({
        name: componentName(id),
        regions,
        shape: 'single',
        resolve: { fromDir: moduleDir(id), rootDir, isProvided },
        source: code,
      });

      surfaceDiagnostics(id, emitted.diagnostics, warn);

      if (emitted.entry === code) {
        return null;
      }
      return { code: emitted.entry, map: emitted.map };
    },

    renderStart(outputOptions) {
      const emitsSources =
        outputOptions.sourcemap !== undefined &&
        outputOptions.sourcemap !== null &&
        outputOptions.sourcemap !== false &&
        outputOptions.sourcemapExcludeSources !== true;
      if (!emitsSources || serverBlocks.size === 0) {
        return;
      }
      throw new CompilerError(
        'unsupported_sourcemap',
        `client source maps would embed the <server> block of ${serverBlocks.size} .jsails component(s); disable build.sourcemap or set sourcemapExcludeSources for the client build`,
      );
    },
  };
}

/**
 * Lower a `.jsails` single-file component. A non-empty `<style>` body becomes an
 * import of the component's virtual CSS module, so the bundler's CSS pipeline
 * owns it. Error-severity diagnostics abort the build (see
 * {@link surfaceDiagnostics}).
 */
function transformSfc(
  code: string,
  id: string,
  rootDir: string,
  keepServer: boolean,
  isProvided: (tag: string) => boolean,
  warn?: (message: string) => void,
): { code: string; map: object | null; hadServerBlock: boolean } {
  const emitted = emitSfc(code, id, {
    name: componentName(id),
    fromDir: moduleDir(id),
    rootDir,
    serverBlock: keepServer ? 'keep' : 'stub',
    isProvided,
  });

  surfaceDiagnostics(id, emitted.diagnostics, warn);

  const hadServerBlock = emitted.hadServerBlock;
  if (emitted.css.length === 0) {
    return { code: emitted.code, map: emitted.map, hadServerBlock };
  }
  // Appended, not prepended: imports hoist, and appending keeps every mapped
  // line of the emitted module where the source map says it is.
  const styleImport = `import ${JSON.stringify(`${id}${SFC_STYLE_QUERY}`)};\n`;
  return { code: `${emitted.code}${styleImport}`, map: emitted.map, hadServerBlock };
}
