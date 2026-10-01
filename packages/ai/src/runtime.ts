/**
 * The AI runtime: the provider-neutral chat/stream/agent surface.
 *
 * `createAiRuntime(transport)` returns a runtime over an {@link AiTransport}:
 *
 * - `chat(messages, options)` — one assistant reply.
 * - `stream(messages, options)` — `AsyncIterable<AiStreamEvent>` (deltas, tool
 *   calls, then the final message).
 * - `run(messages, options)` — the agent loop: resolve tool calls against the
 *   local `tools` and feed results back, bounded by `maxSteps`, until a final
 *   assistant message without tool calls.
 *
 * Model output is untrusted, so the loop is bounded on every axis: rounds
 * (`maxSteps`), tool calls per reply (`maxToolCallsPerStep`), and the size of
 * each result fed back (`maxToolResultChars`). A tool failure ends the run by
 * default; `onToolError: 'report'` instead returns a fixed, value-free error
 * to the model as the tool's result. `signal` aborts between and during steps.
 *
 * The runtime owns message validation, the tool-call loop, and bounds; the
 * transport owns the wire. Browser-safe (no `node:*`).
 */

import {
  AiError,
  assertValidMessages,
  type AiMessage,
  type AiRunOptions,
  type AiStreamEvent,
  type AiTool,
  type AiTransport,
  type AiTransportRequest,
} from './contracts.js';

/** The runtime surface. */
export interface AiRuntime {
  chat(messages: readonly AiMessage[], options?: AiRunOptions): Promise<AiMessage>;
  stream(messages: readonly AiMessage[], options?: AiRunOptions): AsyncIterable<AiStreamEvent>;
  run(messages: readonly AiMessage[], options?: AiRunOptions): Promise<AiMessage>;
}

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 16;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 100_000;

/** Appended to a tool result cut at `maxToolResultChars`. */
const TRUNCATION_MARKER = '\n[truncated]';

/** Fixed tool-result texts for `onToolError: 'report'`; never the error's own text. */
const TOOL_ERROR_TEXT = {
  unknown_tool: 'error: no tool with this name is available',
  invalid_tool_arguments: 'error: the arguments do not match the tool parameters',
  failed: 'error: the tool failed',
} as const;

/** Validated run options with their defaults applied. */
interface ResolvedRunOptions {
  readonly maxSteps: number;
  readonly maxToolCallsPerStep: number;
  readonly maxToolResultChars: number;
  readonly onToolError: 'throw' | 'report';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Validate the caller's options value-free; returns the loop bounds. */
function resolveOptions(options: AiRunOptions | undefined): ResolvedRunOptions {
  if (options === undefined) {
    return {
      maxSteps: DEFAULT_MAX_STEPS,
      maxToolCallsPerStep: DEFAULT_MAX_TOOL_CALLS_PER_STEP,
      maxToolResultChars: DEFAULT_MAX_TOOL_RESULT_CHARS,
      onToolError: 'throw',
    };
  }
  if (options === null || typeof options !== 'object') {
    throw new AiError('invalid_options', 'options must be an object');
  }
  const bounds = {
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    maxToolCallsPerStep: options.maxToolCallsPerStep ?? DEFAULT_MAX_TOOL_CALLS_PER_STEP,
    maxToolResultChars: options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS,
  };
  for (const [name, value] of Object.entries(bounds)) {
    if (!isPositiveInteger(value)) {
      throw new AiError('invalid_options', `${name} must be a positive integer`);
    }
  }
  if (
    options.temperature !== undefined &&
    (typeof options.temperature !== 'number' || !Number.isFinite(options.temperature))
  ) {
    throw new AiError('invalid_options', 'temperature must be a finite number');
  }
  const onToolError = options.onToolError ?? 'throw';
  if (onToolError !== 'throw' && onToolError !== 'report') {
    throw new AiError('invalid_options', 'onToolError must be throw or report');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new AiError('invalid_options', 'signal must be an AbortSignal');
  }
  if (options.tools !== undefined && !Array.isArray(options.tools)) {
    throw new AiError('invalid_options', 'tools must be an array');
  }
  return { ...bounds, onToolError };
}

/** Throw a value-free `aborted` error once the caller's signal has fired. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new AiError('aborted', 'the AI call was aborted');
  }
}

/** Create a runtime over a transport. */
export function createAiRuntime(transport: AiTransport): AiRuntime {
  return {
    chat(messages, options) {
      assertValidMessages(messages);
      resolveOptions(options);
      return chatOnce(transport, messages, options);
    },

    async *stream(messages, options) {
      assertValidMessages(messages);
      resolveOptions(options);
      throwIfAborted(options?.signal);
      if (transport.stream !== undefined) {
        yield* transport.stream(toRequest(messages, options));
        return;
      }
      // No streaming backend: fall back to a single completion, emitted as one
      // message event then done.
      const { message } = await transport.complete(toRequest(messages, options));
      yield { type: 'message', message };
      yield { type: 'done', message };
    },

    run(messages, options) {
      assertValidMessages(messages);
      return runLoop(transport, messages, options, resolveOptions(options));
    },
  };
}

/** One non-streaming completion; a reply that asks for tools is refused. */
async function chatOnce(
  transport: AiTransport,
  messages: readonly AiMessage[],
  options?: AiRunOptions,
): Promise<AiMessage> {
  throwIfAborted(options?.signal);
  const reply = await transport.complete(toRequest(messages, options));
  if (reply.toolCalls.length > 0) {
    // A bare `chat` does not run tools; the caller must use `run` for the
    // loop. The requested tool names are model output and are not echoed.
    throw new AiError('unexpected_tool_calls', 'the completion requested tool calls; use run');
  }
  return reply.message;
}

/** The agent loop: resolve tool calls locally until a final message. */
async function runLoop(
  transport: AiTransport,
  messages: readonly AiMessage[],
  options: AiRunOptions | undefined,
  bounds: ResolvedRunOptions,
): Promise<AiMessage> {
  const tools = options?.tools ?? [];
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const signal = options?.signal;

  // One array, appended in place: the transport gets a snapshot per step.
  const conversation: AiMessage[] = [...messages];
  for (let step = 0; step < bounds.maxSteps; step += 1) {
    throwIfAborted(signal);
    const reply = await transport.complete(toRequest([...conversation], options));
    if (reply.toolCalls.length === 0) {
      return reply.message;
    }
    if (reply.toolCalls.length > bounds.maxToolCallsPerStep) {
      throw new AiError('too_many_tool_calls', 'the reply requested more tool calls than allowed');
    }

    conversation.push(reply.message);
    for (const call of reply.toolCalls) {
      throwIfAborted(signal);
      const content = await callTool(toolsByName.get(call.name), call.arguments, bounds);
      conversation.push({ role: 'tool', content, toolCallId: call.id });
    }
  }

  throw new AiError('loop_exceeded', 'the agent loop exceeded its step bound');
}

/**
 * Run one tool and serialize its result for the model. A failure throws a
 * value-free {@link AiError} in `'throw'` mode, or becomes a fixed error text
 * in `'report'` mode.
 */
async function callTool(
  tool: AiTool | undefined,
  args: Record<string, unknown>,
  bounds: ResolvedRunOptions,
): Promise<string> {
  const report = bounds.onToolError === 'report';
  if (tool === undefined) {
    if (report) return TOOL_ERROR_TEXT.unknown_tool;
    throw new AiError('unknown_tool', 'the model requested an unknown tool');
  }
  let result: unknown;
  try {
    result = await tool.call(args);
  } catch (error) {
    if (report) {
      return error instanceof AiError && error.code === 'invalid_tool_arguments'
        ? TOOL_ERROR_TEXT.invalid_tool_arguments
        : TOOL_ERROR_TEXT.failed;
    }
    if (error instanceof AiError) {
      throw error;
    }
    throw new AiError('tool_failed', 'tool execution failed');
  }
  return capToolResult(stringifyToolResult(result), bounds.maxToolResultChars);
}

/** Cut a serialized result at `max` characters, marking the cut. */
function capToolResult(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, Math.max(0, max - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

/** Serialize a tool result back to the model: strings verbatim, everything else as JSON. */
function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

function toRequest(messages: readonly AiMessage[], options?: AiRunOptions): AiTransportRequest {
  return {
    messages,
    tools: options?.tools ?? [],
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
  };
}
