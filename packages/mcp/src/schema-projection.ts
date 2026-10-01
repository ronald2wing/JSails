/**
 * Schema projection: from a Standard Schema with JSON Schema support (zod 4,
 * ArkType, Valibot through its converter, or any other implementation) to the
 * JSON Schema 2020-12 document MCP advertises, computed and checked once per
 * definition.
 *
 * At define time a schema is projected, checked to be plain JSON, compiled with
 * the SDK's own validator (the one clients use to check structured output), and
 * scanned for `x-mcp-header` declarations under the 2026-07-28 Streamable HTTP
 * rules. The frozen document is then handed to the SDK through a pass-through
 * wire schema, so a serving unit never re-projects or re-compiles anything and
 * the SDK never validates (or phrases errors about) a caller's arguments: the
 * serving layer validates with the author's schema itself and reports failures
 * without echoing input.
 */

import { isRecord, deepCloneJson, deepFreeze } from 'jsails/plugin-sdk';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

import { strictJson } from './content.js';
import { McpDefinitionError } from './errors.js';

/** One validation issue, as Standard Schema reports it. */
interface McpSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/** A Standard Schema validation result. */
type McpSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<McpSchemaIssue> };

/**
 * A schema `@jsails/mcp` accepts: a Standard Schema that also implements the
 * Standard JSON Schema converter (`~standard.jsonSchema`). Zod 4 schemas are
 * such schemas; so is any library implementing both specifications.
 */
export interface McpSchema<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => McpSchemaResult<Output> | Promise<McpSchemaResult<Output>>;
    readonly jsonSchema: {
      readonly input: (options: { readonly target: 'draft-2020-12' }) => Record<string, unknown>;
      readonly output: (options: { readonly target: 'draft-2020-12' }) => Record<string, unknown>;
    };
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** The type a schema accepts. */
export type McpSchemaInput<S> = S extends McpSchema
  ? NonNullable<S['~standard']['types']>['input']
  : never;

/** The type a schema produces. */
export type McpSchemaOutput<S> = S extends McpSchema
  ? NonNullable<S['~standard']['types']>['output']
  : never;

/** What a projected schema is used for; it decides the rules applied. */
export type SchemaRole = 'input' | 'output' | 'arguments' | 'params';

/** A schema with its precomputed JSON Schema document and SDK-facing wire form. */
export interface ProjectedSchema {
  readonly schema: McpSchema;
  readonly json: Readonly<Record<string, unknown>>;
  readonly wire: StandardSchemaWithJSON;
}

const JSON_SCHEMA_TARGET = 'draft-2020-12';

/** The input schema of a tool that declares none: an object with no properties allowed. */
export const EMPTY_INPUT_JSON: Readonly<Record<string, unknown>> = deepFreeze({
  type: 'object',
  properties: {},
  additionalProperties: false,
});

let validator: AjvJsonSchemaValidator | undefined;

function compiles(json: Readonly<Record<string, unknown>>): boolean {
  validator ??= new AjvJsonSchemaValidator();
  try {
    validator.getValidator(deepCloneJson(json));
    return true;
  } catch (_compileError) {
    return false;
  }
}

/** True for a value implementing Standard Schema validation and the JSON Schema converter. */
export function isMcpSchema(value: unknown): value is McpSchema {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  const standard: unknown = Reflect.get(value, '~standard');
  return (
    isRecord(standard) &&
    standard.version === 1 &&
    typeof standard.validate === 'function' &&
    isRecord(standard.jsonSchema) &&
    typeof standard.jsonSchema.input === 'function' &&
    typeof standard.jsonSchema.output === 'function'
  );
}

/**
 * A Standard Schema that advertises `json` and accepts every value. The SDK
 * gets this in place of the author's schema: validation is the serving
 * layer's job, with value-free error text.
 */
export function wireSchema(json: Readonly<Record<string, unknown>>): StandardSchemaWithJSON {
  const emit = (): Record<string, unknown> => ({ ...json });
  return Object.freeze({
    '~standard': Object.freeze({
      version: 1 as const,
      vendor: 'jsails-mcp',
      validate: (value: unknown) => ({ value }),
      jsonSchema: Object.freeze({ input: emit, output: emit }),
    }),
  });
}

function invalid(role: SchemaRole, reason: string, owner: string): McpDefinitionError {
  return new McpDefinitionError('invalid_schema', `the ${role} schema ${reason}`, {
    definition: owner,
  });
}

/**
 * Project and check a schema for one role. `owner` names the definition in
 * error context.
 */
export function projectSchema(schema: unknown, role: SchemaRole, owner: string): ProjectedSchema {
  if (!isMcpSchema(schema)) {
    throw invalid(
      role,
      'must be a Standard Schema with JSON Schema support (for example a zod 4 schema)',
      owner,
    );
  }
  let emitted: unknown;
  try {
    emitted = schema['~standard'].jsonSchema[role === 'output' ? 'output' : 'input']({
      target: JSON_SCHEMA_TARGET,
    });
  } catch (cause) {
    throw new McpDefinitionError(
      'invalid_schema',
      `the ${role} schema cannot be projected to JSON Schema`,
      { definition: owner, cause: cause instanceof Error ? cause.name : 'unknown' },
    );
  }
  if (!isRecord(emitted)) {
    throw invalid(role, 'did not project to a JSON Schema object', owner);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(strictJson(emitted)) as Record<string, unknown>;
  } catch (_notJson) {
    throw invalid(role, 'projected to a document that is not plain JSON', owner);
  }
  if (role !== 'output') {
    if (json.type === undefined) {
      json = { type: 'object', ...json };
    } else if (json.type !== 'object') {
      throw invalid(role, 'must describe an object', owner);
    }
  }
  checkRoleRules(json, role, owner);
  if (!compiles(json)) {
    throw invalid(role, 'does not compile as JSON Schema 2020-12', owner);
  }
  const frozen = deepFreeze(json);
  return Object.freeze({ schema, json: frozen, wire: wireSchema(frozen) });
}

function checkRoleRules(json: Record<string, unknown>, role: SchemaRole, owner: string): void {
  if (role === 'input') {
    const fault = scanHeaderDeclarations(json);
    if (fault !== undefined) {
      throw invalid(role, `has an invalid x-mcp-header declaration: ${fault}`, owner);
    }
    return;
  }
  if (role === 'output') {
    return;
  }
  const properties = isRecord(json.properties) ? json.properties : {};
  for (const property of Object.values(properties)) {
    const type = isRecord(property) ? property.type : undefined;
    if (role === 'arguments' && type !== 'string') {
      throw invalid(
        role,
        'must declare only string properties (prompt arguments are strings)',
        owner,
      );
    }
    if (role === 'params' && type !== undefined && type !== 'string' && type !== 'array') {
      throw invalid(
        role,
        'must declare string or string-array properties (URI variables are strings)',
        owner,
      );
    }
  }
}

/** The declared top-level property names of an object schema. */
export function propertyNames(json: Readonly<Record<string, unknown>>): readonly string[] {
  return isRecord(json.properties) ? Object.keys(json.properties) : [];
}

/** The outcome of validating a caller's value with an author's schema. */
export type Validation =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly paths: readonly string[] };

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_REPORTED_PATHS = 10;

function segmentText(segment: PropertyKey | { readonly key: PropertyKey }): string {
  const key = typeof segment === 'object' ? segment.key : segment;
  if (typeof key === 'number') {
    return String(key);
  }
  return typeof key === 'string' && SAFE_SEGMENT.test(key) ? key : '*';
}

/**
 * Validate `value` with `schema`. A failure reports only the paths that
 * failed, with any segment that is not a plain identifier masked, so a
 * caller-chosen key never echoes back.
 */
export async function validateValue(schema: McpSchema, value: unknown): Promise<Validation> {
  const result = await schema['~standard'].validate(value);
  if (result.issues === undefined) {
    return { ok: true, value: result.value };
  }
  const paths = new Set<string>();
  for (const issue of result.issues) {
    const path = issue.path ?? [];
    paths.add(path.length === 0 ? '(root)' : path.map(segmentText).join('.'));
    if (paths.size === MAX_REPORTED_PATHS) {
      break;
    }
  }
  return { ok: false, paths: [...paths] };
}

/** RFC 9110 `token`: the header name grammar. */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE_TYPES = new Set(['string', 'integer', 'boolean']);
/** Subschema positions an `x-mcp-header` chain must not pass through. */
const UNREACHABLE_KEYWORDS = [
  'items',
  'prefixItems',
  'contains',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'patternProperties',
  'dependentSchemas',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$defs',
  'definitions',
] as const;
const MAP_VALUED_KEYWORDS = new Set([
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);

/**
 * Check every `x-mcp-header` declaration in a tool input schema against the
 * 2026-07-28 Streamable HTTP rules: only on properties reachable through a
 * chain of `properties` keys, a non-empty RFC 9110 token, a `string`,
 * `integer` or `boolean` property, and case-insensitively unique. Returns the
 * first violated rule, or `undefined` when the schema is valid. A conforming
 * client drops a tool that breaks one of these rules, so it is a define-time
 * error here.
 */
export function scanHeaderDeclarations(
  json: Readonly<Record<string, unknown>>,
): string | undefined {
  const seen = new Set<string>();
  const visit = (node: unknown, depth: number, reachable: boolean): string | undefined => {
    if (!isRecord(node)) {
      return undefined;
    }
    if ('x-mcp-header' in node) {
      if (!reachable || depth === 0) {
        return 'it is only allowed on properties reached through properties keys';
      }
      const header = node['x-mcp-header'];
      if (typeof header !== 'string' || !HTTP_TOKEN.test(header)) {
        return 'the header name must be a non-empty RFC 9110 token';
      }
      if (typeof node.type !== 'string' || !HEADER_VALUE_TYPES.has(node.type)) {
        return 'it is only allowed on string, integer, or boolean properties';
      }
      const lower = header.toLowerCase();
      if (seen.has(lower)) {
        return 'header names must be unique, ignoring case';
      }
      seen.add(lower);
    }
    if (isRecord(node.properties)) {
      for (const child of Object.values(node.properties)) {
        const fault = visit(child, depth + 1, reachable);
        if (fault !== undefined) {
          return fault;
        }
      }
    }
    for (const keyword of UNREACHABLE_KEYWORDS) {
      const sub = node[keyword];
      if (sub === undefined) {
        continue;
      }
      const branches: unknown[] = Array.isArray(sub)
        ? sub
        : MAP_VALUED_KEYWORDS.has(keyword) && isRecord(sub)
          ? Object.values(sub)
          : [sub];
      for (const branch of branches) {
        const fault = visit(branch, depth + 1, false);
        if (fault !== undefined) {
          return fault;
        }
      }
    }
    return undefined;
  };
  return visit(json, 0, true);
}
