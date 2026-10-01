/**
 * Per-provider JSON Schema lowering.
 *
 * A provider's strict mode accepts only a subset of JSON Schema. Lowering maps
 * a full schema (from Zod, a data contract, or an MCP server) into that subset
 * while keeping it sound: every value the original schema accepts is accepted
 * by the lowered one, after the profile's value encoding. Constraints a profile
 * cannot express are removed from the schema and written into the node's
 * description as a hint, and Zod validates the full constraint set on the
 * model's output afterwards, so the guarantee never weakens. A constraint the
 * profile does express stays on the wire, where constrained decoding enforces
 * it while the model writes.
 *
 * Profiles:
 * - `anthropic-strict`: Claude strict tools and structured outputs.
 *   `additionalProperties: false` on every object, optional properties stay
 *   optional, `minItems` 0 or 1 kept, lengths, numeric bounds, patterns, and
 *   other array bounds hinted, recursion rejected.
 * - `openai-strict`: Chat Completions strict mode. Every property is
 *   required: an optional property becomes a required `T | null`, and
 *   {@link AiLoweredSchema.restore} drops those nulls again. Numeric bounds
 *   (`minimum`, `maximum`, the exclusive forms, `multipleOf`), `minItems`,
 *   `maxItems`, and `pattern` stay on the wire, as OpenAI documents; string
 *   lengths and the rest are hinted. A pattern with a lookaround or a
 *   backreference, which constrained decoding cannot compile, is hinted too.
 *   The `uri` format, which OpenAI does not list, is hinted. Recursion is
 *   kept through `$defs`.
 * - `loose`: the schema as it is, minus `$schema`, for non-strict tools.
 *
 * Lowering is a pure function of its input and is memoized per schema object
 * and profile, so the same tool always serializes to the same bytes (prompt
 * caching breaks on any byte change). Output keyword order is fixed;
 * property order is the original's, since models generate in that order.
 * A schema outside what a profile can represent throws a value-free
 * `AiError` with a static `reason`.
 */

import { z } from 'zod';

import { AiError, type AiErrorCode } from '../errors/ai-error.js';
import { copyJson, isPlainObject } from '../content/json-value.js';
import {
  NO_RESTORE,
  refName,
  restoreValue,
  type JsonSchema,
  type RestorePlan,
  type RestoreScope,
} from './schema-restore.js';

/** A schema lowering profile. */
export type AiSchemaProfile = 'anthropic-strict' | 'openai-strict' | 'loose';

/** Every {@link AiSchemaProfile}. */
export const AI_SCHEMA_PROFILES: readonly AiSchemaProfile[] = Object.freeze([
  'anthropic-strict',
  'openai-strict',
  'loose',
]);

/** A schema lowered for one profile. */
export interface AiLoweredSchema {
  readonly profile: AiSchemaProfile;
  /** The deep-frozen lowered JSON Schema. */
  readonly schema: JsonSchema;
  /** Map a model value produced against `schema` back to the original shape. */
  restore(value: unknown): unknown;
}

/** String formats OpenAI strict mode accepts. */
const OPENAI_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
]);

/** String formats Claude strict mode accepts. */
const ANTHROPIC_FORMATS: ReadonlySet<string> = new Set([...OPENAI_FORMATS, 'uri']);

/** Numeric keywords OpenAI strict mode enforces. */
const OPENAI_NUMERIC: ReadonlySet<string> = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);

/** A lookaround or a backreference: regex features a decoding automaton cannot hold. */
const IRREGULAR_PATTERN = /\\(?:[1-9]|k<)|\(\?<?[=!]/;

/** Whether OpenAI strict mode can enforce `keyword: value` on the wire. */
function openaiKeeps(keyword: string, value: unknown): boolean {
  if (OPENAI_NUMERIC.has(keyword)) {
    return (
      typeof value === 'number' && Number.isFinite(value) && (keyword !== 'multipleOf' || value > 0)
    );
  }
  if (keyword === 'minItems' || keyword === 'maxItems') {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }
  if (keyword === 'pattern') {
    if (typeof value !== 'string' || IRREGULAR_PATTERN.test(value)) return false;
    try {
      new RegExp(value, 'u');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Annotations dropped without a trace: they constrain nothing. */
const DROPPED_ANNOTATIONS: ReadonlySet<string> = new Set([
  '$schema',
  '$comment',
  'title',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'id',
]);

/** Keywords no strict profile can represent, even as a hint. */
const UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependentRequired',
  'dependencies',
  'patternProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'prefixItems',
  '$dynamicRef',
  '$dynamicAnchor',
  '$recursiveRef',
  '$anchor',
  '$id',
]);

/** Constraint keywords per type that are moved into a description hint. */
const HINTED: Readonly<Record<string, readonly string[]>> = {
  string: ['minLength', 'maxLength', 'pattern', 'contentEncoding', 'contentMediaType'],
  number: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  integer: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  array: ['maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains'],
  object: ['minProperties', 'maxProperties'],
  boolean: [],
  null: [],
};

/** Keywords handled structurally for each type. */
const STRUCTURAL: Readonly<Record<string, readonly string[]>> = {
  string: ['format'],
  number: [],
  integer: [],
  array: ['items', 'minItems'],
  object: ['properties', 'required', 'additionalProperties', 'propertyNames'],
  boolean: [],
  null: [],
};

const TYPE_NAMES = Object.keys(HINTED);

/** Every keyword the lowering understands in some position. */
const KNOWN_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  '$ref',
  '$defs',
  'definitions',
  'description',
  ...DROPPED_ANNOTATIONS,
  ...Object.values(HINTED).flat(),
  ...Object.values(STRUCTURAL).flat(),
]);

type StrictProfile = 'anthropic-strict' | 'openai-strict';

interface Lowered {
  readonly json: Record<string, unknown>;
  readonly plan: RestorePlan;
  /** Whether the lowered node accepts `null`. */
  readonly nullable: boolean;
}

interface LoweringContext {
  readonly profile: StrictProfile;
  readonly root: JsonSchema;
  readonly defs: Readonly<Record<string, unknown>>;
  /** Refs currently being expanded, to detect recursion. */
  readonly expanding: string[];
  /** Definitions (or `''` for the root) that recursion requires in the output `$defs`. */
  readonly recursiveTargets: Set<string>;
  readonly code: AiErrorCode;
}

function fail(context: Pick<LoweringContext, 'code' | 'profile'>, reason: string): AiError {
  return new AiError(context.code, 'the schema cannot be represented for this provider profile', {
    context: { profile: context.profile, reason },
    suggestion: 'Simplify the schema, or set strict: false to send it without strict mode.',
  });
}

function isPrimitive(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function formatHint(entries: readonly (readonly [string, unknown])[]): string {
  return `{${entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')}}`;
}

function withDescription(
  json: Record<string, unknown>,
  description: unknown,
  hints: readonly (readonly [string, unknown])[],
): void {
  const parts: string[] = [];
  if (typeof description === 'string' && description.length > 0) parts.push(description);
  if (hints.length > 0) parts.push(formatHint(hints));
  if (parts.length > 0) json.description = parts.join('\n\n');
}

function resolveTarget(ref: string, context: LoweringContext): { name: string; node: unknown } {
  const name = refName(ref);
  if (name === undefined) throw fail(context, 'ref');
  if (name === '') return { name, node: context.root };
  if (!Object.hasOwn(context.defs, name)) throw fail(context, 'ref');
  return { name, node: context.defs[name] };
}

function refFor(name: string): string {
  return name === ''
    ? '#'
    : `#/$defs/${encodeURIComponent(name.replaceAll('~', '~0').replaceAll('/', '~1'))}`;
}

function lowerRef(node: Record<string, unknown>, context: LoweringContext): Lowered {
  const { name, node: target } = resolveTarget(node.$ref as string, context);
  if (context.expanding.includes(name)) {
    if (context.profile === 'anthropic-strict') throw fail(context, 'recursive');
    context.recursiveTargets.add(name);
    const ref = refFor(name);
    // Nullability of a recursive target is not known while it is being
    // expanded, so it counts as non-nullable: an optional recursive property
    // gets its own null branch, which restore drops.
    return { json: { $ref: ref }, plan: { kind: 'ref', ref }, nullable: false };
  }
  context.expanding.push(name);
  try {
    return lowerNode(target, context);
  } finally {
    context.expanding.pop();
  }
}

function mergeAllOf(
  node: Record<string, unknown>,
  context: LoweringContext,
): Record<string, unknown> {
  const branches = node.allOf as readonly unknown[];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const own: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'allOf' && key !== '$defs' && key !== 'definitions') own[key] = value;
  }
  const parts: unknown[] = [own, ...branches];
  for (const part of parts) {
    let resolved = part;
    const seen = new Set<string>();
    while (isPlainObject(resolved) && typeof resolved.$ref === 'string') {
      const { name, node: target } = resolveTarget(resolved.$ref, context);
      if (seen.has(name) || context.expanding.includes(name)) throw fail(context, 'allof');
      seen.add(name);
      resolved = target;
    }
    if (!isPlainObject(resolved)) throw fail(context, 'allof');
    if (
      part === own &&
      Object.keys(own).every((key) => key === 'description' || DROPPED_ANNOTATIONS.has(key))
    ) {
      continue;
    }
    if (
      resolved.type !== 'object' ||
      resolved.anyOf !== undefined ||
      resolved.allOf !== undefined
    ) {
      throw fail(context, 'allof');
    }
    if (
      isPlainObject(resolved.additionalProperties) &&
      Object.keys(resolved.additionalProperties).length > 0
    ) {
      throw fail(context, 'open_object');
    }
    const branchProperties = isPlainObject(resolved.properties) ? resolved.properties : {};
    for (const [key, schema] of Object.entries(branchProperties)) {
      if (
        Object.hasOwn(properties, key) &&
        JSON.stringify(properties[key]) !== JSON.stringify(schema)
      ) {
        throw fail(context, 'allof_conflict');
      }
      Object.defineProperty(properties, key, {
        value: schema,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (Array.isArray(resolved.required)) {
      for (const key of resolved.required as readonly unknown[]) {
        if (typeof key === 'string' && !required.includes(key)) required.push(key);
      }
    }
  }
  return {
    type: 'object',
    ...(typeof node.description === 'string' ? { description: node.description } : {}),
    properties,
    required,
  };
}

function lowerObject(
  node: Record<string, unknown>,
  context: LoweringContext,
): { json: Record<string, unknown>; plan: RestorePlan } {
  const additional = node.additionalProperties;
  if (
    additional !== undefined &&
    additional !== false &&
    additional !== true &&
    !(isPlainObject(additional) && Object.keys(additional).length === 0)
  ) {
    throw fail(context, 'open_object');
  }
  const source = node.properties ?? {};
  if (!isPlainObject(source)) throw fail(context, 'properties');
  const requiredSource = node.required ?? [];
  if (!Array.isArray(requiredSource)) throw fail(context, 'required');
  const requiredSet = new Set<string>();
  for (const key of requiredSource as readonly unknown[]) {
    if (typeof key !== 'string' || !Object.hasOwn(source, key)) throw fail(context, 'required');
    requiredSet.add(key);
  }
  const properties: Record<string, unknown> = {};
  const planProperties: Record<string, { plan: RestorePlan; dropNull: boolean }> = {};
  let needsPlan = false;
  for (const [key, schema] of Object.entries(source)) {
    const child = lowerNode(schema, context);
    let json = child.json;
    let dropNull = false;
    if (context.profile === 'openai-strict' && !requiredSet.has(key)) {
      if (!child.nullable) {
        json = { anyOf: [child.json, { type: 'null' }] };
        dropNull = true;
      }
    }
    Object.defineProperty(properties, key, {
      value: json,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    if (dropNull || child.plan.kind !== 'none') {
      needsPlan = true;
      Object.defineProperty(planProperties, key, {
        value: { plan: child.plan, dropNull },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  const keys = Object.keys(source);
  const required =
    context.profile === 'openai-strict' ? keys : keys.filter((key) => requiredSet.has(key));
  return {
    json: { type: 'object', properties, required, additionalProperties: false },
    plan: needsPlan ? { kind: 'object', properties: planProperties } : NO_RESTORE,
  };
}

function lowerTyped(
  node: Record<string, unknown>,
  type: string,
  context: LoweringContext,
): Lowered {
  const openai = context.profile === 'openai-strict';
  const hints: (readonly [string, unknown])[] = [];
  let json: Record<string, unknown> = { type };
  let plan: RestorePlan = NO_RESTORE;
  for (const keyword of HINTED[type] ?? []) {
    if (!(keyword in node)) continue;
    const value = node[keyword];
    const safeBound =
      type === 'integer' &&
      ((keyword === 'minimum' && value === Number.MIN_SAFE_INTEGER) ||
        (keyword === 'maximum' && value === Number.MAX_SAFE_INTEGER));
    if (safeBound) continue;
    if (openai && openaiKeeps(keyword, value)) json[keyword] = value;
    else hints.push([keyword, value]);
  }
  if (type === 'string' && node.format !== undefined) {
    const formats = openai ? OPENAI_FORMATS : ANTHROPIC_FORMATS;
    if (typeof node.format === 'string' && formats.has(node.format)) json.format = node.format;
    else hints.push(['format', node.format]);
  }
  if (type === 'array') {
    const items = node.items;
    if (!isPlainObject(items) || Object.keys(items).length === 0)
      throw fail(context, 'untyped_items');
    const child = lowerNode(items, context);
    json.items = child.json;
    if (child.plan.kind !== 'none') plan = { kind: 'array', items: child.plan };
    if (node.minItems !== undefined && node.minItems !== 0) {
      const kept = openai ? openaiKeeps('minItems', node.minItems) : node.minItems === 1;
      if (kept) json.minItems = node.minItems;
      else hints.push(['minItems', node.minItems]);
    }
  }
  if (type === 'object') {
    const object = lowerObject(node, context);
    json = object.json;
    plan = object.plan;
  }
  const ordered: Record<string, unknown> = { type: json.type };
  withDescription(ordered, node.description, hints);
  for (const [key, value] of Object.entries(json)) if (key !== 'type') ordered[key] = value;
  return { json: ordered, plan, nullable: type === 'null' };
}

function lowerUnion(
  branches: readonly unknown[],
  description: unknown,
  context: LoweringContext,
): Lowered {
  if (branches.length === 0) throw fail(context, 'empty_union');
  const lowered = branches.map((branch) => lowerNode(branch, context));
  const json: Record<string, unknown> = { anyOf: lowered.map((branch) => branch.json) };
  withDescription(json, description, []);
  const plan: RestorePlan = lowered.some((branch) => branch.plan.kind !== 'none')
    ? {
        kind: 'union',
        branches: lowered.map((branch) => ({ schema: branch.json, plan: branch.plan })),
      }
    : NO_RESTORE;
  return { json, plan, nullable: lowered.some((branch) => branch.nullable) };
}

function lowerNode(value: unknown, context: LoweringContext): Lowered {
  if (!isPlainObject(value)) throw fail(context, value === true ? 'untyped' : 'schema');
  for (const key of Object.keys(value)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) throw fail(context, 'keyword');
    if (!KNOWN_KEYWORDS.has(key)) throw fail(context, 'keyword');
  }
  if ((value.$defs !== undefined || value.definitions !== undefined) && value !== context.root) {
    throw fail(context, 'nested_defs');
  }
  if (typeof value.$ref === 'string') return lowerRef(value, context);
  if (value.$ref !== undefined) throw fail(context, 'ref');
  if (value.allOf !== undefined) {
    if (!Array.isArray(value.allOf)) throw fail(context, 'allof');
    return lowerNode(mergeAllOf(value, context), context);
  }
  const union = value.anyOf ?? value.oneOf;
  if (union !== undefined) {
    if (
      !Array.isArray(union) ||
      value.type !== undefined ||
      (value.anyOf !== undefined && value.oneOf !== undefined)
    ) {
      throw fail(context, 'union');
    }
    return lowerUnion(union as readonly unknown[], value.description, context);
  }
  if (value.enum !== undefined || value.const !== undefined) {
    const json: Record<string, unknown> = {};
    if (value.type !== undefined) {
      if (typeof value.type !== 'string' || !TYPE_NAMES.includes(value.type))
        throw fail(context, 'type');
      json.type = value.type;
    }
    let nullable = false;
    if (value.enum !== undefined) {
      if (!Array.isArray(value.enum) || value.enum.length === 0) throw fail(context, 'enum');
      const values = value.enum as readonly unknown[];
      if (!values.every(isPrimitive)) throw fail(context, 'enum');
      json.enum = [...values];
      nullable = values.includes(null);
    }
    if (value.const !== undefined) {
      if (!isPrimitive(value.const)) throw fail(context, 'const');
      json.const = value.const;
      nullable = value.const === null;
    }
    withDescription(json, value.description, []);
    return { json, plan: NO_RESTORE, nullable };
  }
  const type = value.type;
  if (Array.isArray(type)) {
    const types = type as readonly unknown[];
    if (
      types.length === 0 ||
      !types.every((entry) => typeof entry === 'string' && TYPE_NAMES.includes(entry))
    ) {
      throw fail(context, 'type');
    }
    if (types.length === 1) return lowerTyped(value, types[0] as string, context);
    const branches = types.map((entry) => {
      const branch: Record<string, unknown> = { type: entry };
      for (const keyword of [
        ...(HINTED[entry as string] ?? []),
        ...(STRUCTURAL[entry as string] ?? []),
      ]) {
        if (keyword in value) branch[keyword] = value[keyword];
      }
      return branch;
    });
    return lowerUnion(branches, value.description, context);
  }
  if (typeof type !== 'string') throw fail(context, 'untyped');
  if (!TYPE_NAMES.includes(type)) throw fail(context, 'type');
  return lowerTyped(value, type, context);
}

function deepFreeze(value: Record<string, unknown>): JsonSchema {
  const frozen = copyJson(value);
  if (frozen === undefined || !isPlainObject(frozen)) {
    throw new AiError('invalid_options', 'the lowered schema is not JSON');
  }
  return frozen;
}

function lowerStrict(
  schema: JsonSchema,
  profile: StrictProfile,
  code: AiErrorCode,
): AiLoweredSchema {
  const defsSource = schema.$defs ?? schema.definitions ?? {};
  if (!isPlainObject(defsSource)) throw fail({ code, profile }, 'defs');
  const context: LoweringContext = {
    profile,
    root: schema,
    defs: defsSource,
    expanding: [''],
    recursiveTargets: new Set(),
    code,
  };
  const root = lowerNode(schema, context);
  const defs: Record<string, unknown> = {};
  const defPlans = new Map<string, RestorePlan>();
  const done = new Set<string>();
  let pending = [...context.recursiveTargets].filter((name) => name !== '');
  while (pending.length > 0) {
    for (const name of pending) {
      done.add(name);
      context.expanding.length = 0;
      context.expanding.push(name);
      const lowered = lowerNode(context.defs[name], context);
      Object.defineProperty(defs, name, {
        value: lowered.json,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      defPlans.set(name, lowered.plan);
    }
    pending = [...context.recursiveTargets].filter((name) => name !== '' && !done.has(name));
  }
  const json: Record<string, unknown> = { ...root.json };
  if (Object.keys(defs).length > 0) json.$defs = defs;
  const frozen = deepFreeze(json);
  const hasPlan =
    root.plan.kind !== 'none' || [...defPlans.values()].some((plan) => plan.kind !== 'none');
  const scope: RestoreScope = { root: frozen, rootPlan: root.plan, defPlans };
  return Object.freeze({
    profile,
    schema: frozen,
    restore: hasPlan ? (value: unknown) => restoreValue(value, scope) : (value: unknown) => value,
  });
}

function lowerLoose(schema: JsonSchema): AiLoweredSchema {
  const json: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) if (key !== '$schema') json[key] = value;
  return Object.freeze({
    profile: 'loose',
    schema: deepFreeze(json),
    restore: (value: unknown) => value,
  });
}

const jsonSchemaCache = new WeakMap<object, Map<AiSchemaProfile, AiLoweredSchema>>();

/**
 * Lower a JSON Schema for `profile`. Memoized per schema object. `code` is the
 * error code raised when the schema cannot be lowered (default
 * `invalid_options`).
 */
export function lowerJsonSchema(
  schema: JsonSchema,
  profile: AiSchemaProfile,
  code: AiErrorCode = 'invalid_options',
): AiLoweredSchema {
  if (!isPlainObject(schema)) {
    throw new AiError(code, 'the schema must be a JSON Schema object', { context: { profile } });
  }
  let cached = jsonSchemaCache.get(schema);
  const hit = cached?.get(profile);
  if (hit !== undefined) return hit;
  const lowered = profile === 'loose' ? lowerLoose(schema) : lowerStrict(schema, profile, code);
  if (cached === undefined) {
    cached = new Map();
    jsonSchemaCache.set(schema, cached);
  }
  cached.set(profile, lowered);
  return lowered;
}

const zodJsonCache = new WeakMap<object, JsonSchema>();

/** Whether `value` is a Zod 4 schema. */
export function isZodSchema(value: unknown): value is z.ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

/**
 * The input-side JSON Schema of a Zod schema (draft 2020-12), memoized per
 * schema object. A schema Zod cannot represent throws `AiError(code)`.
 */
export function zodInputJsonSchema(
  schema: z.ZodType,
  code: AiErrorCode = 'invalid_options',
): JsonSchema {
  const cached = zodJsonCache.get(schema);
  if (cached !== undefined) return cached;
  let json: unknown;
  try {
    json = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'throw',
      target: 'draft-2020-12',
    });
  } catch {
    throw new AiError(code, 'the schema cannot be represented as JSON Schema', {
      context: { reason: 'unrepresentable' },
    });
  }
  const frozen = copyJson(json);
  if (frozen === undefined || !isPlainObject(frozen)) {
    throw new AiError(code, 'the schema cannot be represented as JSON Schema', {
      context: { reason: 'unrepresentable' },
    });
  }
  zodJsonCache.set(schema, frozen);
  return frozen;
}

/** Lower a Zod schema's input JSON Schema for `profile` (memoized). */
export function lowerZodSchema(
  schema: z.ZodType,
  profile: AiSchemaProfile,
  code: AiErrorCode = 'invalid_options',
): AiLoweredSchema {
  return lowerJsonSchema(zodInputJsonSchema(schema, code), profile, code);
}
