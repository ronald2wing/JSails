/**
 * The inverse of strict lowering: {@link restoreValue} turns a value the model
 * produced against a lowered schema back into the shape the original schema
 * expects.
 *
 * OpenAI strict mode requires every property, so lowering turns an optional,
 * non-nullable property into a required `T | null`. A restore plan, recorded
 * while lowering, says which properties to drop when the model sent `null`.
 * Union branches are chosen with {@link matchesLowered}, a validator for the
 * small keyword subset strict lowering emits, so the plan of the branch the
 * value actually satisfies is the one applied. Zod validates the restored
 * value afterwards; restore never makes an invalid value valid.
 */

import { isPlainObject } from '../content/json-value.js';

/** A JSON Schema object. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** How to restore a value produced against a lowered schema node. */
export type RestorePlan =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'object';
      readonly properties: Readonly<
        Record<string, { readonly plan: RestorePlan; readonly dropNull: boolean }>
      >;
    }
  | { readonly kind: 'array'; readonly items: RestorePlan }
  | {
      readonly kind: 'union';
      readonly branches: readonly { readonly schema: JsonSchema; readonly plan: RestorePlan }[];
    }
  | { readonly kind: 'ref'; readonly ref: string };

/** The plan that leaves a value as it is. */
export const NO_RESTORE: RestorePlan = Object.freeze({ kind: 'none' });

/** A lowered schema with the plans of its recursive definitions. */
export interface RestoreScope {
  /** The whole lowered schema, for resolving `$ref`. */
  readonly root: JsonSchema;
  readonly rootPlan: RestorePlan;
  readonly defPlans: ReadonlyMap<string, RestorePlan>;
}

const MAX_DEPTH = 256;

/** The definition name a local `$ref` names, `''` for the root, or `undefined`. */
export function refName(ref: string): string | undefined {
  if (ref === '#') return '';
  for (const prefix of ['#/$defs/', '#/definitions/']) {
    if (ref.startsWith(prefix)) {
      const encoded = ref.slice(prefix.length);
      if (encoded.length === 0 || encoded.includes('/')) return undefined;
      let decoded: string;
      try {
        decoded = decodeURIComponent(encoded);
      } catch {
        return undefined;
      }
      return decoded.replaceAll('~1', '/').replaceAll('~0', '~');
    }
  }
  return undefined;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  const name = refName(ref);
  if (name === undefined) return undefined;
  if (name === '') return root;
  const defs = root.$defs;
  if (!isPlainObject(defs)) return undefined;
  const target = defs[name];
  return isPlainObject(target) ? target : undefined;
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

const patternCache = new Map<string, RegExp | null>();
const MAX_CACHED_PATTERNS = 1_024;

/** The compiled `pattern`, or `null` when it does not compile (it is then not checked). */
function compiledPattern(pattern: string): RegExp | null {
  let compiled = patternCache.get(pattern);
  if (compiled === undefined) {
    try {
      compiled = new RegExp(pattern, 'u');
    } catch {
      compiled = null;
    }
    if (patternCache.size >= MAX_CACHED_PATTERNS) patternCache.clear();
    patternCache.set(pattern, compiled);
  }
  return compiled;
}

function isMultiple(value: number, step: number): boolean {
  const quotient = value / step;
  return Math.abs(quotient - Math.round(quotient)) <= 1e-9 * Math.max(1, Math.abs(quotient));
}

function matchesNumber(value: number, node: JsonSchema): boolean {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = node;
  if (typeof minimum === 'number' && value < minimum) return false;
  if (typeof maximum === 'number' && value > maximum) return false;
  if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) return false;
  if (typeof exclusiveMaximum === 'number' && value >= exclusiveMaximum) return false;
  if (typeof multipleOf === 'number' && multipleOf > 0 && !isMultiple(value, multipleOf)) {
    return false;
  }
  return true;
}

function matchesNode(value: unknown, node: JsonSchema, root: JsonSchema, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (typeof node.$ref === 'string') {
    const target = resolveRef(node.$ref, root);
    return target !== undefined && matchesNode(value, target, root, depth + 1);
  }
  if (Array.isArray(node.anyOf)) {
    return (node.anyOf as readonly unknown[]).some(
      (branch) => isPlainObject(branch) && matchesNode(value, branch, root, depth + 1),
    );
  }
  if (Array.isArray(node.enum) && !(node.enum as readonly unknown[]).includes(value)) return false;
  if ('const' in node && node.const !== value) return false;
  if (node.type !== undefined && !matchesType(value, node.type)) return false;
  if (typeof value === 'number' && !matchesNumber(value, node)) return false;
  if (typeof value === 'string' && typeof node.pattern === 'string') {
    const pattern = compiledPattern(node.pattern);
    if (pattern !== null && !pattern.test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) return false;
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) return false;
    const items = node.items;
    if (isPlainObject(items)) {
      return (value as readonly unknown[]).every((item) =>
        matchesNode(item, items, root, depth + 1),
      );
    }
    return true;
  }
  if (isPlainObject(value) && node.type === 'object') {
    const properties = isPlainObject(node.properties) ? node.properties : {};
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) return false;
    }
    const required = Array.isArray(node.required) ? (node.required as readonly unknown[]) : [];
    for (const key of required) {
      if (typeof key !== 'string' || !Object.hasOwn(value, key)) return false;
    }
    for (const [key, schema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      if (!isPlainObject(schema) || !matchesNode(value[key], schema, root, depth + 1)) return false;
    }
  }
  return true;
}

/**
 * Whether `value` satisfies `schema` under the keyword subset strict lowering
 * emits (`type`, `enum`, `const`, `anyOf`, `properties`, `required`,
 * `additionalProperties: false`, `items`, `minItems`, `maxItems`, numeric
 * bounds, `pattern`, local `$ref`). Formats and description hints are not
 * checked. `root` resolves `$ref`.
 */
export function matchesLowered(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema = schema,
): boolean {
  return matchesNode(value, schema, root, 0);
}

function restore(value: unknown, plan: RestorePlan, scope: RestoreScope, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  switch (plan.kind) {
    case 'none':
      return value;
    case 'ref': {
      const name = refName(plan.ref);
      const target =
        name === '' ? scope.rootPlan : name === undefined ? undefined : scope.defPlans.get(name);
      return target === undefined ? value : restore(value, target, scope, depth + 1);
    }
    case 'array':
      return Array.isArray(value)
        ? (value as readonly unknown[]).map((item) => restore(item, plan.items, scope, depth + 1))
        : value;
    case 'union': {
      for (const branch of plan.branches) {
        if (matchesNode(value, branch.schema, scope.root, 0)) {
          return restore(value, branch.plan, scope, depth + 1);
        }
      }
      return value;
    }
    case 'object': {
      if (!isPlainObject(value)) return value;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const property = Object.hasOwn(plan.properties, key) ? plan.properties[key] : undefined;
        const field = value[key];
        if (property === undefined) {
          Object.defineProperty(result, key, {
            value: field,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          continue;
        }
        if (field === null && property.dropNull) continue;
        Object.defineProperty(result, key, {
          value: restore(field, property.plan, scope, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
  }
}

/** Restore `value` through the root plan of `scope` (see the module comment). */
export function restoreValue(value: unknown, scope: RestoreScope): unknown {
  return restore(value, scope.rootPlan, scope, 0);
}
