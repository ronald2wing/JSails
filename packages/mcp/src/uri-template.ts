/**
 * Strict RFC 6570 parsing for resource templates.
 *
 * The SDK's matcher is lenient: it accepts malformed expressions and silently
 * mishandles some valid ones. A template is therefore parsed here at define
 * time against the RFC 6570 grammar and limited to the subset the matcher
 * resolves correctly; everything else is a define-time error instead of a
 * template that never matches. Matched values are percent-decoded before the
 * params schema sees them.
 */

import { McpDefinitionError } from './errors.js';

/** The operators the SDK matcher resolves. */
type Operator = '' | '+' | '#' | '.' | '/' | '?' | '&';

/** One variable of a parsed template. */
export interface TemplateVariable {
  readonly name: string;
  readonly operator: Operator;
  readonly exploded: boolean;
}

/** A parsed template. */
export interface ParsedTemplate {
  readonly template: string;
  readonly variables: readonly TemplateVariable[];
}

const MAX_TEMPLATE_LENGTH = 2048;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** RFC 6570 `varname`: varchars, optionally separated by single dots. */
const VARNAME = /^(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})+(?:\.(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})+)*$/;
/** Characters RFC 6570 forbids in literals (besides `%`, checked separately). */
const FORBIDDEN_LITERAL = /[\x00-\x20\x7F"'<>\\^`|]/;
const SUPPORTED_OPERATORS: ReadonlySet<string> = new Set(['+', '#', '.', '/', '?', '&']);
const RESERVED_OPERATORS: ReadonlySet<string> = new Set(['=', ',', '!', '@', '|', ';']);

function isOperator(character: string): character is Exclude<Operator, ''> {
  return SUPPORTED_OPERATORS.has(character);
}

function fail(reason: string, owner: string): McpDefinitionError {
  return new McpDefinitionError('invalid_uri_template', `the URI template ${reason}`, {
    definition: owner,
  });
}

function checkLiteral(literal: string, owner: string): void {
  if (FORBIDDEN_LITERAL.test(literal) || literal.includes('}')) {
    throw fail('holds a character RFC 6570 forbids in a literal', owner);
  }
  for (let index = literal.indexOf('%'); index !== -1; index = literal.indexOf('%', index + 1)) {
    if (!/^%[0-9A-Fa-f]{2}/.test(literal.slice(index, index + 3))) {
      throw fail('holds a malformed percent-encoding', owner);
    }
  }
}

function parseExpression(body: string, owner: string): TemplateVariable[] {
  if (body.length === 0) {
    throw fail('holds an empty expression', owner);
  }
  const first = body.charAt(0);
  if (RESERVED_OPERATORS.has(first)) {
    throw fail('uses an operator the resource matcher does not support', owner);
  }
  const operator: Operator = isOperator(first) ? first : '';
  const specs = body.slice(operator.length).split(',');
  if (specs.length > 1 && operator !== '?' && operator !== '&') {
    throw fail('lists several variables in one expression outside a query', owner);
  }
  return specs.map((spec) => {
    if (spec.includes(':')) {
      throw fail('uses a prefix modifier, which the resource matcher does not support', owner);
    }
    const exploded = spec.endsWith('*');
    const name = exploded ? spec.slice(0, -1) : spec;
    if (!VARNAME.test(name)) {
      throw fail('holds an invalid variable name', owner);
    }
    return { name, operator, exploded };
  });
}

/** Parse `template`, or throw `invalid_uri_template` naming the broken rule. */
export function parseUriTemplate(template: unknown, owner: string): ParsedTemplate {
  if (typeof template !== 'string' || template.length === 0) {
    throw fail('must be a non-empty string', owner);
  }
  if (template.length > MAX_TEMPLATE_LENGTH) {
    throw fail(`must be at most ${MAX_TEMPLATE_LENGTH} characters`, owner);
  }
  if (!SCHEME.test(template)) {
    throw fail('must start with a literal URI scheme', owner);
  }
  const variables: TemplateVariable[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf('{', cursor);
    const literal = template.slice(cursor, open === -1 ? template.length : open);
    checkLiteral(literal, owner);
    if (open === -1) {
      break;
    }
    const close = template.indexOf('}', open);
    if (close === -1) {
      throw fail('has an unclosed expression', owner);
    }
    const body = template.slice(open + 1, close);
    if (body.includes('{')) {
      throw fail('has a nested expression', owner);
    }
    variables.push(...parseExpression(body, owner));
    cursor = close + 1;
  }
  if (variables.length === 0) {
    throw fail('must hold at least one expression (use a resource for a fixed URI)', owner);
  }
  const names = new Set(variables.map((variable) => variable.name));
  if (names.size !== variables.length) {
    throw fail('names a variable twice', owner);
  }
  return Object.freeze({ template, variables: Object.freeze(variables) });
}

/**
 * Percent-decode the values the matcher captured. Reserved expansions (`+`,
 * `#`) keep reserved characters encoded as written. Returns `undefined` when
 * a value is not valid percent-encoding.
 */
export function decodeVariables(
  parsed: ParsedTemplate,
  matched: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string | string[]> | undefined {
  const decoded: Record<string, string | string[]> = {};
  try {
    for (const variable of parsed.variables) {
      const value = matched[variable.name];
      if (value === undefined) {
        continue;
      }
      const decode =
        variable.operator === '+' || variable.operator === '#' ? decodeURI : decodeURIComponent;
      decoded[variable.name] =
        typeof value === 'string' ? decode(value) : value.map((item) => decode(item));
    }
  } catch (_malformed) {
    return undefined;
  }
  return decoded;
}
