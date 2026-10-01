/**
 * {@link mcpTools}: the tools of an MCP server as `AiTool`s.
 *
 * An MCP server is someone else's code, so everything it sends is checked
 * and treated as data. A malformed descriptor, a name the providers reject
 * (after the prefix), a duplicate, or an input schema that is not a bounded
 * object schema with local `$ref`s only (or declares the reserved
 * `INVALID_JSON` property, or cannot be lowered) is skipped and
 * reported, never fatal, so one bad tool cannot take the rest
 * down. Tools are sent non-strict (the server validates its own input). On a
 * trusted server the input is also checked against the declared schema here
 * first; on an untrusted one only its shape is checked, because compiling a
 * stranger's patterns would run their regular expressions in this process.
 *
 * Annotations are hints. They count only for a trusted server: there,
 * `approval: 'destructive'` (the default) asks a human before any tool that
 * is not declared read-only and non-destructive, and a read-only or
 * idempotent tool is safe to re-run after an interruption. An untrusted
 * server's tools always need approval and are never re-run. A result's
 * `isError` becomes an error result (its text forwarded, or hidden with
 * `errors: 'hide'`); text and image content map to tool output, embedded text
 * resources become text, other blocks become a fixed placeholder, and
 * `structuredContent` is used as JSON text when the content has nothing
 * usable. Image content counts against the result's media byte and image
 * bounds like any tool's. Cancellation reaches the server through the call's
 * signal.
 */

import { z } from 'zod';

import { AiError } from '../errors/ai-error.js';
import { copyJson, isPlainObject } from '../content/json-value.js';
import { isBase64, sniffMatches } from '../content/media.js';
import {
  AI_IMAGE_MEDIA_TYPES,
  type AiBaseContext,
  type AiImageMediaType,
  type AiToolOutput,
  type AiToolOutputItem,
} from '../content/types.js';
import type { JsonSchema } from '../structured-output/schema-restore.js';
import { lowerJsonSchema } from '../structured-output/schema-lowering.js';
import {
  AI_TOOL,
  AI_TOOL_NAME_PATTERN,
  DEFAULT_TOOL_TIMEOUT_MS,
  declaresReservedProperty,
  type AiInputCheck,
  type AiInputIssue,
  type AiTool,
  type AiToolContext,
  type AiToolDefinition,
} from '../tools/define-tool.js';
import { AiToolFailure } from '../tools/tool-failure.js';
import { MAX_TIMER_MS } from '../provider/request-fields.js';
import type { McpToolAnnotations, McpToolSource } from './mcp-source.js';

/** The input an MCP tool receives: a JSON object. */
export type McpToolInput = Readonly<Record<string, unknown>>;

/** An MCP tool as an `AiTool`. */
export type McpTool<C extends AiBaseContext = AiBaseContext> = AiTool<
  McpToolInput,
  AiToolOutput,
  C
>;

/** When a human must approve a call. */
export type McpApproval = 'always' | 'destructive' | 'never';

/** Why a server tool was left out. */
export type McpSkipReason = 'malformed' | 'name' | 'duplicate' | 'input_schema';

/** A server tool that was left out, and why. */
export interface McpSkippedTool {
  /** The server's name for it, cut to 256 characters (`''` when it had none). */
  readonly name: string;
  readonly reason: McpSkipReason;
}

/** The tools of one server. */
export interface McpToolset<C extends AiBaseContext = AiBaseContext> {
  readonly tools: readonly McpTool<C>[];
  readonly skipped: readonly McpSkippedTool[];
}

/** One call the app's `authorize` hook decides on. */
export interface McpToolCall {
  /** The server's name for the tool (without the prefix). */
  readonly name: string;
  readonly input: McpToolInput;
}

/** Options for {@link mcpTools}. */
export interface McpToolsOptions<C extends AiBaseContext = AiBaseContext> {
  /**
   * Whether the server is the app's own (its annotations and schemas are
   * believed). Required, so trusting a server is always a decision.
   */
  readonly trusted: boolean;
  /** Only these server tool names. */
  readonly include?: readonly string[];
  /** Prepended to every tool name, to keep servers apart. */
  readonly prefix?: string;
  /**
   * Default `destructive` for a trusted server; an untrusted server allows
   * only `always`.
   */
  readonly approval?: McpApproval;
  /** Forward an `isError` result's text to the model (default) or hide it. */
  readonly errors?: 'forward' | 'hide';
  /** Decide whether the caller may make this call; a denial or a throw refuses it. */
  readonly authorize?: (call: McpToolCall, ctx: AiToolContext<C>) => boolean | Promise<boolean>;
  /** Let the browser event stream carry these tools' input and output (default `false`). */
  readonly exposeToBrowser?: boolean;
  /** Each call's deadline in milliseconds (default 30 000). */
  readonly timeoutMs?: number;
  /** A cap on result characters below the run's cap. */
  readonly maxResultChars?: number;
  /** A cap on decoded image bytes in one result below the run's cap. */
  readonly maxResultMediaBytes?: number;
  /** Aborts the listing. */
  readonly signal?: AbortSignal;
}

const MAX_SERVER_NAME_LENGTH = 128;
const MAX_DESCRIPTION_CHARS = 4_096;
/** The largest input schema accepted, as JSON characters. */
const MAX_SCHEMA_CHARS = 65_536;

function invalidOptions(reason: string): AiError {
  return new AiError('invalid_options', 'the MCP tool options are invalid', {
    context: { reason },
  });
}

interface ReadOptions<C extends AiBaseContext> {
  readonly trusted: boolean;
  readonly include: ReadonlySet<string> | undefined;
  readonly prefix: string;
  readonly approval: McpApproval;
  readonly errors: 'forward' | 'hide';
  readonly authorize: McpToolsOptions<C>['authorize'];
  readonly exposeToBrowser: boolean;
  readonly timeoutMs: number;
  readonly maxResultChars: number | undefined;
  readonly maxResultMediaBytes: number | undefined;
  readonly signal: AbortSignal | undefined;
}

function readPositive(value: unknown, reason: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMER_MS
  ) {
    throw invalidOptions(reason);
  }
  return value;
}

function readOptions<C extends AiBaseContext>(options: McpToolsOptions<C>): ReadOptions<C> {
  if (typeof options !== 'object' || options === null) throw invalidOptions('options');
  if (typeof options.trusted !== 'boolean') throw invalidOptions('trusted');
  const trusted = options.trusted;
  const approval = options.approval ?? (trusted ? 'destructive' : 'always');
  if (approval !== 'always' && approval !== 'destructive' && approval !== 'never') {
    throw invalidOptions('approval');
  }
  if (!trusted && approval !== 'always') throw invalidOptions('approval_untrusted');
  const errors = options.errors ?? 'forward';
  if (errors !== 'forward' && errors !== 'hide') throw invalidOptions('errors');
  const prefix = options.prefix ?? '';
  if (typeof prefix !== 'string' || (prefix !== '' && !AI_TOOL_NAME_PATTERN.test(prefix))) {
    throw invalidOptions('prefix');
  }
  let include: ReadonlySet<string> | undefined;
  if (options.include !== undefined) {
    if (
      !Array.isArray(options.include) ||
      !(options.include as readonly unknown[]).every((name) => typeof name === 'string')
    ) {
      throw invalidOptions('include');
    }
    include = new Set(options.include);
  }
  if (options.authorize !== undefined && typeof options.authorize !== 'function') {
    throw invalidOptions('authorize');
  }
  if (options.exposeToBrowser !== undefined && typeof options.exposeToBrowser !== 'boolean') {
    throw invalidOptions('expose_to_browser');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw invalidOptions('signal');
  }
  return {
    trusted,
    include,
    prefix,
    approval,
    errors,
    authorize: options.authorize,
    exposeToBrowser: options.exposeToBrowser === true,
    timeoutMs: readPositive(options.timeoutMs, 'timeout') ?? DEFAULT_TOOL_TIMEOUT_MS,
    maxResultChars: readPositive(options.maxResultChars, 'max_result_chars'),
    maxResultMediaBytes: readPositive(options.maxResultMediaBytes, 'max_result_media_bytes'),
    signal: options.signal,
  };
}

interface Descriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: McpToolAnnotations;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function readAnnotations(value: unknown): McpToolAnnotations | undefined {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return undefined;
  const flags = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;
  const out: Record<string, boolean | string> = {};
  for (const flag of flags) {
    const flagValue = value[flag];
    if (flagValue === undefined) continue;
    if (typeof flagValue !== 'boolean') return undefined;
    out[flag] = flagValue;
  }
  if (!optionalString(value.title)) return undefined;
  if (value.title !== undefined) out.title = value.title;
  return Object.freeze(out);
}

/** Every `$ref` in `value` is local (`#...`): a schema must not point anywhere else. */
function refsAreLocal(value: unknown): boolean {
  if (Array.isArray(value)) return (value as readonly unknown[]).every(refsAreLocal);
  if (!isPlainObject(value)) return true;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && (typeof child !== 'string' || !child.startsWith('#'))) return false;
    if (!refsAreLocal(child)) return false;
  }
  return true;
}

/**
 * A server input schema the bridge will send: an object root, bounded, with
 * local refs only, and without the reserved `INVALID_JSON` property.
 */
function isUsableSchema(schema: unknown): schema is JsonSchema {
  return (
    isPlainObject(schema) &&
    schema.type === 'object' &&
    JSON.stringify(schema).length <= MAX_SCHEMA_CHARS &&
    refsAreLocal(schema) &&
    !declaresReservedProperty(schema)
  );
}

function cut(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

/** A descriptor's checked fields, or the reason to skip it. */
function readDescriptor(value: unknown): Descriptor | McpSkipReason {
  if (!isPlainObject(value)) return 'malformed';
  const { name, title, description } = value;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_SERVER_NAME_LENGTH) {
    return 'malformed';
  }
  if (!optionalString(title) || !optionalString(description)) return 'malformed';
  const annotations = readAnnotations(value.annotations);
  if (annotations === undefined) return 'malformed';
  const schema = copyJson(value.inputSchema);
  if (!isUsableSchema(schema)) return 'input_schema';
  const text = [description, title, annotations.title].find(
    (candidate) => candidate !== undefined && candidate.trim().length > 0,
  );
  return {
    name,
    description: cut(text ?? `The ${name} tool.`, MAX_DESCRIPTION_CHARS),
    inputSchema: schema,
    annotations,
  };
}

function skippedName(value: unknown): string {
  if (!isPlainObject(value) || typeof value.name !== 'string') return '';
  return value.name.slice(0, 256);
}

/** Validation of an input: the declared schema for a trusted server, else a JSON object. */
function inputValidator(
  schema: JsonSchema,
  trusted: boolean,
): (value: unknown) => AiInputCheck<McpToolInput> {
  const notObject: AiInputCheck<McpToolInput> = {
    ok: false,
    issues: Object.freeze([Object.freeze({ path: '(root)', code: 'invalid_type' })]),
  };
  let compiled: z.ZodType | undefined;
  if (trusted) {
    try {
      compiled = z.fromJSONSchema(schema);
    } catch {
      compiled = undefined;
    }
  }
  return (value) => {
    const copied = copyJson(value);
    if (!isPlainObject(copied)) return notObject;
    if (compiled === undefined) return { ok: true, value: copied };
    const parsed = compiled.safeParse(copied);
    if (parsed.success) return { ok: true, value: copied };
    const issues: AiInputIssue[] = parsed.error.issues.slice(0, 20).map((issue) =>
      Object.freeze({
        path: issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.'),
        code: issue.code,
      }),
    );
    return { ok: false, issues: Object.freeze(issues) };
  };
}

function needsApprovalFor(approval: McpApproval, annotations: McpToolAnnotations): boolean {
  if (approval === 'always') return true;
  if (approval === 'never') return false;
  return !(annotations.readOnlyHint === true || annotations.destructiveHint === false);
}

const CONTENT_TYPE = /^[a-z_]{1,32}$/;

/** One mapped block: the item, and whether it carries real content. */
interface MappedBlock {
  readonly item: AiToolOutputItem;
  readonly usable: boolean;
}

function placeholder(type: unknown): MappedBlock {
  const label = typeof type === 'string' && CONTENT_TYPE.test(type) ? type : 'unknown';
  return {
    item: Object.freeze({ type: 'text', text: `[omitted MCP content: ${label}]` }),
    usable: false,
  };
}

function usableText(text: string): MappedBlock {
  return { item: Object.freeze({ type: 'text', text }), usable: true };
}

function mapBlock(block: unknown): MappedBlock {
  if (!isPlainObject(block)) return placeholder(undefined);
  if (block.type === 'text') {
    return typeof block.text === 'string' ? usableText(block.text) : placeholder('text');
  }
  if (block.type === 'image') {
    const mediaType = block.mimeType;
    const data = block.data;
    if (
      typeof data === 'string' &&
      typeof mediaType === 'string' &&
      AI_IMAGE_MEDIA_TYPES.includes(mediaType as AiImageMediaType) &&
      isBase64(data) &&
      sniffMatches(data, mediaType as AiImageMediaType)
    ) {
      return {
        item: Object.freeze({
          type: 'image',
          source: Object.freeze({ kind: 'base64', mediaType, data }),
        }),
        usable: true,
      };
    }
    return placeholder('image');
  }
  if (block.type === 'resource' && isPlainObject(block.resource)) {
    const text = block.resource.text;
    return typeof text === 'string' ? usableText(text) : placeholder('resource');
  }
  return placeholder(block.type);
}

function errorText(content: readonly unknown[]): string {
  return content
    .flatMap((block) =>
      isPlainObject(block) && block.type === 'text' && typeof block.text === 'string'
        ? [block.text]
        : [],
    )
    .join('\n');
}

/** Map a `tools/call` result to tool output, or throw for an error result. */
function mapResult(result: unknown, errors: 'forward' | 'hide'): AiToolOutput {
  if (!isPlainObject(result) || !Array.isArray(result.content)) {
    throw new Error('malformed MCP tool result');
  }
  const content = result.content as readonly unknown[];
  if (result.isError === true) {
    const text = errors === 'forward' ? errorText(content) : '';
    if (text.trim().length > 0) throw new AiToolFailure(text);
    throw new Error('MCP tool error');
  }
  const mapped = content.map(mapBlock);
  const items = mapped.map((block) => block.item);
  if (mapped.some((block) => block.usable)) return Object.freeze(items);
  if (result.structuredContent !== undefined) {
    const json = copyJson(result.structuredContent);
    if (json !== undefined) {
      return Object.freeze([...items, Object.freeze({ type: 'text', text: JSON.stringify(json) })]);
    }
  }
  return items.length === 0 ? '' : Object.freeze(items);
}

function buildTool<C extends AiBaseContext>(
  source: McpToolSource,
  descriptor: Descriptor,
  toolName: string,
  options: ReadOptions<C>,
): McpTool<C> {
  const serverName = descriptor.name;
  const validate = inputValidator(descriptor.inputSchema, options.trusted);
  const requiresApproval = needsApprovalFor(options.approval, descriptor.annotations);
  const authorize = options.authorize;
  const errors = options.errors;
  const definition: AiToolDefinition<McpToolInput, AiToolOutput, C> = {
    inputJsonSchema: descriptor.inputSchema,
    validateInput: validate,
    validateOutput(value) {
      return { ok: true, value: value as AiToolOutput };
    },
    authorize(input, ctx) {
      return authorize === undefined ? true : authorize({ name: serverName, input }, ctx);
    },
    needsApproval() {
      return requiresApproval;
    },
    async execute(input, ctx) {
      const result = await source.callTool(serverName, input, { signal: ctx.signal });
      return mapResult(result, errors);
    },
    toModelOutput(output) {
      return output;
    },
  };
  const annotations = descriptor.annotations;
  return Object.freeze({
    name: toolName,
    description: descriptor.description,
    strict: false,
    idempotent:
      options.trusted && (annotations.readOnlyHint === true || annotations.idempotentHint === true),
    exposeToBrowser: options.exposeToBrowser,
    timeoutMs: options.timeoutMs,
    maxResultChars: options.maxResultChars,
    maxResultMediaBytes: options.maxResultMediaBytes,
    [AI_TOOL]: Object.freeze(definition),
  });
}

/**
 * List a server's tools and wrap them as `AiTool`s. Throws
 * `AiError('invalid_options')` for bad options (including an untrusted server
 * with an approval other than `always`); a listing failure propagates from
 * the source (`AiError('mcp_failed')` from {@link fromMcpClient}).
 */
export async function mcpTools<C extends AiBaseContext = AiBaseContext>(
  source: McpToolSource,
  options: McpToolsOptions<C>,
): Promise<McpToolset<C>> {
  if (
    typeof source !== 'object' ||
    source === null ||
    typeof source.listTools !== 'function' ||
    typeof source.callTool !== 'function'
  ) {
    throw invalidOptions('source');
  }
  const read = readOptions(options);
  const listed: unknown = await source.listTools(
    read.signal === undefined ? {} : { signal: read.signal },
  );
  if (!Array.isArray(listed))
    throw new AiError('mcp_failed', 'the MCP server failed to list its tools', {
      context: { reason: 'malformed_list' },
    });
  const tools: McpTool<C>[] = [];
  const skipped: McpSkippedTool[] = [];
  const names = new Set<string>();
  for (const value of listed as readonly unknown[]) {
    const descriptor = readDescriptor(value);
    if (typeof descriptor === 'string') {
      skipped.push(Object.freeze({ name: skippedName(value), reason: descriptor }));
      continue;
    }
    if (read.include !== undefined && !read.include.has(descriptor.name)) continue;
    const toolName = `${read.prefix}${descriptor.name}`;
    if (!AI_TOOL_NAME_PATTERN.test(toolName)) {
      skipped.push(Object.freeze({ name: descriptor.name, reason: 'name' }));
      continue;
    }
    if (names.has(toolName)) {
      skipped.push(Object.freeze({ name: descriptor.name, reason: 'duplicate' }));
      continue;
    }
    try {
      lowerJsonSchema(descriptor.inputSchema, 'loose', 'invalid_tool');
    } catch {
      skipped.push(Object.freeze({ name: descriptor.name, reason: 'input_schema' }));
      continue;
    }
    names.add(toolName);
    tools.push(buildTool(source, descriptor, toolName, read));
  }
  return Object.freeze({ tools: Object.freeze(tools), skipped: Object.freeze(skipped) });
}
