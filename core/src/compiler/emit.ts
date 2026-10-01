/**
 * Shape-aware component emission: reassembly, directive lowering, and output
 * generation for the three component shapes (single, inline-server, multi-file).
 *
 * All operations are pure transforms over source strings. The emitter is the
 * caller of `planSplit` for Shape 3 — it does not re-derive the split-boundary
 * closure rule.
 *
 * Errors are collected, not thrown: the emit layer creates a `DiagnosticBag`
 * and threads it through lowering. When errors exist, codegen is skipped and
 * the emitted component carries the diagnostic list.
 */

import { ConvertComponentError, planSplit } from './component-shape.js';
import { DiagnosticBag } from './diagnostics.js';
import { Visitor, parseSync, type ESTree } from 'rolldown/utils';

import { lowerDirective } from './directives.js';
import type { CompileDiagnostic, CompilerErrorCode } from './errors.js';
import { quoteJsString } from './js-literal.js';
import type { ComponentRegions, RegionName } from './regions.js';
import {
  freeComponentTags,
  resolveComponentTags,
  type ComponentTagRef,
} from './resolve-components.js';
import { collectUnmatchedIdentifiers } from './scope-walker.js';
import { lineStartOffsets } from './source-lines.js';
import { SourceMapBuilder, type ComponentSourceMap } from './source-map.js';
import { lowerTemplateRegion } from './template.js';
import { usesDynamicComponent } from './template-lower.js';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export type EmitShape = 'single' | 'inline-server' | 'multi-file';

/** Where to resolve capitalized template tags to component modules. */
export interface EmitResolveOptions {
  /** Directory of the emitted module, for the relative import specifier. */
  readonly fromDir: string;
  /** Project root, used to locate `app/components/`. */
  readonly rootDir: string;
  /**
   * True for a tag another build pass provides (an autoloaded `ui/` component),
   * which therefore needs no `app/components/` module.
   */
  readonly isProvided?: (tag: string) => boolean;
}

export interface EmitOptions {
  readonly name: string;
  readonly regions: ComponentRegions;
  readonly shape: EmitShape;
  /**
   * When present, capitalized tags in the view are resolved to explicit
   * component imports prepended to the emitted module. When absent, the view is
   * emitted verbatim (the compiler stays usable without a project root).
   */
  readonly resolve?: EmitResolveOptions;
  /**
   * The full component source, used to render code frames for diagnostics.
   * When absent, diagnostics carry an empty `frame`.
   */
  readonly source?: string;
  /** Whether to render code frames. Defaults to `true`. */
  readonly frames?: boolean;
}

export interface EmittedComponent {
  readonly entry: string;
  readonly model?: string;
  readonly style?: string;
  readonly server?: string;
  /**
   * The source map for `entry`. Present for Shape 1/2, where `entry` is the
   * verbatim reassembly of the regions; `null` when codegen was skipped (errors)
   * or for Shape 3, whose `entry` is rebuilt by `planSplit` (not map-aware), so a
   * single reassembly map would be wrong.
   */
  readonly map: ComponentSourceMap | null;
  readonly diagnostics: readonly CompileDiagnostic[];
}

/* ------------------------------------------------------------------ */
/*  Reassembly                                                        */
/* ------------------------------------------------------------------ */

const REGION_ORDER: readonly RegionName[] = ['model', 'server', 'style', 'view'];

/**
 * One chunk of the reassembled output. `srcStartLine` is the 0-based source line
 * of the chunk's first line, or `null` when the chunk carries no source origin
 * (a region marker, a blank separator, the injected import block).
 */
interface OutputChunk {
  readonly text: string;
  readonly srcStartLine: number | null;
  /** Generated column the chunk's first line starts at (non-zero when indented). */
  readonly genCol: number;
}

/** What {@link reassemble} stitches back together. */
interface ReassembleInput {
  /** The regions to emit, with the lowered view in place of the authored one. */
  readonly regions: Omit<ComponentRegions, 'offsets'>;
  /** Source-line offsets of each authored region body. */
  readonly offsets: ComponentRegions['offsets'];
  /** The original component source the map resolves back to. */
  readonly source: string;
  /** The generated file name recorded in the map. */
  readonly file: string;
  /** Compiler-injected import lines prepended to the authored preamble. */
  readonly synthesizedPreambleLines: number;
}

/**
 * Rebuild a single-file source by emitting the preamble (file doc comment and
 * imports) followed by the four regions in the fixed order `model`, `server`,
 * `style`, `view`, each wrapped in its region markers, separated by an empty
 * line. Region bodies are preserved verbatim so the output is an idempotent
 * input to `extractRegions`.
 *
 * `synthesizedPreambleLines` is the number of compiler-injected import lines
 * prepended to the authored preamble; those generated lines carry no source
 * origin and are emitted unmapped.
 *
 * One chunk list drives both the code and the map, so the two cannot drift:
 * every generated line that carries a verbatim body is mapped to its original
 * source line, and every synthesized line is emitted unmapped.
 */
function reassemble(input: ReassembleInput): {
  readonly code: string;
  readonly map: ComponentSourceMap | null;
} {
  const { regions, offsets, source, file, synthesizedPreambleLines } = input;
  const builder = new SourceMapBuilder(source, file, lineStartOffsets(source));
  const chunks: OutputChunk[] = [];

  if (regions.preamble.length > 0) {
    const lines = regions.preamble.split('\n');
    const injected = lines.slice(0, synthesizedPreambleLines);
    const original = lines.slice(synthesizedPreambleLines);
    if (injected.length > 0) {
      chunks.push({ text: injected.join('\n'), srcStartLine: null, genCol: 0 });
    }
    if (original.length > 0) {
      chunks.push({
        text: original.join('\n'),
        srcStartLine: builder.sourceLineAt(offsets.preamble),
        genCol: 0,
      });
    }
  }

  for (const name of REGION_ORDER) {
    chunks.push({ text: `// #region ${name}`, srcStartLine: null, genCol: 0 });
    chunks.push({
      text: regions[name],
      srcStartLine: builder.sourceLineAt(offsets[name]),
      genCol: 0,
    });
    chunks.push({ text: `// #endregion ${name}`, srcStartLine: null, genCol: 0 });
  }

  const code = chunks.map((chunk) => chunk.text).join('\n\n') + '\n';

  let genLine = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    if (index > 0) {
      // The blank line the `\n\n` join introduces between chunks.
      builder.markUnmapped(genLine, 0);
      genLine += 1;
    }
    const chunk = chunks[index];
    if (chunk === undefined) {
      continue;
    }
    if (chunk.srcStartLine === null) {
      builder.addVerbatimBlock(chunk.text, genLine, -1, chunk.genCol);
    } else {
      builder.addVerbatimBlock(chunk.text, genLine, chunk.srcStartLine, chunk.genCol);
    }
    genLine += chunk.text.split('\n').length;
  }

  return { code, map: builder.build({ file }) };
}

/* ------------------------------------------------------------------ */
/*  Raw-JSX view analysis (one parse of the reassembled module)        */
/* ------------------------------------------------------------------ */

/** A structural view of the few estree nodes the view analysis reads. */
interface JsxNodeLike {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

const asJsxNode = (value: unknown): JsxNodeLike | undefined =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string'
    ? (value as JsxNodeLike)
    : undefined;

/** One `js-*` attribute found in the raw-JSX view. */
interface DirectiveAttribute {
  /** View-relative range of the whole attribute. */
  readonly start: number;
  readonly end: number;
  readonly name: string;
  /**
   * The lowered argument source: a quoted string value becomes a JS string
   * literal (the same rule as the `<template>` dialect: a quoted value is a
   * name), a `{expr}` value is passed through verbatim, `null` when valueless.
   */
  readonly arg: string | null;
}

/** What one parse of the module tells the emitter about its raw-JSX view. */
interface RawViewAnalysis {
  readonly directives: readonly DirectiveAttribute[];
  readonly tags: readonly ComponentTagRef[];
  /** Names used but not declared anywhere in the module (JSX tags included). */
  readonly free: ReadonlySet<string>;
}

/** The JSX attribute name as written (`js-submit`, `js-on:click`). */
function jsxAttributeName(name: JsxNodeLike | undefined): string | undefined {
  if (name?.type === 'JSXIdentifier' && typeof name.name === 'string') {
    return name.name;
  }
  if (name?.type === 'JSXNamespacedName') {
    const namespace = asJsxNode(name.namespace);
    const local = asJsxNode(name.name);
    if (typeof namespace?.name === 'string' && typeof local?.name === 'string') {
      return `${namespace.name}:${local.name}`;
    }
  }
  return undefined;
}

/**
 * Parse the reassembled module once and collect, for the raw-JSX view, every
 * `js-*` attribute (as a real JSX attribute — never text, a string, a comment, or
 * a `className="js-…"` value), every capitalized tag, and the module's free
 * names. `prefix` is the text before the view; `view` positions are relative to
 * the view. Returns `undefined` when the module does not parse.
 */
function analyzeRawView(
  prefix: string,
  view: string,
  viewOffset: number,
): RawViewAnalysis | undefined {
  const viewStart = prefix.length;
  const program = parseModuleTsx(prefix + view);
  if (program === undefined) {
    return undefined;
  }
  const directives: DirectiveAttribute[] = [];
  const tags = new Map<string, ComponentTagRef>();
  new Visitor({
    JSXAttribute(node: unknown) {
      const attribute = asJsxNode(node);
      if (attribute === undefined || attribute.start < viewStart) {
        return;
      }
      const name = jsxAttributeName(asJsxNode(attribute.name));
      if (name === undefined || !name.startsWith('js-')) {
        return;
      }
      const value = asJsxNode(attribute.value);
      let arg: string | null = null;
      if (value?.type === 'Literal' && typeof value.value === 'string') {
        arg = quoteJsString(value.value);
      } else if (value?.type === 'JSXExpressionContainer') {
        const expression = asJsxNode(value.expression);
        if (expression !== undefined && expression.type !== 'JSXEmptyExpression') {
          arg = view.slice(expression.start - viewStart, expression.end - viewStart);
        }
      }
      directives.push({
        start: attribute.start - viewStart,
        end: attribute.end - viewStart,
        name,
        arg,
      });
    },
    JSXOpeningElement(node: unknown) {
      const element = asJsxNode(node);
      if (element === undefined || element.start < viewStart) {
        return;
      }
      const tag = jsxRootName(asJsxNode(element.name));
      if (tag === undefined || !/^[A-Z]/.test(tag) || tags.has(tag)) {
        return;
      }
      tags.set(
        tag,
        Object.freeze({
          tag,
          start: viewOffset + element.start - viewStart,
          end: viewOffset + element.end - viewStart,
        }),
      );
    },
  }).visit(program);
  return {
    directives,
    tags: [...tags.values()].sort((a, b) => a.tag.localeCompare(b.tag)),
    free: collectUnmatchedIdentifiers(program),
  };
}

/** The root identifier of a JSX element name (`Foo` for `<Foo.Bar>`). */
function jsxRootName(name: JsxNodeLike | undefined): string | undefined {
  if (name?.type === 'JSXIdentifier' && typeof name.name === 'string') {
    return name.name;
  }
  return name?.type === 'JSXMemberExpression' ? jsxRootName(asJsxNode(name.object)) : undefined;
}

/** Parse TSX module source, or `undefined` on a hard parse error. */
function parseModuleTsx(code: string): ESTree.Program | undefined {
  try {
    const parsed = parseSync('component.tsx', code, { sourceType: 'module' });
    return parsed.errors.some((error) => error.severity === 'Error') ? undefined : parsed.program;
  } catch {
    return undefined;
  }
}

/**
 * Lower the raw-JSX view's `js-*` attributes onto render-tool spreads. Only real
 * JSX attributes are rewritten, so `className="js-toggle"`, text, strings, and
 * comments are untouched.
 */
function lowerViewDirectives(
  view: string,
  directives: readonly DirectiveAttribute[],
  bag: DiagnosticBag,
  baseOffset: number,
): string {
  let out = view;
  // Splice from the end so earlier offsets stay valid.
  for (const directive of [...directives].sort((a, b) => b.start - a.start)) {
    const lowered = lowerDirective(directive.name, directive.arg, (code, message, subject) => {
      bag.errorAt(
        code,
        message,
        baseOffset + directive.start,
        baseOffset + directive.end,
        undefined,
        subject,
      );
    });
    const replacement =
      lowered === null ? '' : `{...${lowered.builder}(${lowered.args.join(', ')})}`;
    out = out.slice(0, directive.start) + replacement + out.slice(directive.end);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Component import resolution                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve the view's free capitalized tags and prepend an import for each to
 * the preamble. A tag the module already binds (an import, a local declaration)
 * is not resolved, so re-emitting an already-resolved module is a no-op, and a
 * tag the autoload pass provides (`resolve.isProvided`) is left to that pass. A
 * free tag with no module is reported as a positioned `unresolved_component`
 * and skipped, so multiple missing components surface together.
 */
function prependComponentImports(
  preamble: string,
  tags: readonly ComponentTagRef[],
  free: ReadonlySet<string>,
  resolve: EmitResolveOptions,
  bag: DiagnosticBag,
): string {
  const report = (
    code: CompilerErrorCode,
    message: string,
    subject: string,
    s: number,
    e: number,
  ) => {
    bag.errorAt(code, message, s, e, undefined, subject);
  };

  const unbound = tags.filter((ref) => free.has(ref.tag) && resolve.isProvided?.(ref.tag) !== true);
  if (unbound.length === 0) {
    return preamble;
  }

  const resolved = resolveComponentTags(unbound, resolve, report);
  const lines = resolved.map(
    (component) => `import { ${component.tag} } from ${quoteJsString(component.specifier)};`,
  );
  if (lines.length === 0) {
    return preamble;
  }

  const block = lines.join('\n');
  return preamble.length > 0 ? `${block}\n${preamble}` : block;
}

/**
 * Prepend `import { h } from 'preact'` when the lowered view uses the dynamic
 * component lowering. Idempotent: skipped when the preamble already imports
 * `h`, so re-emitting an already-resolved module is a no-op.
 */
function prependDynamicImport(preamble: string, view: string): string {
  if (!usesDynamicComponent(view) || preamble.includes('{ h }')) {
    return preamble;
  }
  const line = "import { h } from 'preact';";
  return preamble.length > 0 ? `${line}\n${preamble}` : line;
}

/* ------------------------------------------------------------------ */
/*  emitComponent                                                     */
/* ------------------------------------------------------------------ */

/**
 * Compile a component from its extracted regions into the target shape.
 *
 * The caller owns shape selection; this function takes `shape` explicitly. The
 * returned object is frozen.
 *
 * Shape 1 (`single`) and Shape 2 (`inline-server`): reassemble and return
 * only the entry. The `server` region's `'use server'` functions stay inline
 * in the entry for `serverDirectivePlugin` to strip later.
 *
 * Shape 3 (`multi-file`): reassemble, lower directives, then call `planSplit`
 * to split into entry + server parts. The caller receives both parts and owns
 * writing them to disk.
 *
 * When the diagnostic bag collects errors, codegen is skipped: `entry` is `''`,
 * `model`/`style`/`server` are `undefined`.
 *
 * `emitComponent` does not throw for a component-source problem: an unresolved
 * component tag, a view that will not parse, or a component that cannot be split
 * all become positioned diagnostics in `diagnostics`, and `entry` is `''`. Only
 * a genuinely unexpected error (a non-`ConvertComponentError` escaping the split)
 * propagates.
 */
export function emitComponent(options: EmitOptions): EmittedComponent {
  const { name, regions, shape, resolve, source, frames } = options;
  const bag = new DiagnosticBag({ source, frames });

  // Step 1: lower a `<template>` block to JSX (no-op for the raw-JSX dialect).
  // A `<template>` block's directives are already consumed by template lowering;
  // the raw-JSX dialect is lowered from one parse of the reassembled module.
  const jsxView = lowerTemplateRegion(regions.view, regions.offsets.view, bag);
  const prefix = [regions.preamble, regions.model, regions.server, regions.style].join('\n') + '\n';
  let loweredView = jsxView.code;
  let tags: readonly ComponentTagRef[] = [];
  let free: ReadonlySet<string> = new Set();
  if (jsxView.wasTemplate) {
    tags = jsxView.components ?? [];
    free = resolve === undefined || tags.length === 0 ? free : freeComponentTags(prefix, tags);
  } else {
    const analysis = analyzeRawView(prefix, jsxView.code, jsxView.offset);
    if (analysis === undefined) {
      bag.errorAt('unparseable', 'view region could not be parsed', jsxView.offset, jsxView.offset);
    } else {
      loweredView = lowerViewDirectives(jsxView.code, analysis.directives, bag, jsxView.offset);
      tags = analysis.tags;
      free = analysis.free;
    }
  }

  // Step 2: resolve free capitalized tags to explicit component imports and
  // prepend them to the preamble. Skipped when no resolver is configured.
  const withComponents =
    resolve === undefined
      ? regions.preamble
      : prependComponentImports(regions.preamble, tags, free, resolve, bag);

  // Step 3: a dynamic component lowers to `h(...)`, which needs `h` in scope.
  // Inject the import unless the preamble already provides it.
  const preamble = prependDynamicImport(withComponents, loweredView);

  // Step 4: reassemble with the lowered view region. The source map is built
  // from the *original* component source so every verbatim region line resolves
  // back to where the author wrote it.
  const componentSource = source ?? '';
  // Both prependers only ever prepend whole lines, so the line-count delta is
  // exactly the number of compiler-injected import lines.
  const synthesizedPreambleLines =
    regions.preamble.length === 0
      ? preamble.split('\n').length
      : preamble.split('\n').length - regions.preamble.split('\n').length;
  const { code: reassembled, map } = reassemble({
    regions: {
      preamble,
      model: regions.model,
      server: regions.server,
      style: regions.style,
      view: loweredView,
    },
    offsets: regions.offsets,
    source: componentSource,
    file: name + '.tsx',
    synthesizedPreambleLines: Math.max(0, synthesizedPreambleLines),
  });

  // Step 5: handle shape. Skip codegen when errors exist.
  if (bag.hasErrors) {
    return Object.freeze({ entry: '', map: null, diagnostics: bag.toList() });
  }

  if (shape === 'multi-file') {
    try {
      const plan = planSplit(reassembled, name + '.tsx');
      return Object.freeze({
        entry: plan.entry,
        model: plan.model,
        style: plan.style,
        server: plan.server,
        // `planSplit` rebuilds the entry from live statements; a reassembly map
        // would not describe the rebuilt output, so it is omitted.
        map: null,
        diagnostics: bag.toList(),
      });
    } catch (error) {
      // A split failure is a component-source problem, not a framework fault:
      // report it as a diagnostic (anchored to the whole component) and return
      // an empty entry, so the caller sees one uniform error contract.
      if (error instanceof ConvertComponentError) {
        const code: CompilerErrorCode =
          error.code === 'unmigratable_reference' ? 'unmigratable_reference' : 'unparseable';
        bag.errorAt(code, error.message, 0, source?.length ?? 0);
        return Object.freeze({ entry: '', map: null, diagnostics: bag.toList() });
      }
      throw error;
    }
  }

  // Shape 'single' or 'inline-server': only the entry.
  return Object.freeze({ entry: reassembled, map, diagnostics: bag.toList() });
}
