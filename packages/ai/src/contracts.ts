/**
 * The provider-neutral AI contract: messages, tools, run options, stream
 * events, the transport seam, and the value-free {@link AiError}.
 *
 * Browser-safe (no `node:*`): these are data shapes and contracts only. The
 * transports that move them over a wire live in `transports.ts`. The transport
 * is the same "neutral contract + injectable transport" shape as `jsails/jobs`
 * and `@jsails/mail`: the runtime owns the agent loop (tool calling, bounds)
 * and the transport owns the wire.
 */

import { JsailsError } from 'jsails/plugin-sdk';

/** One message in a conversation. */
export interface AiMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** For `role: 'tool'`, the id of the tool call this result answers. */
  readonly toolCallId?: string;
}

/**
 * A callable tool exposed to the agent loop. `parameters` is a JSON Schema
 * object describing the arguments; `call` invokes it and returns a value that
 * is serialized back to the model.
 */
export interface AiTool {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
  readonly call: (args: Record<string, unknown>) => unknown;
}

/** A tool invocation the model requested. */
export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** Options for a chat/stream/run call. */
export interface AiRunOptions {
  readonly tools?: readonly AiTool[];
  readonly temperature?: number;
  /** Maximum tool-calling rounds in `run` (default 8). */
  readonly maxSteps?: number;
}

/** A streamed event in the order it is produced. */
export type AiStreamEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'tool_call'; readonly toolCall: AiToolCall }
  | { readonly type: 'message'; readonly message: AiMessage }
  | { readonly type: 'done'; readonly message: AiMessage };

/** A single non-streaming completion request to the backend. */
export interface AiTransportRequest {
  readonly messages: readonly AiMessage[];
  readonly tools: readonly AiTool[];
  readonly temperature?: number;
}

/** One assistant reply, with any tool calls the backend chose to issue. */
export interface AiTransportReply {
  readonly message: AiMessage;
  readonly toolCalls: readonly AiToolCall[];
}

/** The transport seam between the runtime and a backend. */
export interface AiTransport {
  /**
   * Produce one assistant reply for the request. When the backend chooses to
   * call tools, the reply carries `toolCalls` (which the runtime then resolves
   * and feeds back). When there are no tool calls, `message` is the final reply.
   */
  readonly complete: (request: AiTransportRequest) => Promise<AiTransportReply>;
  /**
   * Stream events for the request. A streaming backend emits text deltas and
   * tool calls incrementally; a backend without streaming may emit a single
   * `message` event then `done` (the runtime normalizes both).
   */
  readonly stream?: (request: AiTransportRequest) => AsyncIterable<AiStreamEvent>;
}

/** Stable failure codes carried by {@link AiError}. */
export type AiErrorCode =
  | 'invalid_messages'
  | 'invalid_tool'
  | 'invalid_tool_arguments'
  | 'invalid_tool_result'
  | 'unexpected_tool_calls'
  | 'unknown_tool'
  | 'loop_exceeded'
  | 'transport_failed';

/** Raised for every AI runtime failure. Messages never echo content, arguments, or backend replies. */
export class AiError extends JsailsError {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Validate the message array before it reaches a transport. */
export function assertValidMessages(messages: readonly AiMessage[]): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AiError('invalid_messages', 'messages must be a non-empty array');
  }
  for (const message of messages) {
    if (typeof message.role !== 'string' || typeof message.content !== 'string') {
      throw new AiError('invalid_messages', 'each message needs a role and string content');
    }
  }
}
