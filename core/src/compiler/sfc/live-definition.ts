/**
 * The `defineLive({ … })` call of a live component's `<script>` (sfc-plan
 * §2.3, §2.7): where it is, and what the lowering needs to read from it at
 * compile time.
 *
 * The call is one top-level statement, and its argument is an object literal
 * with static keys and no spread, because the lowering moves its properties
 * into the compiled definition and reads two things from it: the
 * `stateSchema` value, which becomes the schema-first argument that types
 * everything else, and the keys of `derived`, which are the template's kind
 * names. `name`, `render` and `staticFallback` are the compiler's: the id
 * comes from the path and both renders from the template blocks. Offsets are
 * offsets into the file.
 */

import type { ESTree } from 'rolldown/utils';

import type { SfcBlock } from './blocks.js';
import type { SfcDiagnostics } from './diagnostics.js';
import { macroCalls, parseBlock } from './script-analysis.js';
import { sourceSpan, type SourceSpan } from './source-span.js';

/** What the lowering reads from `defineLive({ … })`. */
export interface LiveDefinition {
  /** The whole `defineLive(…);` statement, cut from the module. */
  readonly statement: SourceSpan;
  /** The call, which owns the generated definition. */
  readonly call: SourceSpan;
  /** The `stateSchema` property's value. */
  readonly stateSchema: SourceSpan;
  /** Every other property, in source order, copied into the definition. */
  readonly properties: readonly SourceSpan[];
  /** The keys of `derived`: the template's kind names besides the tools'. */
  readonly derived: readonly string[];
  /** The `staticRender` property, when present. */
  readonly staticRender: SourceSpan | null;
}

/** Keys the compiler writes itself. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['name', 'render', 'staticFallback']);

/** Names the render tools bind in every live template. */
export const LIVE_TOOL_NAMES: readonly string[] = Object.freeze(['errors', 'values', 'context']);

type Node = { type: string; start: number; end: number; [key: string]: unknown };

/**
 * Analyse the `defineLive` call of `block` (a live component's `<script>`).
 * Returns `undefined` after reporting when there is none or it breaks a rule;
 * `owner` (the template's start tag) owns the report of a missing call.
 */
export function analyseLiveDefinition(
  block: SfcBlock | null,
  owner: SourceSpan,
  diagnostics: SfcDiagnostics,
): LiveDefinition | undefined {
  const missing = (): undefined => {
    diagnostics.error(
      'sfc.live_definition',
      'A live component calls defineLive({ stateSchema, … }) as a statement of <script>',
      owner.start,
      owner.end,
    );
    return undefined;
  };
  if (block === null) return missing();
  const program = parseBlock(block);
  if (program === undefined) return undefined;
  const at = block.contentStart;
  const report = (message: string, node: { start: number; end: number }): undefined => {
    diagnostics.error('sfc.live_definition', message, at + node.start, at + node.end);
    return undefined;
  };

  let found: { statement: Node; call: Node } | undefined;
  for (const statement of program.body as unknown as Node[]) {
    const expression =
      statement.type === 'ExpressionStatement' ? (statement.expression as Node) : null;
    const callee = expression?.type === 'CallExpression' ? (expression.callee as Node) : null;
    if (expression === null || callee?.type !== 'Identifier' || callee.name !== 'defineLive') {
      continue;
    }
    if (found !== undefined) return report('defineLive is called once', expression);
    found = { statement, call: expression };
  }
  for (const { macro, node } of macroCalls(program)) {
    if (macro === 'defineLive' && node !== found?.call) {
      return report('defineLive is called once, as a statement of <script>', node);
    }
  }
  if (found === undefined) return missing();

  const { call } = found;
  const args = call.arguments as Node[];
  if (call.typeArguments !== null && call.typeArguments !== undefined) {
    return report('The state type comes from stateSchema; defineLive takes no type argument', call);
  }
  const argument = args.length === 1 ? args[0] : undefined;
  if (argument?.type !== 'ObjectExpression') {
    return report('defineLive takes one object literal', call);
  }

  const seen = new Set<string>();
  const properties: SourceSpan[] = [];
  let stateSchema: SourceSpan | undefined;
  let derived: readonly string[] = [];
  let staticRender: SourceSpan | null = null;
  for (const property of argument.properties as Node[]) {
    const key = staticKey(property);
    if (key === undefined) {
      return report('A defineLive property has a static key; no spread or computed key', property);
    }
    if (seen.has(key)) return report('This defineLive property is set twice', property);
    seen.add(key);
    if (RESERVED_KEYS.has(key)) {
      return report(
        'The compiler sets name from the path, render from <template> and staticFallback from <template static>',
        property.key as Node,
      );
    }
    if (key === 'stateSchema') {
      if (property.kind !== 'init' || property.method === true) {
        return report('stateSchema is a schema value', property);
      }
      const value = property.value as Node;
      stateSchema = sourceSpan(at + value.start, at + value.end);
      continue;
    }
    if (key === 'derived') {
      const keys = derivedKeys(property);
      if (keys === undefined) {
        return report(
          'derived is an object literal with static keys: its keys are the template’s names',
          property,
        );
      }
      const clash = keys.find((name) => LIVE_TOOL_NAMES.includes(name));
      if (clash !== undefined) {
        return report('A derived property is not named errors, values or context', property);
      }
      derived = keys;
    }
    if (key === 'staticRender') staticRender = sourceSpan(at + property.start, at + property.end);
    properties.push(sourceSpan(at + property.start, at + property.end));
  }
  if (stateSchema === undefined) {
    return report('A live component declares its state with stateSchema', call);
  }
  return Object.freeze({
    statement: sourceSpan(at + found.statement.start, at + found.statement.end),
    call: sourceSpan(at + call.start, at + call.end),
    stateSchema,
    properties: Object.freeze(properties),
    derived: Object.freeze([...derived]),
    staticRender,
  });
}

/** A property's key when it is static (`a`, `'a'`), not a spread or computed. */
function staticKey(property: Node): string | undefined {
  if (property.type !== 'Property' || property.computed === true) return undefined;
  const key = property.key as Node;
  if (key.type === 'Identifier') return key.name as string;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return undefined;
}

/** The static keys of `derived: { … }`, or `undefined` when it is not such a literal. */
function derivedKeys(property: Node): readonly string[] | undefined {
  const value = property.value as ESTree.Expression;
  if (property.kind !== 'init' || property.method === true || value.type !== 'ObjectExpression') {
    return undefined;
  }
  const keys: string[] = [];
  for (const entry of value.properties as unknown as Node[]) {
    const key = staticKey(entry);
    if (key === undefined) return undefined;
    keys.push(key);
  }
  return keys;
}
