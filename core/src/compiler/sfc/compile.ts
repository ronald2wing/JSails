/**
 * `compileSfc`: a lowered `.jsails` file's shadow compiled to the JavaScript
 * module the server imports, with a source map that points straight at the
 * `.jsails` source (sfc-plan §3.1; docs/design/sfc.md §8.2).
 *
 * The text compiled is the shadow TypeScript checks ("check what you ship"):
 * oxc (`rolldown/utils`' `transformSync`) strips the types and lowers JSX to
 * the automatic `jsails/jsx-runtime`, and the map oxc returns (JavaScript to
 * shadow) is composed with the shadow's span table (`column-map.ts`), because
 * rolldown ignores its typed `inputMap` option. Declarations are never
 * requested: a declaration error would discard the JavaScript too, so an
 * author's untyped export must not cost the build its module.
 *
 * Without a bundler, Node cannot load `./card.jsails`; `specifiers: 'node'`
 * rewrites every relative `.jsails` import, re-export and literal dynamic
 * import to the compiled `./card.js`, as Atom segments owned by the original
 * literal, so maps and positions stay exact. The default, `'bundler'`, leaves
 * resolution to the bundler (SFC-10).
 *
 * `target: 'client'` compiles a module for the browser bundle: only an
 * island, and a view an island renders, may be compiled for it (anything
 * else renders on the server only, and reading its module in the browser
 * would ship server code), and the JavaScript is the server target's, byte
 * for byte, so the browser's first render of an island is the render the
 * server sent (hydration parity).
 *
 * oxc reports problems as values, with a message that quotes the source in
 * ANSI colour; only its offset is read. An offset inside author text (a
 * Verbatim or Alias span) is `sfc.compile_error` at that position, any other
 * is `sfc.internal`: the compiler generated code its own transformer refuses.
 * Nothing here throws for author input.
 */

import { parseSync, transformSync } from 'rolldown/utils';

import { composeSourceMap, type RawSourceMap } from './column-map.js';
import { SfcDiagnostics, type SfcDiagnostic } from './diagnostics.js';
import type { SfcLowering } from './lower.js';
import {
  editShadow,
  generatedToOriginal,
  SpanKind,
  type Shadow,
  type ShadowEdit,
} from './segments.js';
import { SourceSpace } from './source-space.js';

/** How relative `.jsails` import specifiers are written in the output. */
export type SfcSpecifierMode =
  /** Left as written: the bundler resolves `.jsails` modules. */
  | 'bundler'
  /** Rewritten to the compiled `.js` sibling, for modules Node loads as written. */
  | 'node';

/** Where a compiled module runs. */
export type SfcTarget = 'server' | 'client';

/** Options of {@link compileSfc}. */
export interface CompileSfcOptions {
  /** Defaults to `'bundler'`. */
  readonly specifiers?: SfcSpecifierMode;
  /** Defaults to `'server'`; `'client'` accepts an island or a view only. */
  readonly target?: SfcTarget;
}

/** The kinds a client bundle may hold: islands, and the views they render. */
const CLIENT_KINDS: ReadonlySet<string> = new Set(['island', 'view']);

interface CompilationBase {
  /** The `.jsails` file's project path. */
  readonly file: string;
  /** The compiled module's project path (`pages/post.jsails` → `pages/post.js`). */
  readonly outputFile: string;
  /** The lowering's diagnostics, then the compilation's. */
  readonly diagnostics: readonly SfcDiagnostic[];
}

/** A compiled `.jsails` module. */
export interface SfcCompiled extends CompilationBase {
  readonly js: string;
  /**
   * The map from `js` to the sources: `file` is the output's basename, and
   * `sources` are URLs relative to the output's directory.
   */
  readonly map: RawSourceMap;
}

/** A `.jsails` file that did not compile; `diagnostics` say why. */
export interface SfcCompileFailure extends CompilationBase {
  readonly js: null;
  readonly map: null;
}

/** The result of {@link compileSfc}. */
export type SfcCompilation = SfcCompiled | SfcCompileFailure;

const JSX_OPTIONS = Object.freeze({ runtime: 'automatic', importSource: 'jsails' } as const);

/**
 * The compiled module's project path: the component's, with `.js`. A folder
 * component is named by its component path, so `pages/about/` compiles to
 * `pages/about.js` like the single file. `x.jsails` beside `x.ts` would
 * collide here, which the project index reports.
 */
export function sfcOutputPath(file: string): string {
  return `${file.replace(/\.jsails$/, '')}.js`;
}

/** Compile `lowering`'s shadow; see the module comment. */
export function compileSfc(lowering: SfcLowering, options: CompileSfcOptions = {}): SfcCompilation {
  const outputFile = sfcOutputPath(lowering.file);
  const failure = (diagnostics: readonly SfcDiagnostic[]): SfcCompileFailure =>
    Object.freeze({ file: lowering.file, outputFile, js: null, map: null, diagnostics });
  if (lowering.shadow === null) {
    return failure(lowering.diagnostics);
  }
  if (options.target === 'client' && !CLIENT_KINDS.has(lowering.kind)) {
    const diagnostics = new SfcDiagnostics(sourcesSpace(lowering.shadow, lowering.file));
    diagnostics.addAll(lowering.diagnostics);
    diagnostics.error(
      'sfc.client_target',
      'Only an island, or a view an island renders, compiles for the browser',
      0,
      0,
    );
    return failure(diagnostics.list());
  }

  const shadow =
    options.specifiers === 'node' ? withCompiledSpecifiers(lowering.shadow) : lowering.shadow;
  const output = transformSync(`${lowering.file}.tsx`, shadow.text, {
    lang: 'tsx',
    jsx: JSX_OPTIONS,
    sourcemap: true,
  });
  if (output.errors.length > 0 || output.map === undefined) {
    const space = sourcesSpace(shadow, lowering.file);
    const diagnostics = new SfcDiagnostics(space);
    diagnostics.addAll(lowering.diagnostics);
    for (const error of output.errors) {
      reportTransformError(diagnostics, shadow, space, positionOf(error));
    }
    if (!diagnostics.hasErrors) {
      diagnostics.error('sfc.internal', 'The compiler produced no source map', 0, 0);
    }
    return failure(diagnostics.list());
  }

  const composed = composeSourceMap(shadow, output.map, { file: basename(outputFile) });
  const map: RawSourceMap = Object.freeze({
    ...composed,
    sources: Object.freeze(
      composed.sources.map((source) => sourceUrl(relativePath(lowering.file, source))),
    ),
  });
  return Object.freeze({
    file: lowering.file,
    outputFile,
    js: output.code,
    map,
    diagnostics: lowering.diagnostics,
  });
}

/** The offset oxc reported, or `undefined` when an error carries none. */
function positionOf(error: Error): number | undefined {
  const pos = (error as Error & { readonly pos?: unknown }).pos;
  return typeof pos === 'number' && Number.isSafeInteger(pos) && pos >= 0 ? pos : undefined;
}

/**
 * The shadow's sources as one offset space, the component's template file
 * first, so a refusal with no source position lands at its start.
 */
function sourcesSpace(shadow: Shadow, file: string): SourceSpace {
  const sources = [...shadow.sources].sort(
    (a, b) => Number(!a.name.endsWith('.jsails')) - Number(!b.name.endsWith('.jsails')),
  );
  return new SourceSpace(
    sources.length === 0
      ? [{ file, text: '' }]
      : sources.map((source) => ({ file: source.name, text: source.text })),
  );
}

function reportTransformError(
  diagnostics: SfcDiagnostics,
  shadow: Shadow,
  space: SourceSpace,
  position: number | undefined,
): void {
  const location = position === undefined ? undefined : generatedToOriginal(shadow, position);
  const source =
    location === undefined || location.fidelity === 'none'
      ? undefined
      : shadow.sources[location.source];
  const base = source === undefined ? undefined : space.baseOf(source.name);
  if (
    location === undefined ||
    location.fidelity === 'none' ||
    source === undefined ||
    base === undefined
  ) {
    diagnostics.error('sfc.internal', 'The compiler generated code it cannot compile', 0, 0);
    return;
  }
  if (location.kind === SpanKind.Atom) {
    diagnostics.error(
      'sfc.internal',
      'The compiler generated code it cannot compile',
      base + location.start,
      base + location.end,
    );
    return;
  }
  diagnostics.error(
    'sfc.compile_error',
    'This code cannot be compiled to JavaScript',
    base + location.start,
    base + Math.min(source.text.length, location.start + 1),
  );
}

/**
 * The shadow with every relative `.jsails` specifier written as its compiled
 * `.js` sibling: static imports, re-exports, and dynamic imports of a string
 * literal. The scope pass already parsed this text, so it parses here.
 */
function withCompiledSpecifiers(shadow: Shadow): Shadow {
  const parsed = parseSync('shadow.tsx', shadow.text, { lang: 'tsx' });
  const ranges: { start: number; end: number }[] = [
    ...parsed.module.staticImports.map((entry) => entry.moduleRequest),
    ...parsed.module.staticExports.flatMap((entry) =>
      entry.entries.flatMap((exported) =>
        exported.moduleRequest === null ? [] : [exported.moduleRequest],
      ),
    ),
    ...parsed.module.dynamicImports.map((entry) => entry.moduleRequest),
  ];
  const edits = new Map<number, ShadowEdit>();
  for (const range of ranges) {
    const literal = shadow.text.slice(range.start, range.end);
    const match = /^(["'])(\.\.?\/[^"'\\]*)\.jsails\1$/.exec(literal);
    if (match === null) continue;
    const [, quote, stem] = match;
    edits.set(range.start, {
      start: range.start,
      end: range.end,
      text: `${quote ?? ''}${stem ?? ''}.js${quote ?? ''}`,
    });
  }
  return edits.size === 0 ? shadow : editShadow(shadow, [...edits.values()]);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The project path `to` relative to the directory of the project path `from`. */
function relativePath(from: string, to: string): string {
  const base = from.split('/').slice(0, -1);
  const target = to.split('/');
  let shared = 0;
  while (shared < base.length && shared < target.length - 1 && base[shared] === target[shared]) {
    shared += 1;
  }
  return [...Array<string>(base.length - shared).fill('..'), ...target.slice(shared)].join('/');
}

/**
 * A relative path as a source-map URL: `%`, `#`, `?`, whitespace and control
 * characters are percent-encoded, so a file name is never read as an escape,
 * a fragment or a query; everything else (`[slug]` included) stays readable.
 */
function sourceUrl(path: string): string {
  return path.replace(/[%#?\s\p{Cc}]/gu, (character) => encodeURIComponent(character));
}
