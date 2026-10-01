/**
 * Run option validation: {@link readRunOptions} checks every option of a run
 * before anything is sent and returns the normalized setup the loop runs on.
 *
 * Everything that can be judged without calling the provider fails here,
 * synchronously, as a value-free `AiError`: bad options (`invalid_options`),
 * a bad transcript (`invalid_messages`), bad untrusted input or approvals
 * (`invalid_input`), and a request the provider cannot serve
 * (`unsupported_capability`). The transcript is split at its trust boundary:
 * `history` is the server's; `input` is the browser's, a string or a message
 * `parseUserInput` made, and nothing else.
 */

import { AiError } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import type { AiActor, AiBaseContext, AiMessage } from '../content/types.js';
import { isParsedUserInput } from '../content/user-input.js';
import {
  checkTranscript,
  readMessage,
  toolCallsOf,
  validateMessages,
} from '../content/validate-messages.js';
import type {
  AiInstruction,
  AiModel,
  AiProvider,
  AiProviderOptions,
  AiToolSpec,
} from '../provider/contract.js';
import {
  readCacheMode,
  readEffort,
  readHeaders,
  readInstructions,
  readMaxOutputTokens,
  readModel,
  readPositiveInteger,
  readReasoning,
  readStopSequences,
  readTimeout,
} from '../provider/request-fields.js';
import type { AiSchemaProfile } from '../structured-output/schema-lowering.js';
import { isAiTool, type AiTool } from '../tools/define-tool.js';
import {
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  toolSchemaProfile,
  toolSpec,
} from '../tools/tool-invocation.js';
import {
  DEFAULT_MAX_TOOL_RESULT_IMAGES,
  DEFAULT_MAX_TOOL_RESULT_MEDIA_BYTES,
} from '../tools/tool-serialization.js';
import type { AiPricing } from '../usage/pricing.js';
import { ZERO_USAGE } from '../usage/usage.js';
import { bindApprovals, readApprovals } from './approvals.js';
import type { AiApproval, AiCheckpoint, AiRunOptions } from './run-contract.js';

/** The default number of provider calls in one run. */
export const DEFAULT_MAX_STEPS = 8;

/** The default number of tool calls one response may make. */
export const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 16;

/** The default number of tool calls running at once. */
export const DEFAULT_TOOL_CONCURRENCY = 4;

/** The default longest silence between streamed parts, in milliseconds. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/** A checkpoint hook. */
type CheckpointHook = (checkpoint: AiCheckpoint) => void | Promise<void>;

/** The validated, normalized setup of one run. */
export interface RunSetup<C extends AiBaseContext> {
  readonly model: AiModel;
  readonly provider: AiProvider;
  readonly instructions: readonly AiInstruction[];
  readonly history: readonly AiMessage[];
  readonly input: AiMessage | undefined;
  /** The trailing assistant message of `history` whose calls have no results yet. */
  readonly resume: AiMessage | undefined;
  readonly approvals: ReadonlyMap<string, AiApproval>;
  readonly tools: ReadonlyMap<string, AiTool<unknown, unknown, C>>;
  readonly toolProfiles: ReadonlyMap<string, AiSchemaProfile>;
  readonly toolSpecs: readonly AiToolSpec[];
  readonly context: C | undefined;
  readonly actor: AiActor | undefined;
  readonly toolChoice: 'auto' | 'none';
  /** Whether the request lets one response call several tools. */
  readonly parallelToolCalls: boolean;
  readonly toolConcurrency: number;
  readonly maxOutputTokens: number;
  readonly effort: AiRunOptions['effort'];
  readonly reasoning: AiRunOptions['reasoning'];
  readonly stopSequences: readonly string[] | undefined;
  readonly cache: 'auto' | 'off';
  readonly maxSteps: number;
  readonly maxToolCallsPerStep: number;
  readonly maxToolResultChars: number;
  readonly maxToolResultMediaBytes: number;
  readonly maxToolResultImages: number;
  readonly maxInputTokens: number | undefined;
  readonly maxOutputTokensTotal: number | undefined;
  readonly maxCostMicroUsd: number | undefined;
  readonly pricing: AiPricing | undefined;
  readonly timeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly providerOptions: AiProviderOptions | undefined;
  readonly onStepFinish: CheckpointHook | undefined;
  readonly onToolResults: CheckpointHook | undefined;
}

function invalidOptions(reason: string): AiError {
  return new AiError('invalid_options', 'the run options are invalid', { context: { reason } });
}

function invalidInput(reason: string): AiError {
  return new AiError('invalid_input', 'the input is invalid', { context: { reason } });
}

function unsupported(capability: string): AiError {
  return new AiError('unsupported_capability', 'the provider does not support this request', {
    context: { capability },
  });
}

/**
 * Read the untrusted input: a non-empty string, or a message
 * `parseUserInput` made. Any other message is refused (`unparsed`), however
 * well it is formed: only the parser drops cache flags, refuses URL sources
 * the app did not allow, sniffs media, and enforces the size limits.
 */
function readInput(value: unknown, index: number): AiMessage | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value.trim().length === 0) throw invalidInput('empty');
    return readMessage({ role: 'user', parts: [{ type: 'text', text: value }] }, index);
  }
  if (!isParsedUserInput(value)) throw invalidInput('unparsed');
  return value;
}

/**
 * Check an app context and its actor. The context must be a plain object:
 * tools receive a copy of its own properties, so a class instance would hand
 * them a context without its getters or methods while the type says
 * otherwise.
 */
function readActor(context: unknown): AiActor {
  if (!isPlainObject(context)) throw invalidOptions('context');
  const actor = (context as { readonly actor?: unknown }).actor;
  if (typeof actor !== 'object' || actor === null) throw invalidOptions('actor');
  const { kind, id } = actor as { readonly kind?: unknown; readonly id?: unknown };
  if (kind === 'anonymous') {
    if (id !== undefined && (typeof id !== 'string' || id.length === 0 || id.length > 256)) {
      throw invalidOptions('actor');
    }
    return actor as AiActor;
  }
  if (kind !== 'user' && kind !== 'service') throw invalidOptions('actor');
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) throw invalidOptions('actor');
  return actor as AiActor;
}

function readFlag(value: unknown, fallback: boolean, reason: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalidOptions(reason);
  return value;
}

function readOptionalLimit(value: unknown, reason: string): number | undefined {
  if (value === undefined) return undefined;
  return readPositiveInteger(value, 0, reason, invalidOptions);
}

function readHook(value: unknown, reason: string): CheckpointHook | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') throw invalidOptions(reason);
  return value as CheckpointHook;
}

/** Refuse media the provider cannot read anywhere in the transcript. */
function checkMedia(messages: readonly AiMessage[], provider: AiProvider): void {
  const { images, pdf } = provider.capabilities;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'image' && !images) throw unsupported('images');
      if (part.type === 'file' && part.mediaType === 'application/pdf' && !pdf) {
        throw unsupported('pdf');
      }
      if (part.type === 'tool-result' && typeof part.output !== 'string' && !images) {
        if (part.output.some((item) => item.type === 'image')) throw unsupported('images');
      }
    }
  }
}

function readPricing(value: unknown, model: AiModel): AiPricing | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') throw invalidOptions('pricing');
  const pricing = value as AiPricing;
  // Price nothing up front, so an unpriced model fails before any token is spent.
  const cost = pricing(ZERO_USAGE, { provider: model.provider.id, model: model.id });
  if (!Number.isSafeInteger(cost) || cost < 0) throw invalidOptions('pricing');
  return pricing;
}

/**
 * Validate run options and build the loop's setup. Throws a value-free
 * `AiError` for anything wrong; see the module comment.
 */
export function readRunOptions<C extends AiBaseContext>(options: AiRunOptions<C>): RunSetup<C> {
  if (typeof options !== 'object' || options === null) throw invalidOptions('options');
  const model = readModel(options.model, invalidOptions);
  const provider = model.provider;
  if (typeof provider.stream !== 'function') throw invalidOptions('model');

  const history = validateMessages(options.history ?? [], { mode: 'transcript' });
  const input = readInput(options.input, history.length);
  let resume: AiMessage | undefined;
  if (input !== undefined) {
    checkTranscript([...history, input], 'request');
  } else {
    const last = history.at(-1);
    if (last !== undefined && last.role === 'assistant' && toolCallsOf(last).length > 0) {
      resume = last;
    } else {
      checkTranscript(history, 'request');
    }
  }

  const approvals = readApprovals(options.approvals);

  const rawTools: unknown = options.tools ?? [];
  if (!Array.isArray(rawTools)) throw invalidOptions('tools');
  const tools = new Map<string, AiTool<unknown, unknown, C>>();
  const toolProfiles = new Map<string, AiSchemaProfile>();
  const toolSpecs: AiToolSpec[] = [];
  for (const tool of rawTools as readonly unknown[]) {
    if (!isAiTool(tool)) throw invalidOptions('tools');
    if (tools.has(tool.name)) throw invalidOptions('duplicate_tool');
    const profile = toolSchemaProfile(tool, provider.capabilities);
    tools.set(tool.name, tool);
    toolProfiles.set(tool.name, profile);
    toolSpecs.push(toolSpec(tool, profile));
  }
  if (tools.size > 0 && !provider.capabilities.tools) throw unsupported('tools');

  let actor: AiActor | undefined;
  if (options.context !== undefined) actor = readActor(options.context);
  else if (tools.size > 0) throw invalidOptions('context');
  bindApprovals(approvals, resume, actor);

  const toolChoice = options.toolChoice ?? 'auto';
  if (toolChoice !== 'auto' && toolChoice !== 'none') throw invalidOptions('tool_choice');
  const parallel = readFlag(options.parallelToolCalls, true, 'parallel_tool_calls');

  const limits: unknown = options.limits ?? {};
  if (!isPlainObject(limits)) throw invalidOptions('limits');
  const maxCostMicroUsd = readOptionalLimit(limits.maxCostMicroUsd, 'max_cost');
  const pricing = readPricing(options.pricing, model);
  if (maxCostMicroUsd !== undefined && pricing === undefined) {
    throw invalidOptions('max_cost_without_pricing');
  }

  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw invalidOptions('signal');
  }
  if (options.providerOptions !== undefined && !isPlainObject(options.providerOptions)) {
    throw invalidOptions('provider_options');
  }

  const messages = input === undefined ? history : [...history, input];
  checkMedia(messages, provider);

  return Object.freeze({
    model,
    provider,
    instructions: readInstructions(options.instructions, invalidOptions),
    history,
    input,
    resume,
    approvals,
    tools,
    toolProfiles,
    toolSpecs: Object.freeze(toolSpecs),
    context: options.context,
    actor,
    toolChoice,
    parallelToolCalls: parallel && provider.capabilities.parallelTools,
    toolConcurrency: parallel
      ? readPositiveInteger(
          limits.toolConcurrency,
          DEFAULT_TOOL_CONCURRENCY,
          'tool_concurrency',
          invalidOptions,
        )
      : 1,
    maxOutputTokens: readMaxOutputTokens(options.maxOutputTokens, invalidOptions),
    effort: readEffort(options.effort, invalidOptions),
    reasoning: readReasoning(options.reasoning, invalidOptions),
    stopSequences: readStopSequences(options.stopSequences, invalidOptions),
    cache: readCacheMode(options.cache, invalidOptions),
    maxSteps: readPositiveInteger(limits.maxSteps, DEFAULT_MAX_STEPS, 'max_steps', invalidOptions),
    maxToolCallsPerStep: readPositiveInteger(
      limits.maxToolCallsPerStep,
      DEFAULT_MAX_TOOL_CALLS_PER_STEP,
      'max_tool_calls_per_step',
      invalidOptions,
    ),
    maxToolResultChars: readPositiveInteger(
      limits.maxToolResultChars,
      DEFAULT_MAX_TOOL_RESULT_CHARS,
      'max_tool_result_chars',
      invalidOptions,
    ),
    maxToolResultMediaBytes: readPositiveInteger(
      limits.maxToolResultMediaBytes,
      DEFAULT_MAX_TOOL_RESULT_MEDIA_BYTES,
      'max_tool_result_media_bytes',
      invalidOptions,
    ),
    maxToolResultImages: readPositiveInteger(
      limits.maxToolResultImages,
      DEFAULT_MAX_TOOL_RESULT_IMAGES,
      'max_tool_result_images',
      invalidOptions,
    ),
    maxInputTokens: readOptionalLimit(limits.maxInputTokens, 'max_input_tokens'),
    maxOutputTokensTotal: readOptionalLimit(limits.maxOutputTokensTotal, 'max_output_tokens_total'),
    maxCostMicroUsd,
    pricing,
    timeoutMs: readTimeout(options.timeoutMs, 0, 'timeout', invalidOptions),
    idleTimeoutMs: readTimeout(
      options.idleTimeoutMs,
      DEFAULT_IDLE_TIMEOUT_MS,
      'idle_timeout',
      invalidOptions,
    ),
    signal: options.signal,
    headers: readHeaders(options.headers, invalidOptions),
    providerOptions: options.providerOptions,
    onStepFinish: readHook(options.onStepFinish, 'on_step_finish'),
    onToolResults: readHook(options.onToolResults, 'on_tool_results'),
  });
}
