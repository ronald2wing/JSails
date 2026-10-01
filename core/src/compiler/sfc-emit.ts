/**
 * Emission of a `.jsails` single-file component into a `.tsx` module plus a CSS
 * side-band.
 *
 * The `.jsails` host is a Vue-inspired file: `<template>` (view grammar),
 * `<script>` (component config), `<style>` (real CSS), `<server>` (`'use
 * server'` functions). This module is the assembler that lowers those blocks
 * onto the existing `defineComponent(...)` authoring surface — the same target
 * the `#region` compiler emits. No new runtime and no second state authority:
 * the emitted module is a plain `.tsx` module.
 *
 * The `<template>` is lowered through the shared template grammar (`parseTemplate` +
 * `lowerTemplate`); the `<script>` body is carried verbatim as the component
 * config source; the `<style>` body is returned in a separate `css` band (the
 * Vite plugin serves it as a virtual CSS module), so the compiler never has to
 * build a CSS pipeline of its own.
 *
 * The `<server>` block is server-only by name, and the client emission enforces
 * that without relying on per-function `'use server'` directives: the block is
 * rewritten as file-level server code (every function a throwing stub, every
 * other statement — imports, constants, helpers — dropped), and an export that
 * cannot be stubbed is an error. Only a server build (`serverBlock: 'keep'`)
 * receives the block verbatim. The source map's `sourcesContent` blanks the
 * block in a client emission so a published map cannot carry it either.
 */

import { ServerDirectiveError, stubServerOnlyModule } from '../build/server-directive.js';
import { DiagnosticBag } from './diagnostics.js';
import type { CompileDiagnostic, CompilerErrorCode } from './errors.js';
import { quoteJsString } from './js-literal.js';
import {
  collectTemplateComponents,
  freeComponentTags,
  resolveComponentTags,
} from './resolve-components.js';
import { parseSfc } from './sfc.js';
import { lineStartOffsets } from './source-lines.js';
import { SourceMapBuilder, type ComponentSourceMap } from './source-map.js';
import type { TemplateNode } from './template-ast.js';
import { parseTemplate } from './template-ast.js';
import { lowerTemplate, usesDynamicComponent } from './template-lower.js';

/** Options for {@link emitSfc}. */
export interface EmitSfcOptions {
  /** The component name, e.g. `'task-list'` (the filename basename, kebab-case). */
  readonly name: string;
  /** Directory of the emitted module, for relative component import specifiers. */
  readonly fromDir: string;
  /** Project root, used to resolve capitalized template tags to `app/components/`. */
  readonly rootDir: string;
  /**
   * What happens to the `<server>` block. `'stub'` (the default, for a client
   * bundle) replaces every function with a throwing stub and drops everything
   * else; `'keep'` (a server build only) appends the block verbatim.
   */
  readonly serverBlock?: 'stub' | 'keep';
  /**
   * True for a tag another build pass provides (an autoloaded `ui/` component),
   * which therefore needs no `app/components/` module.
   */
  readonly isProvided?: (tag: string) => boolean;
}

/** The emitter's result: a `.tsx` module plus the CSS side-band and diagnostics. */
export interface SfcEmitResult {
  readonly code: string;
  readonly css: string;
  /** The source map for `code`; `null` only when codegen was skipped (errors). */
  readonly map: ComponentSourceMap | null;
  readonly diagnostics: readonly CompileDiagnostic[];
  /** Whether the source has a non-empty `<server>` block. */
  readonly hadServerBlock: boolean;
}

/**
 * The `defineComponent` config keys the `<script>` block may declare. Names are
 * referenced from the emitted `defineComponent({...})` call by the same
 * identifier, so the script author must `export const` them.
 */
const CONFIG_KEYS: readonly string[] = [
  'stateSchema',
  'writableKeys',
  'initialState',
  'authorize',
  'actions',
  'derived',
  'staticFallback',
  'urlBinding',
];

/**
 * Compile a `.jsails` source into a `.tsx` module plus a CSS band.
 *
 * The emitted module is:
 *
 * ```tsx
 * import { defineComponent } from 'jsails/server-components';
 * <script body verbatim>
 * export const widget = defineComponent({
 *   name: 'widget',
 *   stateSchema, writableKeys, initialState, authorize, // only declared keys
 *   render(state, tools) { return (<lowered template>); },
 * });
 * ```
 *
 * The `<style>` body is returned in `css`; the `<server>` block is appended as
 * stubs (or verbatim under `serverBlock: 'keep'`, see the module doc). A
 * capitalized tag in the template resolves to an explicit component import via
 * `resolveComponentTags`, and a dynamic component (`<component :is>`) gets an
 * injected `import { h } from 'preact'`.
 *
 * When the template lowering produces errors, `code` is `''` and
 * `diagnostics` carries the error list.
 *
 * @throws CompilerError `missing_region` when `<script>`/`<template>` is absent.
 */
export function emitSfc(source: string, fileName: string, options: EmitSfcOptions): SfcEmitResult {
  const blocks = parseSfc(source, fileName);

  // Step 1: lower the template to JSX through the shared template grammar.
  const bag = new DiagnosticBag({ source });
  const baseOffset = blocks.offsets.template;
  const report = (
    code: CompilerErrorCode,
    message: string,
    subject: string,
    s: number,
    e: number,
  ) => {
    bag.errorAt(code, message, baseOffset + s, baseOffset + e, undefined, subject);
  };
  const nodes = parseTemplate(blocks.template, report);
  const ctx = { bag, baseOffset };
  const jsx = bag.hasErrors ? '' : lowerTemplate(nodes, ctx);

  const hadServerBlock = blocks.server.trim().length > 0;
  const failed = (): SfcEmitResult =>
    Object.freeze({
      code: '',
      css: blocks.style,
      map: null,
      diagnostics: bag.toList(),
      hadServerBlock,
    });
  if (bag.hasErrors) {
    return failed();
  }

  // Step 2: the `<server>` block. A client emission never carries its text.
  const keepServer = options.serverBlock === 'keep';
  const server = keepServer
    ? blocks.server.trim()
    : clientServerBlock(blocks.server, blocks.offsets.server, fileName, bag);

  // Step 3: resolve free capitalized tags to explicit component imports.
  // Positions come from the parsed tree, which already carries body-absolute
  // offsets; a tag the script or server code binds needs no import.
  const componentImports = resolveBlocks(
    nodes,
    baseOffset,
    `${blocks.script}\n${server}`,
    options,
    bag,
  );

  // Step 4: the dynamic-component `h(...)` lowering needs `h` in scope.
  const hImport = usesDynamicComponent(jsx) ? "import { h } from 'preact';" : '';

  // Step 5: assemble the module. The script body carries the config exports;
  // the emitted defineComponent references only the keys the script declared.
  const binding = toIdentifier(options.name);
  if (!isValidBinding(binding)) {
    bag.errorAt(
      'invalid_name',
      'the component file name does not form a valid JavaScript binding; rename the file',
      0,
      0,
      undefined,
      binding,
    );
  }
  if (bag.hasErrors) {
    return failed();
  }
  const definition = buildDefinition(options.name, binding, jsx, declaredConfigKeys(blocks.script));

  // Each chunk carries its origin: `null` for synthesized lines (imports and the
  // defineComponent skeleton) or a 0-based source line for verbatim block bodies.
  // `jsxOffset` names the chunk/line within `definition` that holds the template.
  const lineStarts = lineStartOffsets(source);
  const chunks: readonly SfcChunk[] = [
    { text: "import { defineComponent } from 'jsails/server-components';", srcLine: null },
    { text: hImport, srcLine: null },
    { text: componentImports, srcLine: null },
    { text: blocks.script.trim(), srcLine: sourceLineAt(lineStarts, blocks.offsets.script) },
    {
      text: definition.text,
      srcLine: null,
      jsx: {
        offset: definition.jsxStartLine,
        count: definition.jsxLineCount,
        templateLine: sourceLineAt(lineStarts, baseOffset),
      },
    },
    {
      text: server,
      srcLine: sourceLineAt(lineStarts, blocks.offsets.server),
      // Stubs share no lines with the block, so they all map to its first line.
      collapse: !keepServer,
    },
  ];

  const rendered = chunks.filter((chunk) => chunk.text.length > 0);
  const code = rendered.map((chunk) => chunk.text).join('\n') + '\n';
  const mapSource = keepServer
    ? source
    : blankServerBlock(source, lineStarts, blocks.offsets.server, blocks.server);
  const map = buildSfcMap(mapSource, fileName, lineStarts, rendered);

  return Object.freeze({
    code,
    css: blocks.style,
    map,
    diagnostics: bag.toList(),
    hadServerBlock,
  });
}

/**
 * One chunk of the assembled SFC module. `srcLine` is the 0-based source line of
 * the chunk's first generated line, or `null` when the chunk is synthesized.
 * `jsx` marks the `defineComponent` chunk, whose embedded template lines map to
 * the `<template>` block.
 */
interface SfcChunk {
  readonly text: string;
  readonly srcLine: number | null;
  /** Map every generated line of the chunk to `srcLine` rather than line-for-line. */
  readonly collapse?: boolean;
  readonly jsx?: {
    /** 0-based line within the chunk where the embedded template begins. */
    readonly offset: number;
    /** Number of embedded template lines. */
    readonly count: number;
    /** 0-based `<template>` source line the first embedded line maps to. */
    readonly templateLine: number;
  };
}

/** The 0-based source line of `offset`, or 0 when the file has no lines. */
function sourceLineAt(lineStarts: readonly number[], offset: number): number {
  let line = 0;
  for (let index = 0; index < lineStarts.length; index += 1) {
    const start = lineStarts[index];
    if (start !== undefined && start <= offset) {
      line = index;
    } else {
      break;
    }
  }
  return line;
}

/**
 * Build the source map for the assembled SFC module. Verbatim block bodies
 * (script, server) and the embedded template lines map one-to-one to their
 * source lines; synthesized import lines and the `defineComponent` skeleton are
 * marked unmapped. Mapping is line-granular: the template is indented by six
 * spaces inside `render`, so column-level precision would be fabricated.
 */
function buildSfcMap(
  source: string,
  fileName: string,
  lineStarts: readonly number[],
  chunks: readonly SfcChunk[],
): ComponentSourceMap | null {
  const builder = new SourceMapBuilder(source, fileName, lineStarts);
  let genLine = 0;
  for (const chunk of chunks) {
    // Chunks are joined by a single newline, so each chunk's first line lands on
    // the very next generated line — no generated line is skipped between them.
    const lines = chunk.text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (
        chunk.jsx !== undefined &&
        index >= chunk.jsx.offset &&
        index < chunk.jsx.offset + chunk.jsx.count
      ) {
        builder.addMapping(genLine, 0, chunk.jsx.templateLine + (index - chunk.jsx.offset), 0);
      } else if (chunk.srcLine !== null) {
        builder.addMapping(genLine, 0, chunk.srcLine + (chunk.collapse === true ? 0 : index), 0);
      } else {
        builder.markUnmapped(genLine, 0);
      }
      genLine += 1;
    }
  }
  return builder.build({ file: fileName });
}

/**
 * Resolve capitalized template tags to explicit `import { Tag } from …`
 * declarations, or return `''` when the template references no component. Tag
 * positions come from the parsed template tree via `collectTemplateComponents`.
 */
function resolveBlocks(
  nodes: readonly TemplateNode[],
  baseOffset: number,
  moduleSource: string,
  options: EmitSfcOptions,
  bag: DiagnosticBag,
): string {
  const found = collectTemplateComponents(nodes, baseOffset);
  const free = found.length === 0 ? new Set<string>() : freeComponentTags(moduleSource, found);
  const tags = found.filter((ref) => free.has(ref.tag) && options.isProvided?.(ref.tag) !== true);
  if (tags.length === 0) {
    return '';
  }
  const report = (
    code: CompilerErrorCode,
    message: string,
    subject: string,
    s: number,
    e: number,
  ) => {
    bag.errorAt(code, message, s, e, undefined, subject);
  };
  const resolved = resolveComponentTags(
    tags,
    { fromDir: options.fromDir, rootDir: options.rootDir },
    report,
  );
  return resolved.map((c) => `import { ${c.tag} } from ${quoteJsString(c.specifier)};`).join('\n');
}

/**
 * The config keys the `<script>` block actually exports, in `CONFIG_KEYS` order.
 *
 * Only declared keys are emitted into the `defineComponent({...})` call: an
 * undeclared key would reference an undefined identifier and fail to typecheck.
 * The script is plain TS, so a targeted scan for `export const <key>` /
 * `export function <key>` / `export { <key> }` is sufficient and dependency-free.
 */
function declaredConfigKeys(script: string): readonly string[] {
  return CONFIG_KEYS.filter((key) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(
      `\\bexport\\s+(?:const|let|var|function|async\\s+function)\\s+${escaped}\\b`,
    );
    const reExport = new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`);
    return declaration.test(script) || reExport.test(script);
  });
}

/**
 * Build the `export const <binding> = defineComponent({...})` declaration from
 * the lowered JSX, referencing the script's `export const` config keys by name.
 * `name` is the runtime identity (kebab-case filename); the binding is its
 * identifier form (`task-list` → `taskList`).
 *
 * Returns the block plus the 0-based line index (within the block) at which the
 * embedded template's first line lands, and its line count, so the caller can
 * map those generated lines back to the `<template>` source.
 */
function buildDefinition(
  name: string,
  binding: string,
  jsx: string,
  configKeys: readonly string[],
): { readonly text: string; readonly jsxStartLine: number; readonly jsxLineCount: number } {
  const configEntries = configKeys.map((key) => `  ${key},`).join('\n');
  // A template may have several top-level elements; JSX requires a single root,
  // so the lowered view is always wrapped in a fragment.
  const wrapped = `<>${jsx}</>`;
  const rendered = indent(wrapped, 6);
  const lines = [
    `export const ${binding} = defineComponent({`,
    `  name: ${quoteJsString(name)},`,
    configEntries,
    `  render(state, tools) {`,
    `    return (${rendered});`,
    `  },`,
    `});`,
  ];
  const head = lines.slice(0, 4).join('\n');
  const jsxStartLine = head.split('\n').length;
  return { text: lines.join('\n'), jsxStartLine, jsxLineCount: rendered.split('\n').length };
}

/**
 * Derive the JS identifier binding from a filename-derived component name. The
 * runtime identity stays the kebab-case filename (`name: 'task-list'`), but the
 * `export const` binding must be an identifier, so a kebab-case name becomes
 * camelCase (`taskList`); any character that cannot appear in an identifier is
 * a word boundary. {@link isValidBinding} rejects what this cannot fix (a
 * leading digit, a reserved word).
 */
function toIdentifier(name: string): string {
  const words = name.split(/[^A-Za-z0-9_$]+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return name;
  }
  return words
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('');
}

/**
 * Words that cannot be an `export const` binding in a module: the ES reserved
 * words, the strict-mode future reserved words, and `await` (reserved in a
 * module).
 */
const RESERVED_BINDINGS: ReadonlySet<string> = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'arguments',
  'eval',
]);

/** True when `binding` can be declared with `export const` in a module. */
function isValidBinding(binding: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding) && !RESERVED_BINDINGS.has(binding);
}

/**
 * The client form of the `<server>` block: stubs for its functions and nothing
 * else (see the module doc). A block the rewrite cannot make safe is reported as
 * an error spanning the block, and contributes no text.
 */
function clientServerBlock(
  server: string,
  offset: number,
  fileName: string,
  bag: DiagnosticBag,
): string {
  if (server.trim().length === 0) {
    return '';
  }
  try {
    return stubServerOnlyModule(server, fileName).code.trim();
  } catch (error) {
    if (!(error instanceof ServerDirectiveError)) {
      throw error;
    }
    bag.errorAt(
      error.code,
      `the <server> block cannot be stubbed for the client: ${error.message}`,
      offset,
      offset + server.length,
      undefined,
      error.subject,
    );
    return '';
  }
}

/**
 * `source` with the `<server>` block body replaced by spaces (line breaks kept,
 * so every offset and line still lines up) for a client map's `sourcesContent`.
 */
function blankServerBlock(
  source: string,
  lineStarts: readonly number[],
  offset: number,
  server: string,
): string {
  if (server.length === 0) {
    return source;
  }
  const lastLine = sourceLineAt(lineStarts, offset) + server.split('\n').length;
  const end = lineStarts[lastLine] ?? source.length;
  return (
    source.slice(0, offset) + source.slice(offset, end).replace(/[^\r\n]/g, ' ') + source.slice(end)
  );
}

/** Indent each line of `source` by `spaces`. */
function indent(source: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return source
    .split('\n')
    .map((line) => (line.length === 0 ? line : pad + line))
    .join('\n');
}
