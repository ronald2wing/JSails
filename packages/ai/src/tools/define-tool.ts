/**
 * {@link defineTool}: a tool the model can call, run under the caller's
 * authority.
 *
 * The input is a Zod schema or a structural contract (a `jsails/data`
 * contract fits). `execute` receives the validated input and a context that
 * carries the app context (at least the actor), the tool call id, the step,
 * and an abort signal that fires on run abort or the tool's deadline.
 * `authorize` runs after input validation and before approval and execution;
 * `needsApproval` makes the run stop for a human decision. A tool is a frozen,
 * branded value; its definition sits under the {@link AI_TOOL} key for the run
 * loop and adapters.
 *
 * The input property `INVALID_JSON` is reserved: the adapters wrap a tool
 * input that was not a JSON object under it, and such a call always fails.
 *
 * With `strict` (the default) the input schema must lower under both strict
 * profiles at definition time, so a schema that would silently lose its
 * strict guarantee on some provider fails here, loudly, instead.
 */

import type { z } from 'zod';

import { AiError } from '../errors/ai-error.js';
import type { AiBaseContext, AiToolOutput } from '../content/types.js';
import { isPlainObject } from '../content/json-value.js';
import { INVALID_JSON_KEY } from '../provider/wire-format.js';
import type { JsonSchema } from '../structured-output/schema-restore.js';
import { lowerJsonSchema, zodInputJsonSchema } from '../structured-output/schema-lowering.js';
import {
  resolveSchemaSource,
  type AiSchemaOutput,
  type AiSchemaSource,
  type AiStructuralContract,
} from '../structured-output/schema-source.js';

/** The brand key under which a tool keeps its definition. */
export const AI_TOOL: unique symbol = Symbol('jsails.ai.tool');

/** Provider-safe tool names (Anthropic and OpenAI). */
export const AI_TOOL_NAME_PATTERN: RegExp = /^[A-Za-z0-9_-]{1,64}$/;

/** The default tool deadline in milliseconds. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** The longest deadline a timer can hold. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** What a tool's `execute`, `authorize`, and `needsApproval` receive. */
export type AiToolContext<C extends AiBaseContext = AiBaseContext> = C & {
  readonly toolCallId: string;
  /** Fires when the run is aborted or the tool's deadline passes. */
  readonly signal: AbortSignal;
  /** The zero-based step of the run that made the call. */
  readonly step: number;
};

/** One reason an input failed validation: where, and the issue code. Never the value. */
export interface AiInputIssue {
  readonly path: string;
  readonly code: string;
}

/** The outcome of validating a tool input. */
export type AiInputCheck<I> =
  | { readonly ok: true; readonly value: I }
  | { readonly ok: false; readonly issues: readonly AiInputIssue[] };

/** The outcome of validating a tool result. */
export type AiOutputCheck<O> = { readonly ok: true; readonly value: O } | { readonly ok: false };

/**
 * A tool's behaviour, read by the run loop. Every member is a method, so a
 * tool typed for a specific input and context is still assignable where any
 * tool is accepted.
 */
export interface AiToolDefinition<I, O, C extends AiBaseContext> {
  /** The input JSON Schema before lowering. Its root is an object schema. */
  readonly inputJsonSchema: JsonSchema;
  validateInput(value: unknown): AiInputCheck<I>;
  validateOutput(value: unknown): AiOutputCheck<O>;
  authorize(input: I, ctx: AiToolContext<C>): boolean | Promise<boolean>;
  needsApproval(input: I, ctx: AiToolContext<C>): boolean | Promise<boolean>;
  execute(input: I, ctx: AiToolContext<C>): unknown;
  /** Present only when the tool maps its own result to model output. */
  toModelOutput?(output: O): AiToolOutput;
}

/** A tool the model can call. */
export interface AiTool<I = unknown, O = unknown, C extends AiBaseContext = AiBaseContext> {
  readonly name: string;
  readonly description: string;
  /** Whether the tool is sent in strict mode where the provider supports it. */
  readonly strict: boolean;
  /** Whether re-running an interrupted call is safe. */
  readonly idempotent: boolean;
  /** Whether the browser event stream may carry this tool's input and output. */
  readonly exposeToBrowser: boolean;
  readonly timeoutMs: number;
  /** A per-tool cap on result characters; the run's cap applies when absent. */
  readonly maxResultChars: number | undefined;
  /** A per-tool cap on decoded image bytes in one result; the run's cap applies when absent. */
  readonly maxResultMediaBytes: number | undefined;
  readonly [AI_TOOL]: AiToolDefinition<I, O, C>;
}

/** A tool output schema: Zod, or a structural contract. */
export type AiToolResultSchema<O> = z.ZodType<O> | AiStructuralContract<z.ZodType<O>>;

/** The spec {@link defineTool} accepts. */
export interface DefineToolSpec<S extends AiSchemaSource, R, C extends AiBaseContext> {
  /** Defaults to the contract name when `input` is a contract. */
  readonly name?: string;
  /** Defaults to the contract description when `input` is a contract. */
  readonly description?: string;
  readonly input: S;
  /** Validates the result of `execute`; a mismatch becomes a fixed error result. */
  readonly output?: AiToolResultSchema<Awaited<R>>;
  /** Send in strict mode where supported (default `true`). */
  readonly strict?: boolean;
  /** Safe to re-run when a call was interrupted (default `false`). */
  readonly idempotent?: boolean;
  /** Stop the run for a human decision before executing (default `false`). */
  readonly needsApproval?:
    boolean | ((input: AiSchemaOutput<S>, ctx: AiToolContext<C>) => boolean | Promise<boolean>);
  /** Decide whether the caller may run this call; a denial or a throw refuses it. */
  readonly authorize?: (
    input: AiSchemaOutput<S>,
    ctx: AiToolContext<C>,
  ) => boolean | Promise<boolean>;
  /** The tool's deadline in milliseconds (default 30 000). */
  readonly timeoutMs?: number;
  /** A cap on result characters below the run's cap. */
  readonly maxResultChars?: number;
  /** A cap on decoded image bytes in one result below the run's cap. */
  readonly maxResultMediaBytes?: number;
  /** Let the browser event stream carry this tool's input and output (default `false`). */
  readonly exposeToBrowser?: boolean;
  readonly execute: (input: AiSchemaOutput<S>, ctx: AiToolContext<C>) => R;
  /** Map the (validated) result to model output instead of serializing it. */
  readonly toModelOutput?: (output: Awaited<R>) => AiToolOutput;
}

/** `name` and `description` are required unless the input is a contract that supplies them. */
export type DefineToolNaming<S> = S extends AiStructuralContract
  ? { readonly name?: string; readonly description?: string }
  : { readonly name: string; readonly description: string };

function invalidTool(reason: string): AiError {
  return new AiError('invalid_tool', 'the tool definition is invalid', { context: { reason } });
}

function readFlag(value: unknown, fallback: boolean, reason: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalidTool(reason);
  return value;
}

function readPositiveInt(value: unknown, reason: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw invalidTool(reason);
  }
  return value;
}

function issuesOf(error: z.ZodError): readonly AiInputIssue[] {
  return Object.freeze(
    error.issues.slice(0, 20).map((issue) =>
      Object.freeze({
        path:
          issue.path.length === 0
            ? '(root)'
            : issue.path.map((segment) => String(segment)).join('.'),
        code: issue.code,
      }),
    ),
  );
}

function isObjectRoot(schema: JsonSchema): boolean {
  return schema.type === 'object' && schema.anyOf === undefined && schema.oneOf === undefined;
}

/**
 * Whether an object input schema declares the property the adapters reserve
 * for input that was not a JSON object.
 */
export function declaresReservedProperty(schema: JsonSchema): boolean {
  return isPlainObject(schema.properties) && Object.hasOwn(schema.properties, INVALID_JSON_KEY);
}

/**
 * Define a tool. Throws `AiError('invalid_tool')` (value-free, with a static
 * `reason`) for an invalid name or description, an input that is not an
 * object schema or declares the reserved `INVALID_JSON` property, a schema that cannot be lowered while `strict` is on, or a
 * malformed option.
 */
export function defineTool<S extends AiSchemaSource, R, C extends AiBaseContext = AiBaseContext>(
  spec: DefineToolSpec<S, R, C> & DefineToolNaming<S>,
): AiTool<AiSchemaOutput<S>, Awaited<R>, C> {
  if (typeof spec !== 'object' || spec === null) throw invalidTool('spec');
  const input = resolveSchemaSource(spec.input);
  if (input === undefined) throw invalidTool('input');
  const name = spec.name ?? input.name;
  if (typeof name !== 'string' || !AI_TOOL_NAME_PATTERN.test(name)) throw invalidTool('name');
  const description = spec.description ?? input.description;
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw invalidTool('description');
  }
  if (typeof spec.execute !== 'function') throw invalidTool('execute');
  let output: z.ZodType | undefined;
  if (spec.output !== undefined) {
    output = resolveSchemaSource(spec.output)?.schema;
    if (output === undefined) throw invalidTool('output');
  }
  if (spec.toModelOutput !== undefined && typeof spec.toModelOutput !== 'function') {
    throw invalidTool('to_model_output');
  }
  const needsApproval = spec.needsApproval;
  if (
    needsApproval !== undefined &&
    typeof needsApproval !== 'boolean' &&
    typeof needsApproval !== 'function'
  ) {
    throw invalidTool('needs_approval');
  }
  if (spec.authorize !== undefined && typeof spec.authorize !== 'function') {
    throw invalidTool('authorize');
  }
  const strict = readFlag(spec.strict, true, 'strict');
  const idempotent = readFlag(spec.idempotent, false, 'idempotent');
  const exposeToBrowser = readFlag(spec.exposeToBrowser, false, 'expose_to_browser');
  const timeoutMs = readPositiveInt(spec.timeoutMs, 'timeout') ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxResultChars = readPositiveInt(spec.maxResultChars, 'max_result_chars');
  const maxResultMediaBytes = readPositiveInt(spec.maxResultMediaBytes, 'max_result_media_bytes');

  const inputJsonSchema = zodInputJsonSchema(input.schema, 'invalid_tool');
  if (!isObjectRoot(inputJsonSchema)) throw invalidTool('input_not_object');
  if (declaresReservedProperty(inputJsonSchema)) throw invalidTool('reserved_property');
  lowerJsonSchema(inputJsonSchema, 'loose', 'invalid_tool');
  if (strict) {
    lowerJsonSchema(inputJsonSchema, 'anthropic-strict', 'invalid_tool');
    lowerJsonSchema(inputJsonSchema, 'openai-strict', 'invalid_tool');
  }

  type I = AiSchemaOutput<S>;
  type O = Awaited<R>;
  const inputSchema = input.schema;
  const execute = spec.execute;
  const authorize = spec.authorize;
  const toModelOutput = spec.toModelOutput;
  const definition: AiToolDefinition<I, O, C> = {
    inputJsonSchema,
    validateInput(value) {
      const parsed = inputSchema.safeParse(value);
      return parsed.success
        ? { ok: true, value: parsed.data as I }
        : { ok: false, issues: issuesOf(parsed.error) };
    },
    validateOutput(value) {
      if (output === undefined) return { ok: true, value: value as O };
      const parsed = output.safeParse(value);
      return parsed.success ? { ok: true, value: parsed.data as O } : { ok: false };
    },
    authorize(value, ctx) {
      return authorize === undefined ? true : authorize(value, ctx);
    },
    needsApproval(value, ctx) {
      if (needsApproval === undefined) return false;
      return typeof needsApproval === 'boolean' ? needsApproval : needsApproval(value, ctx);
    },
    execute(value, ctx) {
      return execute(value, ctx);
    },
    ...(toModelOutput === undefined
      ? {}
      : {
          toModelOutput(value: O): AiToolOutput {
            return toModelOutput(value);
          },
        }),
  };
  return Object.freeze({
    name,
    description,
    strict,
    idempotent,
    exposeToBrowser,
    timeoutMs,
    maxResultChars,
    maxResultMediaBytes,
    [AI_TOOL]: Object.freeze(definition),
  });
}

/** Whether `value` is a tool made by {@link defineTool} (or another tool constructor). */
export function isAiTool(value: unknown): value is AiTool {
  return typeof value === 'object' && value !== null && AI_TOOL in value;
}
