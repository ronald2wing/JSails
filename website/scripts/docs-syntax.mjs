/**
 * Syntax facts about one docs fence, read from TypeScript's parser instead of
 * pattern-matching its text, so an import or an assertion that only appears in
 * a comment or a string never counts: the module specifiers the fence imports,
 * the declarations that would reach other fences compiled in the same program
 * (`declare global`, `declare module '…'`, triple-slash references), and
 * whether it asserts. The parser recovers from syntax errors, so a fence that
 * does not compile still yields facts.
 *
 * The parser is the `typescript` package the repo installs for
 * typescript-eslint, resolved from the checkout root so the website's own
 * install never substitutes another copy.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

import { repoRoot } from '../../scripts/workspaces.mjs';

const ts = createRequire(join(repoRoot, 'package.json'))('typescript');

const SCRIPT_KINDS = Object.freeze({
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
});

/** The modules whose imports make a fence's calls assertions. */
const ASSERT_MODULES = new Set(['node:assert', 'node:assert/strict', 'assert', 'assert/strict']);

/** The module specifier a node imports from, or `undefined`. */
function importedSpecifier(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const { expression } = node.moduleReference;
    return ts.isStringLiteral(expression) ? expression.text : undefined;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const [argument] = node.arguments;
    return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    const { literal } = node.argument;
    return ts.isStringLiteral(literal) ? literal.text : undefined;
  }
  return undefined;
}

/** The local names an import of an assertion module binds. */
function assertBindings(node) {
  if (ts.isImportEqualsDeclaration(node)) return [node.name.text];
  const clause = node.importClause;
  if (clause === undefined) return [];
  const names = clause.name === undefined ? [] : [clause.name.text];
  const bindings = clause.namedBindings;
  if (bindings === undefined) return names;
  if (ts.isNamespaceImport(bindings)) return [...names, bindings.name.text];
  return [...names, ...bindings.elements.map((element) => element.name.text)];
}

/** The identifier a call's callee chain starts from (`assert` in `assert.deepEqual`). */
function calleeRoot(expression) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

/** Whether a callee is `<context>.assert.<method>`, the test context's assertions. */
function isContextAssertion(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'assert'
  );
}

/** The declarations of a parsed file that reach every file of its program. */
function sharedScopeDeclarations(sourceFile) {
  const shared = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isModuleDeclaration(statement)) continue;
    if (statement.flags & ts.NodeFlags.GlobalAugmentation) shared.push('declare global');
    else if (ts.isStringLiteral(statement.name)) {
      shared.push(`declare module '${statement.name.text}'`);
    }
  }
  for (const reference of sourceFile.referencedFiles) {
    shared.push(`/// <reference path="${reference.fileName}" />`);
  }
  for (const reference of sourceFile.typeReferenceDirectives) {
    shared.push(`/// <reference types="${reference.fileName}" />`);
  }
  for (const reference of sourceFile.libReferenceDirectives) {
    shared.push(`/// <reference lib="${reference.fileName}" />`);
  }
  return shared;
}

/**
 * The syntax facts of one fence: `{ imports, shared, asserts }`.
 * - `imports`: every module specifier it imports, re-exports, `import()`s, or
 *   names in an `import('…')` type;
 * - `shared`: its declarations that reach other files of the same program,
 *   described as written (empty for a self-contained module);
 * - `asserts`: whether it calls a binding imported from `node:assert` (or
 *   `node:assert/strict`), or a test context's `t.assert.<method>()`.
 */
export function fenceSyntax(body, extension = '.ts') {
  const kind = SCRIPT_KINDS[extension] ?? ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    `fence${extension}`,
    body,
    ts.ScriptTarget.Latest,
    false,
    kind,
  );
  const imports = new Set();
  const assertNames = new Set();
  const calls = [];
  const visit = (node) => {
    const specifier = importedSpecifier(node);
    if (specifier !== undefined) {
      imports.add(specifier);
      if (
        ASSERT_MODULES.has(specifier) &&
        (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node))
      ) {
        for (const name of assertBindings(node)) assertNames.add(name);
      }
    }
    if (ts.isCallExpression(node)) calls.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const asserts = calls.some(
    (callee) => assertNames.has(calleeRoot(callee)) || isContextAssertion(callee),
  );
  return { imports, shared: sharedScopeDeclarations(sourceFile), asserts };
}
