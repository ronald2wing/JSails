/**
 * The transitional emitter of `.jsails` live components: it compiles a file
 * whose `<script lang="ts">` calls `defineLive({...})` into a `.tsx` module
 * exporting `defineComponent({...})`, plus its CSS. The kind lowerings
 * (pages, layouts, views, islands, live components) replace it.
 *
 * Input comes from the one front end, `sfc/blocks.ts` and
 * `sfc/template-parse.ts`, so there is no second parser. The module is:
 *
 * ```tsx
 * import { defineComponent } from 'jsails/server-components';
 * <script content, the defineLive statement blanked>
 * export const widget = defineComponent({
 *   name: 'widget',
 *   <defineLive's object properties, verbatim>
 *   render(state, tools) {
 *     <script setup content>
 *     return (<><lowered template></>);
 *   },
 *   staticFallback() { return (<><lowered template static></>); },
 * });
 * ```
 *
 * Every copied block keeps its line structure (the template lowering is
 * line-preserving), so the line-granular source map is exact per line.
 */

import { parseSync, type ESTree } from 'rolldown/utils';

import { quoteJsString } from './js-literal.js';
import {
  freeComponentTags,
  collectTemplateComponents,
  resolveComponentTags,
} from './resolve-components.js';
import { parseSfcBlocks, type SfcBlock, type SfcTemplateBlock } from './sfc/blocks.js';
import { SfcDiagnostics, type SfcDiagnostic } from './sfc/diagnostics.js';
import { lineStartOffsets, offsetToPoint } from './source-lines.js';
import { SourceMapBuilder, type ComponentSourceMap } from './source-map.js';
import { lowerTemplate } from './template-lower.js';

/** Options for {@link emitSfc}. */
export interface EmitSfcOptions {
  /** The component name, e.g. `'task-list'` (the filename basename, kebab-case). */
  readonly name: string;
  /** Directory of the emitted module, for relative component import specifiers. */
  readonly fromDir: string;
  /** Project root, used to resolve capitalized template tags to `app/components/`. */
  readonly rootDir: string;
  /** True for a tag another build pass provides, which needs no `app/components/` module. */
  readonly isProvided?: (tag: string) => boolean;
}

/** The emitter's result: a `.tsx` module plus the CSS side-band and diagnostics. */
export interface SfcEmitResult {
  /** The module, or `''` when an error stopped code generation. */
  readonly code: string;
  readonly css: string;
  /** The source map for `code`; `null` when code generation was skipped. */
  readonly map: ComponentSourceMap | null;
  readonly diagnostics: readonly SfcDiagnostic[];
}

/** One chunk of the module: text whose lines map to source lines from `line`, or not at all. */
interface Chunk {
  readonly text: string;
  /** 0-based source line of the chunk's first line, or `null` for generated text. */
  readonly line: number | null;
}

/** Compile a `.jsails` live component; see the module comment for the shape. */
export function emitSfc(source: string, fileName: string, options: EmitSfcOptions): SfcEmitResult {
  const file = parseSfcBlocks(source, fileName);
  const diagnostics = new SfcDiagnostics(fileName);
  diagnostics.addAll(file.diagnostics);
  const css = file.styles.map((style) => style.content).join('\n');
  for (const style of file.styles) {
    if (style.scoped) {
      diagnostics.error(
        'sfc.not_lowered',
        '<style scoped> lowers with the styles package',
        style.start,
        style.contentStart,
      );
    }
  }
  const failed = (): SfcEmitResult =>
    Object.freeze({ code: '', css, map: null, diagnostics: diagnostics.list() });
  if (diagnostics.hasErrors || file.template === null) {
    return failed();
  }

  const lineStarts = lineStartOffsets(source);
  const lineOf = (offset: number): number => offsetToPoint(lineStarts, offset).line - 1;
  const context = { source, diagnostics };
  const template = lowerBlock(file.template, context);
  const fallback = file.templateStatic === null ? null : lowerBlock(file.templateStatic, context);

  const script = file.script;
  const live = script === null ? undefined : findDefineLive(script, diagnostics);
  if (live === undefined) {
    if (script === null || !diagnostics.hasErrors) {
      diagnostics.error(
        'sfc.not_lowered',
        'The transitional emitter compiles live components: <script lang="ts"> must call defineLive({...})',
        script?.start ?? 0,
        script?.contentStart ?? 0,
      );
    }
    return failed();
  }

  const binding = toIdentifier(options.name);
  if (!isValidBinding(binding)) {
    diagnostics.error(
      'sfc.invalid_component_name',
      'The component file name does not form a valid JavaScript binding; rename the file',
      0,
      0,
    );
  }
  const componentImports = resolveImports(
    file.template,
    file.templateStatic,
    script,
    file.scriptSetup,
    options,
    diagnostics,
  );
  if (diagnostics.hasErrors) {
    return failed();
  }

  const scriptBlock = script as SfcBlock;
  const blanked =
    scriptBlock.content.slice(0, live.statementStart) +
    scriptBlock.content.slice(live.statementStart, live.statementEnd).replace(/[^\n]/g, '') +
    scriptBlock.content.slice(live.statementEnd);
  const properties = source.slice(live.propertiesStart, live.propertiesEnd).trimEnd();
  const chunks: Chunk[] = [
    { text: "import { defineComponent } from 'jsails/server-components';", line: null },
    { text: componentImports, line: null },
    { text: blanked, line: lineOf(scriptBlock.contentStart) },
    { text: `export const ${binding} = defineComponent({`, line: null },
    { text: `  name: ${quoteJsString(options.name)},`, line: null },
    {
      text: properties.trim() === '' || properties.endsWith(',') ? properties : `${properties},`,
      line: lineOf(live.propertiesStart),
    },
    { text: '  render(state, tools) {', line: null },
  ];
  if (file.scriptSetup !== null) {
    chunks.push({ text: file.scriptSetup.content, line: lineOf(file.scriptSetup.contentStart) });
  }
  chunks.push(
    { text: '    return (<>', line: null },
    { text: template, line: lineOf(file.template.contentStart) },
    { text: '</>);', line: null },
    { text: '  },', line: null },
  );
  if (fallback !== null && file.templateStatic !== null) {
    chunks.push(
      { text: '  staticFallback() {', line: null },
      { text: '    return (<>', line: null },
      { text: fallback, line: lineOf(file.templateStatic.contentStart) },
      { text: '</>);', line: null },
      { text: '  },', line: null },
    );
  }
  chunks.push({ text: '});', line: null });
  if (diagnostics.hasErrors) {
    return failed();
  }

  const rendered = chunks.filter((chunk) => chunk.text.length > 0);
  const code = `${rendered.map((chunk) => chunk.text).join('\n')}\n`;
  return Object.freeze({
    code,
    css,
    map: buildMap(source, fileName, lineStarts, rendered),
    diagnostics: diagnostics.list(),
  });
}

function lowerBlock(
  block: SfcTemplateBlock,
  context: { readonly source: string; readonly diagnostics: SfcDiagnostics },
): string {
  return lowerTemplate(block.root.children, block.contentStart, context);
}

/** Where the one `defineLive({...})` statement of `<script>` sits. */
interface DefineLive {
  /** Statement range, relative to the script content. */
  readonly statementStart: number;
  readonly statementEnd: number;
  /** The object's property text, as file offsets (inside its braces). */
  readonly propertiesStart: number;
  readonly propertiesEnd: number;
}

/**
 * Find the top-level `defineLive({...})` statement. A call with any other shape,
 * or more than one, is reported; `undefined` when there is none to use.
 */
function findDefineLive(script: SfcBlock, diagnostics: SfcDiagnostics): DefineLive | undefined {
  const parsed = parseSync('script.ts', script.content, { sourceType: 'module', lang: 'ts' });
  let found: DefineLive | undefined;
  for (const statement of parsed.program.body) {
    const call = defineLiveCall(statement);
    if (call === undefined) {
      continue;
    }
    const argument = call.arguments[0];
    if (
      found !== undefined ||
      call.arguments.length !== 1 ||
      argument?.type !== 'ObjectExpression'
    ) {
      diagnostics.error(
        'sfc.not_lowered',
        'A live component calls defineLive({...}) once, with one object literal',
        script.contentStart + statement.start,
        script.contentStart + statement.end,
      );
      return undefined;
    }
    found = {
      statementStart: statement.start,
      statementEnd: statement.end,
      propertiesStart: script.contentStart + argument.start + 1,
      propertiesEnd: script.contentStart + argument.end - 1,
    };
  }
  return found;
}

function defineLiveCall(
  statement: ESTree.Program['body'][number],
): ESTree.CallExpression | undefined {
  if (statement.type !== 'ExpressionStatement') {
    return undefined;
  }
  const expression = statement.expression;
  if (
    expression.type === 'CallExpression' &&
    expression.callee.type === 'Identifier' &&
    expression.callee.name === 'defineLive'
  ) {
    return expression;
  }
  return undefined;
}

/**
 * Explicit `import { Tag } from …` lines for the capitalized template tags the
 * component's own code leaves free, or `''` when there are none.
 */
function resolveImports(
  template: SfcTemplateBlock,
  templateStatic: SfcTemplateBlock | null,
  script: SfcBlock | null,
  scriptSetup: SfcBlock | null,
  options: EmitSfcOptions,
  diagnostics: SfcDiagnostics,
): string {
  const found = collectTemplateComponents([
    ...template.root.children,
    ...(templateStatic?.root.children ?? []),
  ]);
  if (found.length === 0) {
    return '';
  }
  const moduleSource = `${script?.content ?? ''}\n${scriptSetup?.content ?? ''}`;
  const free = freeComponentTags(moduleSource, found);
  const tags = found.filter((ref) => free.has(ref.tag) && options.isProvided?.(ref.tag) !== true);
  const resolved = resolveComponentTags(
    tags,
    { fromDir: options.fromDir, rootDir: options.rootDir },
    diagnostics,
  );
  return resolved.map((c) => `import { ${c.tag} } from ${quoteJsString(c.specifier)};`).join('\n');
}

/**
 * The line-granular map: each line of a copied chunk maps to its source line,
 * generated lines are unmapped.
 */
function buildMap(
  source: string,
  fileName: string,
  lineStarts: readonly number[],
  chunks: readonly Chunk[],
): ComponentSourceMap | null {
  const builder = new SourceMapBuilder(source, fileName, lineStarts);
  let generated = 0;
  for (const chunk of chunks) {
    const lines = chunk.text.split('\n').length;
    for (let index = 0; index < lines; index += 1) {
      if (chunk.line === null) {
        builder.markUnmapped(generated, 0);
      } else {
        builder.addMapping(generated, 0, chunk.line + index, 0);
      }
      generated += 1;
    }
  }
  return builder.build({ file: fileName });
}

/**
 * The `export const` binding of a kebab-case component name (`task-list` →
 * `taskList`); {@link isValidBinding} rejects what this cannot fix.
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

/** Words that cannot be an `export const` binding in a module. */
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
