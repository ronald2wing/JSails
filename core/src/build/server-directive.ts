/**
 * The `'use server'` source transform: a pure, fail-closed rewrite that strips
 * server-only code so a module stays safe to import in the browser bundle.
 *
 * The authoring model's seam is normally a *file* boundary (`*.server.ts`,
 * asserted by `cleanBundlePlugin`). This transform offers one more: a module
 * whose prologue is `'use server'` is server code in its entirety, so the
 * client module is *rebuilt* rather than spliced: every top-level function
 * binding becomes a throwing stub, every export is re-exported from those
 * stubs, and everything else — imports, constants, side effects, helpers'
 * bodies — is dropped. An export that cannot be stubbed (a class, an enum, a
 * constant, a re-export of another module) fails the build. Enumerating the
 * safe shapes, rather than the unsafe ones, keeps the rule total: a new export
 * shape cannot slip through by not being listed.
 *
 * A **function-level** directive (`'use server'` as the first statement of a
 * function body in a module without the prologue) is a build error. Stubbing
 * only that body would leave the module's imports, constants, and helpers —
 * the database client, a secret, the code the function calls — in the client
 * bundle. The error tells the author to move the function into a
 * `'use server'` module instead.
 *
 * This adds **no** new way to submit an action. The browser still mutates state
 * only through the signed-snapshot update endpoint (`submit(action)`); the stub
 * exists so the module is safe to *import*, never so the function is *callable*.
 *
 * Fail-closed by construction: a directive is honored only as the module
 * prologue (and, redundantly, at the top of a top-level function in such a
 * module). Anywhere else — a function body in an ordinary module, a nested
 * closure, an object property, a class method, a bare block — is a hard error,
 * not a silent pass: server code the transform cannot remove would otherwise
 * ship to the client.
 *
 * The parser is the bundler's own oxc engine (`rolldown/parseAst`), not the
 * TypeScript compiler API. Two reasons: a consumer's `typescript` may be v7,
 * whose package default export is a version stub with no compiler API (parsing
 * with it crashed every build), and the plugin already runs *inside* the
 * consumer's Vite/Rolldown — so parsing with the same engine the bundler uses
 * removes a version-coupled dependency entirely.
 */

import type { Program } from '@oxc-project/types';
import { RolldownMagicString } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import type { ParserOptions } from 'rolldown/parseAst';

import { JsailsError } from '../errors/jsails-error.js';

/**
 * A source map for a rewritten module. `sourcesContent` is deliberately absent:
 * the original text is exactly what the rewrite exists to keep out of the client.
 */
export interface ServerDirectiveSourceMap {
  readonly version: 3;
  readonly sources: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
}

/** Outcome of {@link stripServerDirectives}. */
export interface ServerDirectiveResult {
  /** The rewritten source (identical to the input when nothing was marked). */
  readonly code: string;
  /** Whether the module carried the file-level `'use server'` directive. */
  readonly hadDirective: boolean;
  /**
   * Names of the exports whose implementations were stubbed, sorted: every
   * export of a `'use server'` module (`default` for a default export). Names
   * are diagnostics only — never secrets.
   */
  readonly stubbed: readonly string[];
  /** A map from `code` back to the input, or `null` when nothing changed. */
  readonly map: ServerDirectiveSourceMap | null;
}

/** Machine-readable reason for a {@link ServerDirectiveError}. */
export type ServerDirectiveErrorCode =
  'unsupported_position' | 'unsupported_export' | 'unsupported_sourcemap' | 'unparseable';

/** Raised when server-only code cannot be kept out of the client module. */
export class ServerDirectiveError extends JsailsError {
  constructor(
    readonly code: ServerDirectiveErrorCode,
    message: string,
    /** The offending function/binding name when known; never source text. */
    readonly subject?: string,
  ) {
    super(message);
  }
}

/** The directive string this transform recognizes. */
const SERVER_DIRECTIVE = 'use server';

/** A module id without its bundler query (`x.tsx?import` -> `x.tsx`). */
function withoutQuery(fileName: string): string {
  return fileName.split('?')[0] ?? fileName;
}

/** Map a filename to the parser's language, so JSX/TSX is disambiguated. */
function langFor(fileName: string): ParserOptions['lang'] {
  const clean = withoutQuery(fileName);
  if (/\.(tsx|mtsx)$/i.test(clean)) {
    return 'tsx';
  }
  if (/\.(jsx|mjsx)$/i.test(clean)) {
    return 'jsx';
  }
  if (/\.(js|mjs|cjs)$/i.test(clean)) {
    return 'js';
  }
  return 'ts';
}

/**
 * A structural view of the few node shapes this transform walks. The oxc AST is
 * a discriminated union; narrowing by `type` on `unknown` keeps the walker
 * honest without importing the whole union.
 */
interface NodeLike {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is NodeLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string';

const asNode = (value: unknown): NodeLike | undefined => (isNode(value) ? value : undefined);

const asNodeArray = (value: unknown): readonly NodeLike[] =>
  Array.isArray(value) ? value.filter(isNode) : [];

/** True when a node is a string directive prologue whose text is `'use server'`. */
function isServerDirective(node: NodeLike | undefined): boolean {
  return node?.type === 'ExpressionStatement' && node.directive === SERVER_DIRECTIVE;
}

/** True when `body[0]` is the file-level `'use server'` directive. */
function hasFileDirective(program: NodeLike): boolean {
  return isServerDirective(asNodeArray(program.body)[0]);
}

/** The identifier name a node binds (`id.name`), or `undefined`. */
function nameOf(node: NodeLike | undefined): string | undefined {
  const id = asNode(node?.id);
  return id?.type === 'Identifier' && typeof id.name === 'string' ? id.name : undefined;
}

/** True for the three function-valued node types. */
function isFunctionNode(node: NodeLike | undefined): boolean {
  return (
    node?.type === 'FunctionDeclaration' ||
    node?.type === 'FunctionExpression' ||
    node?.type === 'ArrowFunctionExpression'
  );
}

/** Build the `{ throw new Error('...') }` replacement block for a stubbed function. */
function stubBlock(name: string): string {
  const message = `server-only function "${name}" was called in the client bundle`;
  return `{ throw new Error(${JSON.stringify(message)}); }`;
}

/** Visit every node in the tree, applying `visit` to each. */
function walk(node: unknown, visit: (node: NodeLike) => void): void {
  const current = asNode(node);
  if (current === undefined) {
    return;
  }
  visit(current);
  for (const [key, value] of Object.entries(current)) {
    if (key === 'parent') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child, visit);
      }
    } else {
      walk(value, visit);
    }
  }
}

/**
 * Assert that every `'use server'` directive sits where the transform can honor
 * it, throwing otherwise. The honored position is the module prologue
 * (`program.body[0]`); under it every top-level function is stubbed whole, so a
 * redundant directive at the top of any top-level function body is honored
 * too. Any other occurrence — mid-body, a bare block, a nested closure, a class
 * method, an object property — is a position the transform cannot rewrite, so
 * it fails closed rather than shipping an inert directive the author believed
 * was active.
 *
 * Validity is computed by collecting the honored statement offsets up front and
 * flagging every directive expression outside that set, so the rule is total:
 * a new shape cannot slip through by not being enumerated.
 */
function assertNoUnsupportedDirective(
  program: NodeLike,
  fileName: string,
  fileLevel: boolean,
): void {
  const statements = asNodeArray(program.body);
  const honored = new Set<number>();
  const honorBody = (body: unknown): void => {
    const first = asNodeArray(asNode(body)?.body)[0];
    if (isDirectiveExpression(first)) {
      honored.add(first.start);
    }
  };
  // Only `program.body[0]` is the module prologue; a directive after any other
  // top-level statement is misplaced and must not be allowlisted.
  const prologue = statements[0];
  if (isDirectiveExpression(prologue)) {
    honored.add(prologue.start);
  }
  if (fileLevel) {
    for (const binding of topLevelFunctions(statements).values()) {
      honorBody(binding.node.body);
    }
  }
  walk(program, (node) => {
    if (isDirectiveExpression(node) && !honored.has(node.start)) {
      throw new ServerDirectiveError(
        'unsupported_position',
        `'use server' must be the first statement of the module (${fileName})`,
      );
    }
  });
}

/**
 * Refuse a function-level directive: a function body that opens with
 * `'use server'` in a module without the prologue. Only that body could be
 * stubbed, while the module's imports, constants, and helpers would still be
 * bundled for the browser.
 */
function assertNoFunctionLevelDirective(program: NodeLike, fileName: string): void {
  walk(program, (node) => {
    if (!isFunctionNode(node)) {
      return;
    }
    const body = asNode(node.body);
    if (body?.type !== 'BlockStatement' || !isDirectiveExpression(asNodeArray(body.body)[0])) {
      return;
    }
    throw new ServerDirectiveError(
      'unsupported_position',
      `a function-level 'use server' directive would leave the module's imports and other code in the client bundle; move the function into a module whose first statement is 'use server' (${fileName})`,
      nameOf(node),
    );
  });
}

/**
 * True when a node is an `ExpressionStatement` whose expression is the
 * `'use server'` string literal — a directive prologue or a misplaced string.
 */
function isDirectiveExpression(node: NodeLike | undefined): node is NodeLike {
  if (node?.type !== 'ExpressionStatement') {
    return false;
  }
  const expression = asNode(node.expression);
  return expression?.type === 'Literal' && expression.value === SERVER_DIRECTIVE;
}

/** Parse to the oxc AST, translating a parser failure into a value-free error. */
function parseModule(code: string, fileName: string): NodeLike {
  try {
    const program: Program = parseAst(
      code,
      { lang: langFor(fileName), sourceType: 'module', astType: 'ts' },
      fileName,
    );
    return program as unknown as NodeLike;
  } catch {
    // The bundler parser's message embeds a source frame (`RolldownError`); the
    // transform's errors must stay value-free, so discard it and report only the
    // file. `cause` is deliberately not attached — it would re-expose the frame.
    throw new ServerDirectiveError('unparseable', `could not parse ${fileName}`);
  }
}

/** A top-level function binding the file-level rewrite replaces with a stub. */
interface FunctionBinding {
  readonly local: string;
  readonly node: NodeLike;
}

/**
 * Every top-level binding whose value is a function, keyed by local name, in
 * source order: `function f() {}` (exported or not, including a named
 * `export default function f`) and each `const`/`let`/`var` declarator whose
 * initializer is a function or arrow. Ambient (`declare`) forms have no body.
 */
function topLevelFunctions(statements: readonly NodeLike[]): Map<string, FunctionBinding> {
  const bindings = new Map<string, FunctionBinding>();
  for (const statement of statements) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
        ? asNode(statement.declaration)
        : statement;
    if (declaration === undefined || declaration.declare === true) {
      continue;
    }
    if (declaration.type === 'FunctionDeclaration' || declaration.type === 'FunctionExpression') {
      const local = nameOf(declaration);
      if (local !== undefined) {
        bindings.set(local, { local, node: declaration });
      }
      continue;
    }
    if (declaration.type !== 'VariableDeclaration') {
      continue;
    }
    for (const declarator of asNodeArray(declaration.declarations)) {
      const local = nameOf(declarator);
      const init = asNode(declarator.init);
      if (local !== undefined && init !== undefined && isFunctionNode(init)) {
        bindings.set(local, { local, node: init });
      }
    }
  }
  return bindings;
}

/** The export name of a specifier's `exported`/`local` node (identifier or string). */
function moduleExportName(node: unknown): string | undefined {
  const value = asNode(node);
  if (value?.type === 'Identifier' && typeof value.name === 'string') {
    return value.name;
  }
  return value?.type === 'Literal' && typeof value.value === 'string' ? value.value : undefined;
}

/** True for declaration types that exist only at the type level. */
function isTypeOnlyDeclaration(declaration: NodeLike): boolean {
  return (
    declaration.declare === true ||
    declaration.type === 'TSDeclareFunction' ||
    declaration.type === 'TSInterfaceDeclaration' ||
    declaration.type === 'TSTypeAliasDeclaration'
  );
}

/** One `export { local as exported }` entry of the rebuilt module. */
interface StubExport {
  readonly exported: string;
  readonly local: string;
}

/** The value-free error for an export the file-level rewrite cannot stub. */
function unsupportedExport(fileName: string, subject?: string): ServerDirectiveError {
  return new ServerDirectiveError(
    'unsupported_export',
    `a 'use server' module may export only functions; found an export that cannot be stubbed (${fileName})`,
    subject,
  );
}

/** The value-free error for a re-export the rewrite cannot follow. */
function unsupportedReExport(fileName: string): ServerDirectiveError {
  return new ServerDirectiveError(
    'unsupported_position',
    `a re-export in a 'use server' module cannot be rewritten (${fileName})`,
  );
}

/**
 * Collect the exports of a file-level server module, throwing on any export the
 * rewrite cannot replace with a stub. Type-only exports are dropped (they have
 * no runtime value); anonymous default functions are returned separately.
 */
function collectStubExports(
  statements: readonly NodeLike[],
  functions: ReadonlyMap<string, FunctionBinding>,
  fileName: string,
): { readonly exports: readonly StubExport[]; readonly anonymousDefault?: NodeLike } {
  const exports: StubExport[] = [];
  let anonymousDefault: NodeLike | undefined;
  const bindLocal = (exported: string, local: string | undefined): void => {
    if (local === undefined || !functions.has(local)) {
      throw unsupportedExport(fileName, exported);
    }
    exports.push({ exported, local });
  };

  for (const statement of statements) {
    if (statement.type === 'ExportAllDeclaration') {
      if (statement.exportKind !== 'type') {
        throw unsupportedReExport(fileName);
      }
      continue;
    }
    if (statement.type === 'TSExportAssignment') {
      throw unsupportedExport(fileName);
    }
    if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = asNode(statement.declaration);
      if (declaration === undefined || isTypeOnlyDeclaration(declaration)) {
        continue;
      }
      if (isFunctionNode(declaration)) {
        const local = nameOf(declaration);
        if (local === undefined) {
          anonymousDefault = declaration;
        } else {
          bindLocal('default', local);
        }
        continue;
      }
      bindLocal(
        'default',
        declaration.type === 'Identifier' ? moduleExportName(declaration) : undefined,
      );
      continue;
    }
    if (statement.type !== 'ExportNamedDeclaration') {
      continue;
    }
    if (asNode(statement.source) !== undefined) {
      if (statement.exportKind !== 'type') {
        throw unsupportedReExport(fileName);
      }
      continue;
    }
    if (statement.exportKind === 'type') {
      continue;
    }
    const declaration = asNode(statement.declaration);
    if (declaration === undefined) {
      for (const specifier of asNodeArray(statement.specifiers)) {
        if (specifier.exportKind === 'type') {
          continue;
        }
        const exported = moduleExportName(specifier.exported) ?? '<anonymous>';
        bindLocal(exported, moduleExportName(specifier.local));
      }
      continue;
    }
    if (isTypeOnlyDeclaration(declaration)) {
      continue;
    }
    if (declaration.type === 'FunctionDeclaration') {
      const local = nameOf(declaration);
      bindLocal(local ?? '<anonymous>', local);
      continue;
    }
    if (declaration.type === 'VariableDeclaration') {
      for (const declarator of asNodeArray(declaration.declarations)) {
        const local = nameOf(declarator);
        bindLocal(local ?? '<anonymous>', local);
      }
      continue;
    }
    // A class, enum, or runtime namespace has a value no stub can stand in for.
    throw unsupportedExport(fileName, nameOf(declaration));
  }
  return anonymousDefault === undefined ? { exports } : { exports, anonymousDefault };
}

/** The `async function*` head matching the original function's kind. */
function stubHead(node: NodeLike): string {
  const asyncPrefix = node.async === true ? 'async ' : '';
  return `${asyncPrefix}function${node.generator === true ? '*' : ''}`;
}

/** An export name as it may appear in an `export { … }` clause. */
function exportClauseName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** Render the rebuilt client module for a file-level server module. */
function renderStubModule(
  functions: ReadonlyMap<string, FunctionBinding>,
  exports: readonly StubExport[],
  anonymousDefault: NodeLike | undefined,
): string {
  const lines: string[] = [];
  for (const binding of functions.values()) {
    lines.push(`${stubHead(binding.node)} ${binding.local}() ${stubBlock(binding.local)}`);
  }
  if (anonymousDefault !== undefined) {
    lines.push(`export default ${stubHead(anonymousDefault)} () ${stubBlock('default')}`);
  }
  if (exports.length > 0) {
    const clause = exports
      .map(({ exported, local }) =>
        exported === local ? local : `${local} as ${exportClauseName(exported)}`,
      )
      .join(', ');
    lines.push(`export { ${clause} };`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Turn a finished splice into the value-free map the result carries. */
function mapOf(magic: RolldownMagicString, fileName: string): ServerDirectiveSourceMap {
  const generated = magic.generateMap({ hires: true, source: withoutQuery(fileName) });
  // Not frozen: the bundler normalizes a transform map in place (Rolldown adds
  // `sourcesContent`).
  return {
    version: 3,
    sources: [...generated.sources],
    names: [...generated.names],
    mappings: generated.mappings,
  };
}

/**
 * Rebuild a module as file-level server code: stubs for every top-level
 * function, the original export names re-bound to them, nothing else.
 */
function stubWholeModule(program: NodeLike, code: string, fileName: string): ServerDirectiveResult {
  const statements = asNodeArray(program.body);
  const functions = topLevelFunctions(statements);
  const { exports, anonymousDefault } = collectStubExports(statements, functions, fileName);
  const rendered = renderStubModule(functions, exports, anonymousDefault);

  const stubbed = exports.map((entry) => entry.exported);
  if (anonymousDefault !== undefined) {
    stubbed.push('default');
  }
  stubbed.sort();

  if (code.length === 0) {
    return { code: rendered, hadDirective: true, stubbed, map: null };
  }
  const magic = new RolldownMagicString(code);
  magic.overwrite(0, code.length, rendered.length > 0 ? rendered : '\n');
  return { code: magic.toString(), hadDirective: true, stubbed, map: mapOf(magic, fileName) };
}

/**
 * Rewrite a `'use server'` module as its client form, returning the rewritten
 * source plus diagnostics. Pure: the same input yields the same output, no
 * filesystem or bundler access. A module without the prologue is returned
 * unchanged.
 *
 * Throws {@link ServerDirectiveError} when the source cannot be parsed, a
 * directive sits anywhere but the module prologue (a function-level directive
 * included), or a `'use server'` module exports something that cannot be
 * stubbed — never ships server code silently.
 */
export function stripServerDirectives(code: string, fileName: string): ServerDirectiveResult {
  const program = parseModule(code, fileName);
  const fileLevel = hasFileDirective(program);

  // Fail-closed: scan for a directive in any position this transform cannot
  // rewrite, whether or not a top-level directive was found.
  if (!fileLevel) {
    assertNoFunctionLevelDirective(program, fileName);
  }
  assertNoUnsupportedDirective(program, fileName, fileLevel);

  if (fileLevel) {
    return stubWholeModule(program, code, fileName);
  }
  return { code, hadDirective: false, stubbed: [], map: null };
}

/**
 * Rewrite `code` as file-level server code whether or not it carries the
 * `'use server'` prologue, for a module that is server-only by its name (a
 * component's `.server.ts`), so its client form never depends on the author
 * remembering a directive.
 */
export function stubServerOnlyModule(code: string, fileName: string): ServerDirectiveResult {
  const program = parseModule(code, fileName);
  assertNoUnsupportedDirective(program, fileName, true);
  return stubWholeModule(program, code, fileName);
}
