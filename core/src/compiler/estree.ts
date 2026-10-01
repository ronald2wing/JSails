/**
 * Minimal ESTree view over rolldown's parsed program: the one `parseModule`
 * front end every scanner shares, plus the structural guards they walk the
 * untyped program with.
 *
 * The parser is the bundler's own oxc engine (`rolldown/utils`), not the
 * TypeScript compiler API: a consumer's `typescript` may be v7, whose package
 * default export is a version stub with no compiler API, and the build already
 * runs inside the consumer's Vite/Rolldown, so parsing with the same engine
 * removes a version-coupled dependency entirely.
 */

import { basename } from 'node:path';

import { parseSync } from 'rolldown/utils';

import { CompilerError } from './errors.js';

const MODULE_EXTENSION = /\.(ts|tsx|mts|mtsx|js|jsx)$/;

/** Options for {@link parseModule}. */
export interface ParseModuleOptions {
  /**
   * The extension assumed when `fileName` has none the parser recognizes. The
   * parser infers the language from the extension, so a name such as
   * `widget.tsx-part` would otherwise parse as plain JavaScript and turn
   * `type X = ...` into a syntax error.
   */
  readonly fallbackExtension?: '.ts' | '.tsx';
}

/**
 * Parse a module to its ESTree program. The parser is error-tolerant and its
 * error objects embed a source code frame, so a hard syntax error is refused
 * as a value-free `CompilerError` (`unparseable`) naming only the file.
 */
export function parseModule(
  code: string,
  fileName: string,
  options: ParseModuleOptions = {},
): EstreeNode {
  const parsedName =
    options.fallbackExtension !== undefined && !MODULE_EXTENSION.test(fileName)
      ? fileName + options.fallbackExtension
      : fileName;
  const result = parseSync(parsedName, code, { sourceType: 'module' });
  if (result.errors.some((error) => error.severity === 'Error')) {
    const file = basename(fileName);
    throw new CompilerError('unparseable', `could not parse ${file}`, file);
  }
  return result.program as unknown as EstreeNode;
}

export interface EstreeNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export function asNode(value: unknown): EstreeNode | undefined {
  return value !== null &&
    typeof value === 'object' &&
    typeof (value as EstreeNode).type === 'string'
    ? (value as EstreeNode)
    : undefined;
}

export function asNodeArray(value: unknown): EstreeNode[] {
  return Array.isArray(value) ? (value as EstreeNode[]) : [];
}

export function nodeName(node: EstreeNode | undefined): string | undefined {
  return typeof node?.name === 'string' ? node.name : undefined;
}
