/**
 * TypeScript checks for the code a `.jsails` template embeds: `{{ }}`
 * interpolations, bound attribute values, event handlers and `js-for`
 * aliases, each validated by oxc as the exact construct the shadow module
 * will hold (a TSX expression, a statement list, an arrow parameter list).
 *
 * The end of an interpolation is found by parsing, not by the first `}}`: the
 * first `}}` after which the text is one complete expression ends it, so a
 * string or template literal holding `}}` stays inside. oxc's messages may
 * quote source, so only its error position is kept (docs/design/sfc.md §8.2).
 *
 * Each wrapper closes on the same line as the code's last token, so code that
 * ends in a `//` comment is rejected: the comment would swallow whatever the
 * lowering writes after the code (`{a // c}` is not an expression container).
 */

import { parseSync } from 'rolldown/utils';

/** Where a checked piece of code failed, as an absolute offset in the file. */
export interface CodeError {
  readonly offset: number;
}

interface ParsedWrapper {
  readonly body: readonly unknown[];
  readonly errorAt: number | undefined;
}

interface NodeShape {
  readonly type?: string;
  readonly start?: number;
  readonly end?: number;
  readonly expression?: NodeShape;
  readonly body?: NodeShape;
}

function parseWrapper(text: string): ParsedWrapper {
  const result = parseSync('template.tsx', text, { sourceType: 'module', lang: 'tsx' });
  const error = result.errors.find((entry) => entry.severity === 'Error');
  if (error === undefined) {
    return { body: result.program.body, errorAt: undefined };
  }
  const label = error.labels[0];
  return { body: result.program.body, errorAt: label === undefined ? 0 : label.start };
}

/** Map a wrapper offset back into the code, clamped to the code's range. */
function codeError(errorAt: number, prefix: number, code: string, at: number): CodeError {
  return { offset: at + Math.min(Math.max(errorAt - prefix, 0), code.length) };
}

/** The only statement of a parsed wrapper, when there is exactly one. */
function onlyExpression(body: readonly unknown[]): NodeShape | undefined {
  if (body.length !== 1) {
    return undefined;
  }
  const statement = body[0] as NodeShape;
  return statement.type === 'ExpressionStatement' ? statement.expression : undefined;
}

/**
 * Check that `code` (which starts at offset `at` in its file) is exactly one
 * TSX expression. Returns the failure position, or `undefined` when valid.
 */
export function checkExpression(code: string, at: number): CodeError | undefined {
  if (code.trim() === '') {
    return { offset: at };
  }
  const wrapper = `(${code.trimEnd()})`;
  const parsed = parseWrapper(wrapper);
  if (parsed.errorAt !== undefined) {
    return codeError(parsed.errorAt, 1, code, at);
  }
  const expression = onlyExpression(parsed.body);
  if (
    expression?.type !== 'ParenthesizedExpression' ||
    expression.start !== 0 ||
    expression.end !== wrapper.length
  ) {
    return { offset: at };
  }
  return undefined;
}

/**
 * Check that `code` is a statement list an event handler may hold
 * (`count++; save()`): the body of one arrow function and nothing more.
 */
export function checkStatements(code: string, at: number): CodeError | undefined {
  const prefix = '() => {';
  const wrapper = `${prefix}${code.trimEnd()}}`;
  const parsed = parseWrapper(wrapper);
  if (parsed.errorAt !== undefined) {
    return codeError(parsed.errorAt, prefix.length, code, at);
  }
  const arrow = onlyExpression(parsed.body);
  if (
    arrow?.type !== 'ArrowFunctionExpression' ||
    arrow.body?.type !== 'BlockStatement' ||
    arrow.body.end !== wrapper.length
  ) {
    return { offset: at };
  }
  return undefined;
}

/**
 * Check that `code` is an arrow parameter list without its parentheses
 * (`item, index`, `{ id, name }`, `[key, value]`).
 */
export function checkParameters(code: string, at: number): CodeError | undefined {
  if (code.trim() === '') {
    return { offset: at };
  }
  const wrapper = `(${code.trimEnd()}) => 0`;
  const parsed = parseWrapper(wrapper);
  if (parsed.errorAt !== undefined) {
    return codeError(parsed.errorAt, 1, code, at);
  }
  const arrow = onlyExpression(parsed.body);
  if (
    arrow?.type !== 'ArrowFunctionExpression' ||
    arrow.start !== 0 ||
    arrow.body?.start !== wrapper.length - 1
  ) {
    return { offset: at };
  }
  return undefined;
}

/** How far an interpolation search looks before it gives up. */
const MAX_INTERPOLATION_CANDIDATES = 256;

/** The result of looking for the end of a `{{ … }}` interpolation. */
export type InterpolationEnd =
  | { readonly kind: 'end'; readonly closeAt: number }
  | { readonly kind: 'empty'; readonly closeAt: number }
  | { readonly kind: 'invalid'; readonly closeAt: number; readonly offset: number }
  | { readonly kind: 'unterminated' };

/**
 * Find the `}}` that ends the interpolation whose code starts at `codeStart`
 * (just past `{{`), searching up to `limit`: the first `}}` before which the
 * code is one complete expression. When no candidate parses, the first
 * candidate is reported with the parse failure, since it is the end the author
 * most likely meant.
 */
export function findInterpolationEnd(
  source: string,
  codeStart: number,
  limit: number,
): InterpolationEnd {
  let first: InterpolationEnd | undefined;
  let candidates = 0;
  let closeAt = source.indexOf('}}', codeStart);
  while (closeAt !== -1 && closeAt + 2 <= limit && candidates < MAX_INTERPOLATION_CANDIDATES) {
    candidates += 1;
    const code = source.slice(codeStart, closeAt);
    if (code.trim() === '') {
      return { kind: 'empty', closeAt };
    }
    const error = checkExpression(code, codeStart);
    if (error === undefined) {
      return { kind: 'end', closeAt };
    }
    first ??= { kind: 'invalid', closeAt, offset: error.offset };
    closeAt = source.indexOf('}}', closeAt + 1);
  }
  return first ?? { kind: 'unterminated' };
}
