/**
 * The MCP definition layer: `defineMcpTool`, `defineMcpResource`,
 * `defineMcpResourceTemplate`, `defineMcpPrompt`, and `defineMcpServer`.
 *
 * Each `define*` call validates its spec completely (names, text fields,
 * icons, cache hints, access, schemas, URI templates) and precomputes
 * everything a serving unit needs: projected and compiled JSON Schemas, wire
 * annotations and icons. The returned value is a frozen, opaque handle; its
 * record lives in a module-private table, so a handle cannot be forged or
 * edited after the fact. `defineMcpServer` checks uniqueness and fixes a
 * deterministic order (tools and prompts by name, resources by URI, templates
 * by name), so every serving unit lists items in the same order whatever the
 * gate admits.
 */

import type { Awaitable } from 'jsails/plugin-sdk';
import { deepFreeze, isRecord } from 'jsails/plugin-sdk';
import type { Icon, StandardSchemaWithJSON, ToolAnnotations } from '@modelcontextprotocol/server';

import { isPublicAccess, isValidAccess, type McpAccess } from './access.js';
import type { McpCallContext } from './call-context.js';
import type {
  JsonValue,
  McpIcon,
  McpPromptMessage,
  McpResourceContents,
  McpToolResult,
} from './content.js';
import { checkIcon, isAbsoluteUri } from './content.js';
import { McpDefinitionError } from './errors.js';
import type { McpInputRequired } from './input-required.js';
import {
  EMPTY_INPUT_JSON,
  projectSchema,
  propertyNames,
  wireSchema,
  type McpSchema,
  type McpSchemaInput,
  type McpSchemaOutput,
  type ProjectedSchema,
} from './schema-projection.js';
import { parseUriTemplate, type ParsedTemplate } from './uri-template.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Behaviour hints a client may show or use to decide on confirmation. */
export interface McpToolAnnotations {
  /** The tool does not change its environment. */
  readonly readOnly?: boolean;
  /** The tool may destroy or overwrite data (meaningful only when not read-only). */
  readonly destructive?: boolean;
  /** Calling the tool again with the same arguments has no further effect. */
  readonly idempotent?: boolean;
  /** The tool reaches entities outside the server (the web, third parties). */
  readonly openWorld?: boolean;
}

/**
 * How long a resource read may be cached, and by whom. `scope` defaults to
 * `private`; `public` (shared caches) is allowed only on public access.
 */
export interface McpCacheHint {
  readonly ttlMs: number;
  readonly scope?: 'public' | 'private';
}

/** What a tool handler receives: the parsed input, or `{}` when the tool declares none. */
export type McpHandlerInput<S> = S extends McpSchema ? McpSchemaOutput<S> : Record<string, never>;

/**
 * What a tool handler returns. With an output schema: a value the schema
 * accepts, or {@link McpToolResult} carrying one. Without: text, a JSON value
 * (sent as a JSON text block), a {@link McpToolResult}, or nothing (no content).
 * Either way, an `inputRequired(...)` value asks for input and runs the
 * handler again with the answers.
 */
export type McpToolReturn<O> =
  | (O extends McpSchema
      ? McpSchemaInput<O> | McpToolResult<McpSchemaInput<O>>
      : string | JsonValue | McpToolResult | void)
  | McpInputRequired;

/** A tool definition spec. */
export interface McpToolSpec<I extends McpSchema | undefined, O extends McpSchema | undefined> {
  /** `[A-Za-z0-9_.-]{1,128}`, not starting or ending with `.` or `-`. */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** An object schema. Omitted, the tool takes no arguments at all. */
  readonly input?: I;
  /** The structured output schema; results are checked against it before sending. */
  readonly output?: O;
  readonly annotations?: McpToolAnnotations;
  readonly icons?: readonly McpIcon[];
  /** Required: {@link publicAccess} or a value the serving gate understands. */
  readonly access: McpAccess;
  /** The handler deadline; the serving default applies when omitted. */
  readonly timeoutMs?: number;
  /**
   * Ask the user to confirm every call before the handler runs: return the
   * question for these arguments. A declined or cancelled confirmation fails
   * the call with `not_confirmed`; a client that cannot show the question
   * gets `confirmation_unavailable`, and the handler never runs.
   */
  readonly confirm?: (input: McpHandlerInput<I>) => string;
  readonly handler: (input: McpHandlerInput<I>, ctx: McpCallContext) => Awaitable<McpToolReturn<O>>;
}

/** A defined tool: an opaque, frozen handle. */
export interface McpTool {
  readonly kind: 'tool';
  readonly name: string;
}

/**
 * A completer for one prompt argument or template variable: given what the
 * user typed and the arguments already resolved, suggest values. At most 100
 * are sent.
 */
export type McpCompleter = (
  prefix: string,
  ctx: McpCallContext,
  resolved: Readonly<Record<string, string>>,
) => Awaitable<readonly string[]>;

/** Completers keyed by argument or variable name. */
export type McpCompleters<S> = S extends McpSchema
  ? { readonly [K in keyof McpSchemaOutput<S>]?: McpCompleter }
  : never;

/** A resource definition spec. */
export interface McpResourceSpec {
  /** An absolute URI, written in its canonical (WHATWG-serialized) form. */
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly icons?: readonly McpIcon[];
  readonly access: McpAccess;
  readonly cache?: McpCacheHint;
  /** Return the bodies, `null` when the resource does not exist right now, or `inputRequired(...)`. */
  readonly read: (ctx: McpCallContext) => Awaitable<McpResourceContents | null | McpInputRequired>;
}

/** A defined resource: an opaque, frozen handle. */
export interface McpResource {
  readonly kind: 'resource';
  readonly uri: string;
}

/** A resource a template lists. */
export interface McpListedResource {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/** A resource template definition spec. */
export interface McpResourceTemplateSpec<P extends McpSchema> {
  /** An RFC 6570 template with a literal scheme, for example `notes://{id}`. */
  readonly uriTemplate: string;
  /** Unique among the server's templates. */
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly icons?: readonly McpIcon[];
  /** An object schema whose properties are exactly the template's variables. */
  readonly params: P;
  readonly access: McpAccess;
  readonly cache?: McpCacheHint;
  readonly complete?: McpCompleters<P>;
  /** List concrete resources under the template; each URI must match it. */
  readonly list?: (ctx: McpCallContext) => Awaitable<readonly McpListedResource[]>;
  /** Return the bodies, `null` when no resource exists at these params, or `inputRequired(...)`. */
  readonly read: (
    params: McpSchemaOutput<P>,
    ctx: McpCallContext,
  ) => Awaitable<McpResourceContents | null | McpInputRequired>;
}

/** A defined resource template: an opaque, frozen handle. */
export interface McpResourceTemplate {
  readonly kind: 'resource-template';
  readonly uriTemplate: string;
}

/** A prompt definition spec. */
export interface McpPromptSpec<A extends McpSchema | undefined> {
  /** The same rule as tool names. */
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly icons?: readonly McpIcon[];
  /** An object schema with string properties only (prompt arguments are strings). */
  readonly args?: A;
  readonly access: McpAccess;
  readonly complete?: McpCompleters<A>;
  readonly render: (
    args: McpHandlerInput<A>,
    ctx: McpCallContext,
  ) => Awaitable<readonly McpPromptMessage[] | McpInputRequired>;
}

/** A defined prompt: an opaque, frozen handle. */
export interface McpPrompt {
  readonly kind: 'prompt';
  readonly name: string;
}

/** A server definition spec. */
export interface McpServerSpec {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  /** How a model should use this server; sent to the client. */
  readonly instructions?: string;
  readonly tools?: readonly McpTool[];
  readonly resources?: readonly (McpResource | McpResourceTemplate)[];
  readonly prompts?: readonly McpPrompt[];
  /**
   * How long list results may be cached, in milliseconds (default 0). The
   * cache scope is derived: `public` only when every item of that list is
   * public, `private` otherwise.
   */
  readonly listCacheTtlMs?: number;
}

/** A defined server: an opaque, frozen handle. */
export interface McpServerDefinition {
  readonly kind: 'server';
  readonly name: string;
  readonly version: string;
}

// ---------------------------------------------------------------------------
// Records (package-internal)
// ---------------------------------------------------------------------------

type AnyHandler = (input: unknown, ctx: McpCallContext) => Awaitable<unknown>;

interface RecordBase {
  readonly title?: string;
  readonly description?: string;
  readonly icons?: Icon[];
  readonly access: McpAccess;
}

/** The precomputed form of a tool. */
export interface ToolRecord extends RecordBase {
  readonly kind: 'tool';
  readonly name: string;
  readonly description: string;
  /** `undefined` when the tool takes no arguments. */
  readonly input: ProjectedSchema | undefined;
  readonly inputWire: StandardSchemaWithJSON;
  readonly output: ProjectedSchema | undefined;
  readonly annotations?: ToolAnnotations;
  readonly timeoutMs: number | undefined;
  readonly confirm: ((input: unknown) => unknown) | undefined;
  readonly handler: AnyHandler;
}

/** The precomputed form of a resource. */
export interface ResourceRecord extends RecordBase {
  readonly kind: 'resource';
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly cache: { readonly ttlMs: number; readonly cacheScope: 'public' | 'private' } | undefined;
  readonly read: (ctx: McpCallContext) => Awaitable<unknown>;
}

/** The precomputed form of a resource template. */
export interface TemplateRecord extends RecordBase {
  readonly kind: 'resource-template';
  readonly uriTemplate: string;
  readonly parsed: ParsedTemplate;
  readonly name: string;
  readonly mimeType?: string;
  readonly params: ProjectedSchema;
  readonly cache: { readonly ttlMs: number; readonly cacheScope: 'public' | 'private' } | undefined;
  readonly completers: ReadonlyMap<string, McpCompleter>;
  readonly list: ((ctx: McpCallContext) => Awaitable<unknown>) | undefined;
  readonly read: AnyHandler;
}

/** The precomputed form of a prompt. */
export interface PromptRecord extends RecordBase {
  readonly kind: 'prompt';
  readonly name: string;
  readonly args: ProjectedSchema | undefined;
  readonly completers: ReadonlyMap<string, McpCompleter>;
  readonly render: AnyHandler;
}

/** The cache hint of one list result. */
export interface ListCacheHint {
  readonly ttlMs: number;
  readonly cacheScope: 'public' | 'private';
}

/** The precomputed form of a server. */
export interface ServerRecord {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly instructions?: string;
  readonly tools: readonly ToolRecord[];
  readonly resources: readonly ResourceRecord[];
  readonly templates: readonly TemplateRecord[];
  readonly prompts: readonly PromptRecord[];
  readonly listCache: {
    readonly tools: ListCacheHint;
    readonly resources: ListCacheHint;
    readonly prompts: ListCacheHint;
  };
  /** True when any item has non-public access, so a gate is required to serve it. */
  readonly gated: boolean;
  /** True when any prompt or template declares a completer. */
  readonly completions: boolean;
}

const tools = new WeakMap<object, ToolRecord>();
const resources = new WeakMap<object, ResourceRecord>();
const templates = new WeakMap<object, TemplateRecord>();
const prompts = new WeakMap<object, PromptRecord>();
const servers = new WeakMap<object, ServerRecord>();

/** The record behind a server handle, or `undefined` for a foreign value. */
export function serverRecord(server: unknown): ServerRecord | undefined {
  return typeof server === 'object' && server !== null ? servers.get(server) : undefined;
}

// ---------------------------------------------------------------------------
// Field checks
// ---------------------------------------------------------------------------

const NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9_])?$/;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MIME_TYPE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

function definitionError(kind: string, reason: string, owner?: string): McpDefinitionError {
  return new McpDefinitionError(
    'invalid_definition',
    `${kind} ${reason}`,
    owner === undefined ? undefined : { definition: owner },
  );
}

function checkSpec(
  spec: unknown,
  kind: string,
  allowed: readonly string[],
): asserts spec is Record<string, unknown> {
  if (!isRecord(spec)) {
    throw definitionError(kind, 'spec must be an object');
  }
  for (const key of Object.keys(spec)) {
    if (!allowed.includes(key)) {
      throw new McpDefinitionError('invalid_definition', `${kind} spec has an unknown field`, {
        field: key.length <= 64 ? key : 'unknown',
      });
    }
  }
}

const DIGITS = /^[0-9]+$/;

/**
 * The SDK keeps tools, prompts, and resource templates in plain objects keyed
 * by name, so a name that is an `Object.prototype` key reads as already
 * registered and fails every serving unit, and an all-digit name is an
 * integer key that object order lists before every other name. Both are
 * refused here, so a definition that passes is one every unit can serve and
 * list in name order.
 */
function checkName(value: unknown, kind: string): string {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new McpDefinitionError(
      'invalid_name',
      `${kind} name must match [A-Za-z0-9_.-]{1,128} and not start or end with "." or "-"`,
    );
  }
  if (value === '__proto__' || Object.hasOwn(Object.prototype, value)) {
    throw new McpDefinitionError(
      'invalid_name',
      `${kind} name must not be an Object.prototype property name`,
    );
  }
  if (DIGITS.test(value)) {
    throw new McpDefinitionError('invalid_name', `${kind} name must not be all digits`);
  }
  return value;
}

function checkLabel(value: unknown, kind: string, field: string, owner: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw definitionError(kind, `${field} must be a non-empty string`, owner);
  }
  return value;
}

function optionalLabel(
  value: unknown,
  kind: string,
  field: string,
  owner: string,
): string | undefined {
  return value === undefined ? undefined : checkLabel(value, kind, field, owner);
}

function optionalMimeType(value: unknown, kind: string, owner: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !MIME_TYPE.test(value)) {
    throw definitionError(kind, 'mimeType must be a type/subtype MIME type', owner);
  }
  return value;
}

function checkFunction<F>(value: unknown, kind: string, field: string, owner: string): F {
  if (typeof value !== 'function') {
    throw definitionError(kind, `${field} must be a function`, owner);
  }
  return value as F;
}

function checkAccess(value: unknown, owner: string): McpAccess {
  if (!isValidAccess(value)) {
    throw new McpDefinitionError(
      'invalid_access',
      'access is required: publicAccess(reason) or an object the serving gate understands',
      { definition: owner },
    );
  }
  return value;
}

function checkIcons(value: unknown, owner: string): Icon[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new McpDefinitionError('invalid_icon', 'icons must be an array', { definition: owner });
  }
  const icons: unknown[] = value;
  return icons.map((icon) => {
    const checked = checkIcon(icon);
    if (!checked.ok) {
      throw new McpDefinitionError('invalid_icon', `an icon ${checked.reason}`, {
        definition: owner,
      });
    }
    return deepFreeze(checked.icon);
  });
}

function checkCache(value: unknown, access: McpAccess, owner: string): ResourceRecord['cache'] {
  if (value === undefined) {
    return undefined;
  }
  const fail = (reason: string) =>
    new McpDefinitionError('invalid_cache_hint', `the cache hint ${reason}`, { definition: owner });
  if (!isRecord(value)) {
    throw fail('must be an object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'ttlMs' && key !== 'scope') {
      throw fail('has an unknown field');
    }
  }
  const ttlMs = value.ttlMs;
  if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw fail('ttlMs must be a non-negative safe integer');
  }
  const scope = value.scope ?? 'private';
  if (scope !== 'public' && scope !== 'private') {
    throw fail('scope must be public or private');
  }
  if (scope === 'public' && !isPublicAccess(access)) {
    throw fail('may be public only on public access');
  }
  return Object.freeze({ ttlMs, cacheScope: scope });
}

function checkTimeout(value: unknown, owner: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw definitionError(
      'tool',
      `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`,
      owner,
    );
  }
  return value;
}

function checkAnnotations(value: unknown, owner: string): ToolAnnotations | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw definitionError('tool', 'annotations must be an object', owner);
  }
  const hints: Record<string, string> = {
    readOnly: 'readOnlyHint',
    destructive: 'destructiveHint',
    idempotent: 'idempotentHint',
    openWorld: 'openWorldHint',
  };
  const wire: Record<string, boolean> = {};
  for (const [key, flag] of Object.entries(value)) {
    const hint = hints[key];
    if (hint === undefined) {
      throw definitionError('tool', 'annotations has an unknown field', owner);
    }
    if (typeof flag !== 'boolean') {
      throw definitionError('tool', 'annotations values must be booleans', owner);
    }
    wire[hint] = flag;
  }
  if (value.readOnly === true && value.destructive === true) {
    throw definitionError('tool', 'annotations cannot be both read-only and destructive', owner);
  }
  return Object.freeze(wire);
}

function checkCompleters(
  value: unknown,
  names: readonly string[],
  kind: string,
  owner: string,
): ReadonlyMap<string, McpCompleter> {
  const completers = new Map<string, McpCompleter>();
  if (value === undefined) {
    return completers;
  }
  if (!isRecord(value)) {
    throw definitionError(kind, 'complete must be an object', owner);
  }
  for (const [name, completer] of Object.entries(value)) {
    if (!names.includes(name)) {
      throw definitionError(kind, 'complete names an argument the schema does not declare', owner);
    }
    if (completer === undefined) {
      continue;
    }
    completers.set(name, checkFunction<McpCompleter>(completer, kind, 'a completer', owner));
  }
  return completers;
}

function freezeHandle<T extends object>(handle: T): T {
  return Object.freeze(handle);
}

// ---------------------------------------------------------------------------
// define*
// ---------------------------------------------------------------------------

const TOOL_FIELDS = [
  'name',
  'title',
  'description',
  'input',
  'output',
  'annotations',
  'icons',
  'access',
  'timeoutMs',
  'confirm',
  'handler',
] as const;

/** Define a tool. Throws {@link McpDefinitionError} on any malformed field. */
export function defineMcpTool<
  I extends McpSchema | undefined = undefined,
  O extends McpSchema | undefined = undefined,
>(spec: McpToolSpec<I, O>): McpTool {
  checkSpec(spec, 'tool', TOOL_FIELDS);
  const name = checkName(spec.name, 'tool');
  const owner = `tool:${name}`;
  const access = checkAccess(spec.access, owner);
  const input = spec.input === undefined ? undefined : projectSchema(spec.input, 'input', owner);
  const output =
    spec.output === undefined ? undefined : projectSchema(spec.output, 'output', owner);
  const title = optionalLabel(spec.title, 'tool', 'title', owner);
  const annotations = checkAnnotations(spec.annotations, owner);
  const icons = checkIcons(spec.icons, owner);
  const record: ToolRecord = Object.freeze({
    kind: 'tool',
    name,
    description: checkLabel(spec.description, 'tool', 'description', owner),
    input,
    inputWire: input?.wire ?? wireSchema(EMPTY_INPUT_JSON),
    output,
    access,
    timeoutMs: checkTimeout(spec.timeoutMs, owner),
    confirm:
      spec.confirm === undefined
        ? undefined
        : checkFunction<NonNullable<ToolRecord['confirm']>>(spec.confirm, 'tool', 'confirm', owner),
    handler: checkFunction<AnyHandler>(spec.handler, 'tool', 'handler', owner),
    ...(title === undefined ? {} : { title }),
    ...(annotations === undefined ? {} : { annotations }),
    ...(icons === undefined ? {} : { icons }),
  });
  const handle = freezeHandle<McpTool>({ kind: 'tool', name });
  tools.set(handle, record);
  return handle;
}

const RESOURCE_FIELDS = [
  'uri',
  'name',
  'title',
  'description',
  'mimeType',
  'icons',
  'access',
  'cache',
  'read',
] as const;

/** Define a resource at a fixed URI. */
export function defineMcpResource(spec: McpResourceSpec): McpResource {
  checkSpec(spec, 'resource', RESOURCE_FIELDS);
  if (!isAbsoluteUri(spec.uri) || new URL(spec.uri).href !== spec.uri) {
    throw new McpDefinitionError(
      'invalid_uri',
      'resource uri must be an absolute URI in canonical form',
    );
  }
  const uri = spec.uri;
  const owner = `resource:${uri}`;
  const access = checkAccess(spec.access, owner);
  const title = optionalLabel(spec.title, 'resource', 'title', owner);
  const description = optionalLabel(spec.description, 'resource', 'description', owner);
  const mimeType = optionalMimeType(spec.mimeType, 'resource', owner);
  const icons = checkIcons(spec.icons, owner);
  const record: ResourceRecord = Object.freeze({
    kind: 'resource',
    uri,
    name: checkLabel(spec.name, 'resource', 'name', owner),
    access,
    cache: checkCache(spec.cache, access, owner),
    read: checkFunction<ResourceRecord['read']>(spec.read, 'resource', 'read', owner),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(icons === undefined ? {} : { icons }),
  });
  const handle = freezeHandle<McpResource>({ kind: 'resource', uri });
  resources.set(handle, record);
  return handle;
}

const TEMPLATE_FIELDS = [
  'uriTemplate',
  'name',
  'title',
  'description',
  'mimeType',
  'icons',
  'params',
  'access',
  'cache',
  'complete',
  'list',
  'read',
] as const;

/** Define a resource template whose variables are validated by `params`. */
export function defineMcpResourceTemplate<P extends McpSchema>(
  spec: McpResourceTemplateSpec<P>,
): McpResourceTemplate {
  checkSpec(spec, 'resource template', TEMPLATE_FIELDS);
  const name = checkName(spec.name, 'resource template');
  const owner = `resource-template:${name}`;
  const parsed = parseUriTemplate(spec.uriTemplate, owner);
  const access = checkAccess(spec.access, owner);
  const params = projectSchema(spec.params, 'params', owner);
  const declared = propertyNames(params.json);
  const variables = parsed.variables.map((variable) => variable.name);
  if (
    declared.length !== variables.length ||
    !variables.every((variable) => declared.includes(variable))
  ) {
    throw new McpDefinitionError(
      'invalid_schema',
      'the params schema must declare exactly the template variables',
      { definition: owner },
    );
  }
  const title = optionalLabel(spec.title, 'resource template', 'title', owner);
  const description = optionalLabel(spec.description, 'resource template', 'description', owner);
  const mimeType = optionalMimeType(spec.mimeType, 'resource template', owner);
  const icons = checkIcons(spec.icons, owner);
  const record: TemplateRecord = Object.freeze({
    kind: 'resource-template',
    uriTemplate: parsed.template,
    parsed,
    name,
    params,
    access,
    cache: checkCache(spec.cache, access, owner),
    completers: checkCompleters(spec.complete, variables, 'resource template', owner),
    list:
      spec.list === undefined
        ? undefined
        : checkFunction<NonNullable<TemplateRecord['list']>>(
            spec.list,
            'resource template',
            'list',
            owner,
          ),
    read: checkFunction<AnyHandler>(spec.read, 'resource template', 'read', owner),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(icons === undefined ? {} : { icons }),
  });
  const handle = freezeHandle<McpResourceTemplate>({
    kind: 'resource-template',
    uriTemplate: parsed.template,
  });
  templates.set(handle, record);
  return handle;
}

const PROMPT_FIELDS = [
  'name',
  'title',
  'description',
  'icons',
  'args',
  'access',
  'complete',
  'render',
] as const;

/** Define a prompt. */
export function defineMcpPrompt<A extends McpSchema | undefined = undefined>(
  spec: McpPromptSpec<A>,
): McpPrompt {
  checkSpec(spec, 'prompt', PROMPT_FIELDS);
  const name = checkName(spec.name, 'prompt');
  const owner = `prompt:${name}`;
  const access = checkAccess(spec.access, owner);
  const args = spec.args === undefined ? undefined : projectSchema(spec.args, 'arguments', owner);
  if (spec.complete !== undefined && args === undefined) {
    throw definitionError('prompt', 'complete needs an args schema', owner);
  }
  const title = optionalLabel(spec.title, 'prompt', 'title', owner);
  const description = optionalLabel(spec.description, 'prompt', 'description', owner);
  const icons = checkIcons(spec.icons, owner);
  const record: PromptRecord = Object.freeze({
    kind: 'prompt',
    name,
    args,
    access,
    completers: checkCompleters(
      spec.complete,
      args === undefined ? [] : propertyNames(args.json),
      'prompt',
      owner,
    ),
    render: checkFunction<AnyHandler>(spec.render, 'prompt', 'render', owner),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(icons === undefined ? {} : { icons }),
  });
  const handle = freezeHandle<McpPrompt>({ kind: 'prompt', name });
  prompts.set(handle, record);
  return handle;
}

const SERVER_FIELDS = [
  'name',
  'version',
  'title',
  'instructions',
  'tools',
  'resources',
  'prompts',
  'listCacheTtlMs',
] as const;

function handles(value: unknown, field: string): readonly unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw definitionError('server', `${field} must be an array`);
  }
  return value;
}

function lookup<R>(table: WeakMap<object, R>, handle: unknown, field: string): R {
  const record = typeof handle === 'object' && handle !== null ? table.get(handle) : undefined;
  if (record === undefined) {
    throw definitionError('server', `${field} holds a value its define function did not create`);
  }
  return record;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique<R>(
  records: readonly R[],
  key: (record: R) => string,
  code: 'duplicate_tool' | 'duplicate_resource' | 'duplicate_prompt',
  what: string,
): void {
  const seen = new Set<string>();
  for (const record of records) {
    const value = key(record);
    if (seen.has(value)) {
      throw new McpDefinitionError(
        code,
        `the server defines two ${what} with the same identifier`,
        {
          identifier: value,
        },
      );
    }
    seen.add(value);
  }
}

function listCache(ttlMs: number, items: readonly RecordBase[]): ListCacheHint {
  return Object.freeze({
    ttlMs,
    cacheScope: items.every((item) => isPublicAccess(item.access)) ? 'public' : 'private',
  });
}

/** Define a server from defined tools, resources, templates, and prompts. */
export function defineMcpServer(spec: McpServerSpec): McpServerDefinition {
  checkSpec(spec, 'server', SERVER_FIELDS);
  const name = checkLabel(spec.name, 'server', 'name', 'server');
  const version = checkLabel(spec.version, 'server', 'version', 'server');
  const title = optionalLabel(spec.title, 'server', 'title', 'server');
  const instructions = optionalLabel(spec.instructions, 'server', 'instructions', 'server');
  const ttlMs = spec.listCacheTtlMs ?? 0;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new McpDefinitionError(
      'invalid_cache_hint',
      'listCacheTtlMs must be a non-negative safe integer',
    );
  }
  const toolRecords = handles(spec.tools, 'tools').map((handle) => lookup(tools, handle, 'tools'));
  const promptRecords = handles(spec.prompts, 'prompts').map((handle) =>
    lookup(prompts, handle, 'prompts'),
  );
  const resourceRecords: ResourceRecord[] = [];
  const templateRecords: TemplateRecord[] = [];
  for (const handle of handles(spec.resources, 'resources')) {
    const resource =
      typeof handle === 'object' && handle !== null ? resources.get(handle) : undefined;
    if (resource !== undefined) {
      resourceRecords.push(resource);
    } else {
      templateRecords.push(lookup(templates, handle, 'resources'));
    }
  }
  unique(toolRecords, (record) => record.name, 'duplicate_tool', 'tools');
  unique(promptRecords, (record) => record.name, 'duplicate_prompt', 'prompts');
  unique(resourceRecords, (record) => record.uri, 'duplicate_resource', 'resources');
  unique(templateRecords, (record) => record.name, 'duplicate_resource', 'resource templates');
  unique(
    templateRecords,
    (record) => record.uriTemplate,
    'duplicate_resource',
    'resource templates',
  );
  toolRecords.sort((left, right) => compare(left.name, right.name));
  promptRecords.sort((left, right) => compare(left.name, right.name));
  resourceRecords.sort((left, right) => compare(left.uri, right.uri));
  templateRecords.sort((left, right) => compare(left.name, right.name));
  const everything: readonly RecordBase[] = [
    ...toolRecords,
    ...resourceRecords,
    ...templateRecords,
    ...promptRecords,
  ];
  const record: ServerRecord = Object.freeze({
    name,
    version,
    tools: Object.freeze(toolRecords),
    resources: Object.freeze(resourceRecords),
    templates: Object.freeze(templateRecords),
    prompts: Object.freeze(promptRecords),
    listCache: Object.freeze({
      tools: listCache(ttlMs, toolRecords),
      resources: listCache(ttlMs, [...resourceRecords, ...templateRecords]),
      prompts: listCache(ttlMs, promptRecords),
    }),
    gated: everything.some((item) => !isPublicAccess(item.access)),
    completions: [...templateRecords, ...promptRecords].some((item) => item.completers.size > 0),
    ...(title === undefined ? {} : { title }),
    ...(instructions === undefined ? {} : { instructions }),
  });
  const handle = freezeHandle<McpServerDefinition>({ kind: 'server', name, version });
  servers.set(handle, record);
  return handle;
}

/** The identifier a gate and error context use for a record. */
export function itemName(
  record: ToolRecord | ResourceRecord | TemplateRecord | PromptRecord,
): string {
  switch (record.kind) {
    case 'resource':
      return record.uri;
    case 'resource-template':
      return record.uriTemplate;
    default:
      return record.name;
  }
}
