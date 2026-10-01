/**
 * Extract translation keys from compiled JavaScript/ESM source.
 *
 * Scans an AST for the framework's translation call sites and returns the
 * statically-resolvable dotted keys (with `scope` folded) plus a count of
 * dynamic calls whose key cannot be resolved without running the code. The
 * parser is rolldown's `parseSync` (oxc), the same one the compiler uses; only
 * the JSails-specific recognition lives here.
 *
 * Recognized call sites:
 *   - the `I18n` facade global: `I18n.t`, `I18n.tChoice`, `I18n.exists`
 *   - imported bare helpers: `t`, `choice` (from `jsails/i18n/server`)
 *
 * `l`/`localize` are localization, not keys, and are deliberately ignored.
 * `import * as i18n from ...` and dynamic keys are documented limits.
 */

import { parseSync, type ESTree } from 'rolldown/utils';

type Node = ESTree.Node;
type Argument = ESTree.Argument;

/** A statically-resolved key reference. */
interface KeyRef {
  /** The resolved dotted key (scope folded). */
  readonly key: string;
  /** 1-based source line of the call. */
  readonly line: number;
}

/** The result of scanning one module. */
interface ExtractionResult {
  readonly refs: readonly KeyRef[];
  /** Calls that looked like translation calls but had a non-static key/scope. */
  readonly dynamic: number;
}

/** Subpath that exports the bare `t`/`choice`/`l` helpers. */
const I18N_SERVER_SUBPATH = 'jsails/i18n/server';

/** The `I18n` facade methods that reference a translation key. */
const FACADE_KEY_METHODS = new Set(['t', 'tChoice', 'exists']);

/** The bare helpers that reference a translation key. */
const BARE_KEY_HELPERS = new Set(['t', 'choice']);

/** Methods whose options object is at argument index 1 (`t`, `exists`). */
const OPTIONS_AT_ONE = new Set(['t', 'exists']);
/** Methods whose options object is at argument index 2 (`tChoice`, `choice`). */
const OPTIONS_AT_TWO = new Set(['tChoice', 'choice']);

/**
 * Extract translation keys from compiled module source. `dynamic` counts calls
 * that look like translation calls but whose key or scope is not a static
 * literal, so a caller can surface them as unscanned rather than silently wrong.
 * Unparseable source yields an empty result (the caller reports the file).
 */
export function extractTranslationKeys(source: string): ExtractionResult {
  const parsed = parseSync('module.js', source, { sourceType: 'module' });
  if (parsed.errors.some((error) => error.severity === 'Error')) {
    return { refs: [], dynamic: 0 };
  }

  const lineOf = lineLocator(source);
  const refs: KeyRef[] = [];
  let dynamic = 0;
  const importedBare = new Set<string>();

  const walk = (node: Node): void => {
    if (node.type === 'ImportDeclaration') {
      collectImportedBare(node, importedBare);
    } else if (node.type === 'CallExpression') {
      const resolved = resolveCall(node, importedBare);
      if (resolved !== null) {
        if (resolved === undefined) {
          dynamic += 1;
        } else {
          refs.push({ key: resolved, line: lineOf(node.start) });
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isNode(child)) walk(child);
        }
      } else if (isNode(value)) {
        walk(value);
      }
    }
  };

  walk(parsed.program);
  return { refs, dynamic };
}

/** Map a source offset to its 1-based line number. */
function lineLocator(source: string): (offset: number) => number {
  const lineStarts = [0];
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) {
    lineStarts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle] as number) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/** Type guard for ESTree nodes reached through an untyped child walk. */
function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** Record bare `t`/`choice` helpers imported from the i18n server subpath. */
function collectImportedBare(decl: ESTree.ImportDeclaration, importedBare: Set<string>): void {
  if (decl.source.value !== I18N_SERVER_SUBPATH) return;
  for (const spec of decl.specifiers) {
    if (spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier') {
      if (BARE_KEY_HELPERS.has(spec.imported.name)) {
        importedBare.add(spec.imported.name);
      }
    }
  }
}

/**
 * Resolve a call expression to a dotted key. Returns:
 *   - a string: the scope-folded key
 *   - `undefined`: recognized call whose key/scope was not static (dynamic)
 *   - `null`: not a translation call (skip, do not count as dynamic)
 */
function resolveCall(
  call: ESTree.CallExpression,
  importedBare: ReadonlySet<string>,
): string | null | undefined {
  const callee = call.callee;
  const args = call.arguments;

  let method: string | undefined;

  if (callee.type === 'MemberExpression' && !callee.computed) {
    if (
      callee.object.type === 'Identifier' &&
      callee.object.name === 'I18n' &&
      callee.property.type === 'Identifier'
    ) {
      method = callee.property.name;
      if (!FACADE_KEY_METHODS.has(method)) return null;
    } else {
      return null;
    }
  } else if (callee.type === 'Identifier') {
    method = callee.name;
    if (!importedBare.has(method)) return null;
  } else {
    return null;
  }

  const optionsIndex = OPTIONS_AT_ONE.has(method) ? 1 : OPTIONS_AT_TWO.has(method) ? 2 : -1;
  if (optionsIndex === -1) return null;

  const key = literalString(args[0]);
  if (key === undefined) return undefined;

  const scope = resolveScope(args[optionsIndex]);
  if (scope === undefined) return undefined;

  return scope === null ? key : [...scope, key].join('.');
}

/** Extract the string value of a literal argument, or `undefined`. */
function literalString(arg: Argument | undefined): string | undefined {
  if (arg?.type === 'Literal' && typeof arg.value === 'string') {
    return arg.value;
  }
  return undefined;
}

/**
 * Resolve a `scope` option from the options argument. Returns the scope
 * segments, `null` when there is no `scope` option, or `undefined` when the
 * `scope` is present but not a static literal (dynamic).
 */
function resolveScope(optionsArg: Argument | undefined): readonly string[] | null | undefined {
  if (optionsArg === undefined || optionsArg.type !== 'ObjectExpression') {
    return null;
  }
  const object = optionsArg;
  for (const prop of object.properties) {
    if (prop.type !== 'Property' || prop.computed) continue;
    if (propertyKeyName(prop) !== 'scope') continue;

    const value = prop.value;
    if (value.type === 'Literal' && typeof value.value === 'string') {
      return value.value.split('.');
    }
    if (value.type === 'ArrayExpression') {
      return arrayLiteralParts(value);
    }
    return undefined;
  }
  return null;
}

function propertyKeyName(prop: ESTree.ObjectProperty): string | undefined {
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return undefined;
}

/** Extract a `scope` array's string parts, or `undefined` when not all static. */
function arrayLiteralParts(value: ESTree.ArrayExpression): readonly string[] | undefined {
  const parts: string[] = [];
  for (const element of value.elements) {
    if (element === null || element.type !== 'Literal' || typeof element.value !== 'string') {
      return undefined;
    }
    parts.push(element.value);
  }
  return parts;
}
