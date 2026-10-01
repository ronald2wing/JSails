/**
 * What the kind lowerings need to know about a `.jsails` file's `<script>`
 * and `<script setup>`, read from oxc's parse of each block: the names
 * `<script>` exports, the macro calls (sfc-plan §2.3), the imports and type
 * declarations to hoist out of `<script setup>`, and whether setup awaits.
 *
 * It also enforces the block rules that depend on the kind: a macro is
 * called in its block and kind only and never imported, `defineLive` lives
 * in `components/`, hooks in `islands/`, `await` in an awaited kind, and
 * `<script setup>` exports nothing (it runs once per render). Every offset is
 * an offset of the component's offset space (`source-space.ts`).
 */

import { parseSync, Visitor, type ESTree } from 'rolldown/utils';

import type { SfcBlock } from './blocks.js';
import type { SfcDiagnostics } from './diagnostics.js';
import { SFC_MACROS, type SfcLoweredSpec, type SfcMacro } from './kinds.js';
import { sourceSpan, type SourceSpan } from './source-span.js';

/** A typed macro call in `<script setup>`: `defineProps<T>()`, `defineSlots<S>()` or `defineEmits<E>()`. */
export interface PropsMacroCall {
  readonly macro: TypedMacro;
  /** The type argument's range. */
  readonly type: SourceSpan;
  /** The call expression's range. */
  readonly call: SourceSpan;
  /**
   * The whole statement's range when the call is a statement of its own,
   * which the lowering drops; `null` when its value is bound
   * (`const { a } = defineProps<T>()`), which reads the props instead.
   */
  readonly statement: SourceSpan | null;
}

/** The macros that take one type argument and no arguments. */
export type TypedMacro = 'defineProps' | 'defineSlots' | 'defineEmits';

/** The analysis of `<script>`. */
export interface ScriptAnalysis {
  /** The names `<script>` exports, in source order. */
  readonly exports: readonly string[];
  /** Whether `<script>` exports `load` (a page's props source). */
  readonly exportsLoad: boolean;
  /** The `export const serverOnly = true` declaration, when the kind honours it. */
  readonly serverOnly: SourceSpan | null;
  /** Default imports of `.jsails` files (a live tag may be one). */
  readonly jsailsImports: readonly JsailsImport[];
}

/** A default import of a `.jsails` file by a relative specifier: `import TaskList from '../components/task-list.jsails'`. */
export interface JsailsImport {
  /** The local name. */
  readonly name: string;
  readonly specifier: string;
  /** The project path of the file that holds the import, which the specifier is relative to. */
  readonly from: string;
}

/** The analysis of `<script setup>`. */
export interface SetupAnalysis {
  /**
   * Top-level `import`, `interface` and `type` declarations. They are hoisted
   * to module scope, where a props type written in setup
   * (`interface Props {…}` then `defineProps<Props>()`) is visible to the
   * component's parameter list, and where an import must be anyway.
   */
  readonly hoisted: readonly SourceSpan[];
  readonly defineProps: PropsMacroCall | null;
  readonly defineSlots: PropsMacroCall | null;
  /** An island's `defineEmits<E>()`, bound to an identifier or a statement of its own. */
  readonly defineEmits: PropsMacroCall | null;
  /** Whether setup awaits outside nested functions (the function is `async`). */
  readonly awaits: boolean;
  /** Default imports of `.jsails` files (a live tag may be one). */
  readonly jsailsImports: readonly JsailsImport[];
}

type Program = ESTree.Program;
type Node = { type: string; start: number; end: number; [key: string]: unknown };

const EMPTY_SCRIPT: ScriptAnalysis = Object.freeze({
  exports: Object.freeze([]),
  exportsLoad: false,
  serverOnly: null,
  jsailsImports: Object.freeze([]),
});

const HOISTED_STATEMENTS: ReadonlySet<string> = new Set([
  'ImportDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
]);

const EMPTY_SETUP: SetupAnalysis = Object.freeze({
  hoisted: Object.freeze([]),
  defineProps: null,
  defineSlots: null,
  defineEmits: null,
  awaits: false,
  jsailsImports: Object.freeze([]),
});

/** Parse a block, or `undefined` when it does not parse (the scanner reported it). */
export function parseBlock(block: SfcBlock): Program | undefined {
  const result = parseSync('block.ts', block.content, { sourceType: 'module', lang: 'ts' });
  return result.errors.some((entry) => entry.severity === 'Error') ? undefined : result.program;
}

/** Visit every node of `program` with the given hooks (`Type` and `Type:exit`). */
function visit(program: Program, hooks: Record<string, (node: Node) => void>): void {
  new Visitor(hooks).visit(program);
}

const IMPORTABLE_MACRO = new Set<string>(SFC_MACROS);
const FUNCTION_TYPES = [
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
] as const;

/** Report every import of a macro name: macros are compile-time only. */
function reportMacroImports(program: Program, at: number, diagnostics: SfcDiagnostics): void {
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    for (const specifier of statement.specifiers) {
      const imported =
        specifier.type === 'ImportSpecifier'
          ? specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : specifier.imported.value
          : specifier.local.name;
      if (IMPORTABLE_MACRO.has(imported) || IMPORTABLE_MACRO.has(specifier.local.name)) {
        diagnostics.error(
          'sfc.macro_import',
          'Macros are compile-time only and are never imported',
          at + specifier.start,
          at + specifier.end,
        );
      }
    }
  }
}

/** The default imports of `.jsails` files by relative specifier in `program`. */
function jsailsImports(program: Program, from: string): readonly JsailsImport[] {
  const found: JsailsImport[] = [];
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
    const specifier = statement.source.value;
    if (!specifier.startsWith('.') || !specifier.endsWith('.jsails')) continue;
    for (const entry of statement.specifiers) {
      if (entry.type === 'ImportDefaultSpecifier') {
        found.push(Object.freeze({ name: entry.local.name, specifier, from }));
      }
    }
  }
  return Object.freeze(found);
}

/** Every call of a macro in `program`, with the macro's name. */
export function macroCalls(program: Program): readonly { macro: SfcMacro; node: Node }[] {
  const calls: { macro: SfcMacro; node: Node }[] = [];
  visit(program, {
    CallExpression(node) {
      const callee = node.callee as Node;
      const name = callee.type === 'Identifier' ? (callee.name as string) : '';
      if (IMPORTABLE_MACRO.has(name)) calls.push({ macro: name as SfcMacro, node });
    },
  });
  return calls;
}

/**
 * Analyse `<script>` for a file of the kind `spec`. A live component's
 * `defineLive` call is `live-definition.ts`'s to check.
 */
export function analyseScript(
  block: SfcBlock | null,
  spec: SfcLoweredSpec,
  diagnostics: SfcDiagnostics,
): ScriptAnalysis {
  if (block === null) return EMPTY_SCRIPT;
  const program = parseBlock(block);
  if (program === undefined) return EMPTY_SCRIPT;
  const at = block.contentStart;
  reportMacroImports(program, at, diagnostics);
  for (const { macro, node } of macroCalls(program)) {
    if (macro === 'defineLive') {
      if (spec.kind === 'live') continue;
      diagnostics.error(
        'sfc.live_outside_components',
        'defineLive belongs to a live component, a .jsails file under components/',
        at + node.start,
        at + node.end,
      );
    } else {
      diagnostics.error(
        'sfc.macro_position',
        'This macro is called in <script setup>',
        at + node.start,
        at + node.end,
      );
    }
  }

  const exports: string[] = [];
  let serverOnly: SourceSpan | null = null;
  for (const statement of program.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      diagnostics.error(
        'sfc.script_default_export',
        'The template is the default export; <script> exports named values only',
        at + statement.start,
        at + statement.end,
      );
      continue;
    }
    if (statement.type === 'ExportAllDeclaration') {
      diagnostics.error(
        'sfc.script_default_export',
        'export * could re-export a default; export named values only',
        at + statement.start,
        at + statement.end,
      );
      continue;
    }
    if (statement.type !== 'ExportNamedDeclaration') continue;
    for (const name of exportedNames(statement)) {
      exports.push(name.name);
      if (name.name !== 'serverOnly') continue;
      if (spec.serverOnly && name.literalTrue) {
        serverOnly = sourceSpan(at + statement.start, at + statement.end);
      } else {
        diagnostics.error(
          'sfc.server_only_literal',
          spec.serverOnly
            ? 'A page is marked server-only with export const serverOnly = true'
            : 'Only a page can be marked server-only',
          at + name.start,
          at + name.end,
        );
      }
    }
  }
  return Object.freeze({
    exports: Object.freeze(exports),
    exportsLoad: exports.includes('load'),
    serverOnly,
    jsailsImports: jsailsImports(program, block.file),
  });
}

interface ExportedName {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /** Declared `export const name = true`. */
  readonly literalTrue: boolean;
}

/** The names an `export { … }` or `export <declaration>` statement exports. */
function exportedNames(statement: ESTree.ExportNamedDeclaration): readonly ExportedName[] {
  const names: ExportedName[] = [];
  const declaration = statement.declaration;
  if (declaration?.type === 'VariableDeclaration') {
    for (const declarator of declaration.declarations) {
      for (const id of bindingIdentifiers(declarator.id as unknown as Node)) {
        names.push({
          name: id.name as string,
          start: id.start,
          end: id.end,
          literalTrue:
            declaration.kind === 'const' &&
            declarator.id.type === 'Identifier' &&
            declarator.init?.type === 'Literal' &&
            declarator.init.value === true,
        });
      }
    }
  } else if (
    declaration !== null &&
    declaration !== undefined &&
    'id' in declaration &&
    declaration.id !== null &&
    declaration.id !== undefined &&
    declaration.id.type === 'Identifier'
  ) {
    names.push({
      name: declaration.id.name,
      start: declaration.id.start,
      end: declaration.id.end,
      literalTrue: false,
    });
  }
  for (const specifier of statement.specifiers) {
    const exported = specifier.exported;
    names.push({
      name: exported.type === 'Identifier' ? exported.name : String(exported.value),
      start: exported.start,
      end: exported.end,
      literalTrue: false,
    });
  }
  return names;
}

/** The identifiers a binding pattern declares. */
export function bindingIdentifiers(pattern: Node | null | undefined): readonly Node[] {
  if (pattern === null || pattern === undefined) return [];
  switch (pattern.type) {
    case 'Identifier':
      return [pattern];
    case 'ObjectPattern':
      return (pattern.properties as Node[]).flatMap((property) =>
        bindingIdentifiers(
          property.type === 'RestElement' ? (property.argument as Node) : (property.value as Node),
        ),
      );
    case 'ArrayPattern':
      return (pattern.elements as (Node | null)[]).flatMap((element) =>
        bindingIdentifiers(element),
      );
    case 'AssignmentPattern':
      return bindingIdentifiers(pattern.left as Node);
    case 'RestElement':
      return bindingIdentifiers(pattern.argument as Node);
    default:
      return [];
  }
}

/** Analyse `<script setup>` for a file of the kind `spec`. */
export function analyseSetup(
  block: SfcBlock | null,
  spec: SfcLoweredSpec,
  diagnostics: SfcDiagnostics,
): SetupAnalysis {
  if (block === null) return EMPTY_SETUP;
  const program = parseBlock(block);
  if (program === undefined) return EMPTY_SETUP;
  const at = block.contentStart;
  reportMacroImports(program, at, diagnostics);

  const hoisted: SourceSpan[] = [];
  const topLevel = new Map<Node, Node>();
  for (const statement of program.body as unknown as Node[]) {
    if (HOISTED_STATEMENTS.has(statement.type)) {
      hoisted.push(sourceSpan(at + statement.start, at + statement.end));
    } else if (statement.type.startsWith('Export')) {
      diagnostics.error(
        'sfc.setup_export',
        '<script setup> runs on every render and exports nothing; export from <script>',
        at + statement.start,
        at + statement.end,
      );
    }
    const call = topLevelMacroCall(statement);
    if (call !== undefined) topLevel.set(call, statement);
  }

  const found: Partial<Record<TypedMacro, PropsMacroCall>> = {};
  for (const { macro, node } of macroCalls(program)) {
    const range = (): [number, number] => [at + node.start, at + node.end];
    if (macro === 'defineLive') {
      if (spec.kind === 'live') {
        diagnostics.error(
          'sfc.live_definition',
          'defineLive is called once, as a statement of <script>',
          ...range(),
        );
      } else {
        diagnostics.error(
          'sfc.live_outside_components',
          'defineLive belongs to a live component, a .jsails file under components/',
          ...range(),
        );
      }
      continue;
    }
    if (!spec.macros.includes(macro)) {
      diagnostics.error(
        'sfc.macro_position',
        macro === 'defineEmits'
          ? 'defineEmits belongs to an island, a .jsails file under islands/'
          : spec.props === 'load'
            ? "A page's props are what its load export returns"
            : 'This kind of file takes no props macro',
        ...range(),
      );
      continue;
    }
    const propsMacro = macro;
    const statement = topLevel.get(node);
    const typeArguments = node.typeArguments as { params: Node[] } | null | undefined;
    const type = typeArguments?.params.length === 1 ? typeArguments.params[0] : undefined;
    // `emit` is a value the template and setup call, so it is bound to a name.
    const emitsBinding =
      propsMacro !== 'defineEmits' ||
      statement?.type !== 'VariableDeclaration' ||
      ((statement.declarations as Node[])[0]?.id as Node | undefined)?.type === 'Identifier';
    if (
      statement === undefined ||
      type === undefined ||
      (node.arguments as Node[]).length > 0 ||
      !emitsBinding
    ) {
      diagnostics.error(
        'sfc.macro_position',
        propsMacro === 'defineEmits'
          ? 'defineEmits is called once at the top of <script setup> as defineEmits<Events>(), alone or as the value of const emit'
          : `${propsMacro} is called once at the top of <script setup> as ${propsMacro}<Type>(), alone or as a declaration's value`,
        ...range(),
      );
      continue;
    }
    if (found[propsMacro] !== undefined) {
      diagnostics.error('sfc.duplicate_macro', `${propsMacro} is called once`, ...range());
      continue;
    }
    found[propsMacro] = Object.freeze({
      macro: propsMacro,
      type: sourceSpan(at + type.start, at + type.end),
      call: sourceSpan(at + node.start, at + node.end),
      statement:
        statement.type === 'ExpressionStatement'
          ? sourceSpan(at + statement.start, at + statement.end)
          : null,
    });
  }

  const awaits = topLevelAwaits(program);
  if (!spec.mayAwait) {
    for (const node of awaits) {
      diagnostics.error(
        'sfc.await_in_sync_kind',
        'A view renders synchronously; load data in a page and pass it as props',
        at + node.start,
        at + node.end,
      );
    }
  }
  for (const node of spec.hooks ? [] : hookCalls(program)) {
    diagnostics.error(
      'sfc.hooks_outside_island',
      'Hooks run in the browser; use them in an island, a .jsails file under islands/',
      at + node.start,
      at + node.end,
    );
  }

  return Object.freeze({
    hoisted: Object.freeze(hoisted),
    defineProps: found.defineProps ?? null,
    defineSlots: found.defineSlots ?? null,
    defineEmits: found.defineEmits ?? null,
    awaits: awaits.length > 0,
    jsailsImports: jsailsImports(program, block.file),
  });
}

/**
 * The macro call a top-level statement consists of: `macro<T>();` or a
 * `const`/`let` declaration of exactly one binding whose value is the call.
 */
function topLevelMacroCall(statement: Node): Node | undefined {
  const isMacro = (node: Node | null | undefined): node is Node =>
    node?.type === 'CallExpression' &&
    (node.callee as Node).type === 'Identifier' &&
    IMPORTABLE_MACRO.has((node.callee as Node).name as string);
  if (statement.type === 'ExpressionStatement') {
    const expression = statement.expression as Node;
    return isMacro(expression) ? expression : undefined;
  }
  if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
    const declarations = statement.declarations as Node[];
    const init = declarations.length === 1 ? (declarations[0]?.init as Node | null) : null;
    return isMacro(init) ? init : undefined;
  }
  return undefined;
}

/** `await` expressions and `for await` loops outside nested functions. */
function topLevelAwaits(program: Program): readonly Node[] {
  const found: Node[] = [];
  let depth = 0;
  const hooks: Record<string, (node: Node) => void> = {
    AwaitExpression(node) {
      if (depth === 0) found.push(node);
    },
    ForOfStatement(node) {
      if (depth === 0 && node.await === true) found.push(node);
    },
  };
  for (const type of FUNCTION_TYPES) {
    hooks[type] = () => {
      depth += 1;
    };
    hooks[`${type}:exit`] = () => {
      depth -= 1;
    };
  }
  visit(program, hooks);
  return found;
}

/** Calls of a hook (`useState(…)`, a `use` + capital name) anywhere in setup. */
function hookCalls(program: Program): readonly Node[] {
  const found: Node[] = [];
  visit(program, {
    CallExpression(node) {
      const callee = node.callee as Node;
      if (callee.type === 'Identifier' && /^use[A-Z0-9]/.test(callee.name as string)) {
        found.push(node);
      }
    },
  });
  return found;
}
